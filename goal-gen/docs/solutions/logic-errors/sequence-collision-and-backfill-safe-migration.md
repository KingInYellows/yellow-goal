---
title: 'A Constant sequence:0 Fallback Collided With a New Unique Index; the Migration That Added It Broke on Populated Tables'
date: 2026-08-26
category: logic-errors
track: bug
problem: 'Synthetic sequence:0 fallback for emitter-less run_events writes collided with a new unique(run_id, sequence) index on sign-off gate reopen, silently dropping the audit row'
tags: [migration, drizzle, postgres, unique-index, sequence, backfill, persistence, pglite, best-effort]
components: [backend/src/db/migrations/0002_numerous_skreet.sql, backend/src/orchestrator/orchestrator.ts]
source: 'review:sweep-all across PR #15-#19 (KingInYellows/yellow-goal), fix commit eacb70a'
---

# A Constant sequence:0 Fallback Collided With a New Unique Index; the Migration That Added It Broke on Populated Tables

## Problem

Two bugs shipped together because they share one feature: adding a
`sequence` column (and a `unique(run_id, sequence)` index) to
`run_events`.

1. **Runtime collision.** `persistAwaitingAcceptance` writes a
   `run_events` row for the "legacy" path — callers without a
   `RunEventEmitter` injected. That write hardcoded `sequence: 0`.
   Nothing about that constant is unsafe *until* the same run's sign-off
   gate can legitimately **reopen**: reject → remediate → re-satisfy →
   `AwaitingAcceptance` fires again for the same `runId`, with the same
   hardcoded `sequence: 0` — colliding with the just-added
   `unique(run_id, sequence)` index.
2. **Migration failure.** The drizzle-generated migration for that same
   column was `ALTER TABLE "run_events" ADD COLUMN "sequence" integer NOT
   NULL` with no default — which fails outright against any
   `run_events` table that already has rows, because Postgres can't
   backfill a NOT NULL column with no default on existing data.

## Symptoms

- The reopened-sign-off-gate scenario (already exercised by an existing
  test, R30) writes a second `AwaitingAcceptance` row with the same
  `sequence` as the first. The write goes through
  `persistBestEffort`, a wrapper designed to swallow persistence errors
  so a DB hiccup never fails the run — which meant the unique-constraint
  violation was swallowed too, and the second audit row was **silently
  lost** with no error surfaced anywhere.
- A throwaway in-memory fake used by most orchestrator tests does not
  enforce a unique-index constraint at all, so this collision was
  invisible to the test suite until a PGlite-backed test seeded real
  interleaved rows and hit the actual Postgres constraint.
- Running the migration against a dev database that already had
  `run_events` rows failed immediately with a NOT NULL violation on the
  `ALTER TABLE` statement — before any application code ran at all.

## What Didn't Work / Root Cause

The `sequence: 0` fallback was written when only one `AwaitingAcceptance`
write per run was possible. It became unsafe the moment gate-reopening
(reject → remediate → re-satisfy) was added as a legitimate flow — the
fallback's implicit assumption ("this write happens at most once per
run") silently broke without any code near it changing.

Fake in-memory test persistence is the second half of the root cause:
because the fake didn't model the unique index, tests stayed green
through the entire change that introduced the real collision. The bug
was only observable against a persistence layer that actually enforces
the constraint it claims to.

The migration failure is a separate, well-known Postgres constraint:
`ADD COLUMN ... NOT NULL` with no `DEFAULT` requires every existing row
to already have a value for that column, which is impossible for a
newly-added column — Postgres has no value to backfill with and refuses
the statement outright.

## Solution

**Runtime fix** — replace the constant with a per-run counter that only
activates on the fallback path (where no emitter already minted a
sequence):

```ts
// backend/src/orchestrator/orchestrator.ts — RunState
/** Per-run sequence source for durable event writes when no RunEventEmitter is injected —
 *  keeps repeat writes (e.g. a reopened sign-off gate) from colliding on unique(run_id, sequence). */
fallbackEventSequence: number;
```

```ts
const envelope = this.events?.next('AwaitingAcceptance', payload);
const sequence = envelope?.sequence ?? state.fallbackEventSequence++;
await this.persistBestEffort('awaitingAcceptance', async () => {
  await this.persistence.updateRunStatus(state.runId, 'awaiting-acceptance');
  await this.persistence.insertRunEvent({ runId: state.runId, planId: plan.id, type: 'AwaitingAcceptance', payload, sequence });
});
```

**Migration fix** — rewrite the drizzle-generated statement as a
nullable-add → backfill → tighten sequence, verified against seeded
interleaved rows via a throwaway PGlite script before landing:

```sql
-- backend/src/db/migrations/0002_numerous_skreet.sql
ALTER TABLE "run_events" ADD COLUMN "sequence" integer;--> statement-breakpoint
UPDATE "run_events" SET "sequence" = sub.rn - 1 FROM (
  SELECT "id", row_number() OVER (PARTITION BY "run_id" ORDER BY "id") AS rn FROM "run_events"
) sub WHERE "run_events"."id" = sub."id";--> statement-breakpoint
ALTER TABLE "run_events" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_id_sequence_idx" ON "run_events" USING btree ("run_id","sequence");
```

The backfill's `row_number() OVER (PARTITION BY run_id ORDER BY id)`
reconstructs a stable, gapless, per-run sequence from existing insertion
order (`id`) — the same ordering semantics the application would have
minted the values in originally. The final schema state (nullable → NOT
NULL, plus the unique index) is byte-identical to what the naive
one-line migration would have produced, so drizzle's schema-drift gate
still passes; only the *path* to get there changed.

A companion fix in `RunEventEmitter.next()` makes sink failures (a
broken stdout pipe, a future disconnected SSE client) non-fatal: the
mint still counts even if writing out fails, so sequences never
develop gaps, and the failure surfaces on stderr instead of throwing
through `Orchestrator.run()`'s never-throws contract.

## Why This Works

The fallback counter lives on `RunState`, so it is scoped per-run and
increments on every fallback-path write for that run — two writes for
the same run can never collide again, while runs that always have an
emitter (and thus always get `envelope.sequence` from `next()`) are
unaffected. The migration rewrite satisfies Postgres's actual
constraint (every row must have a value before `SET NOT NULL` runs) by
computing that value from data that already exists, rather than asking
Postgres to invent one.

## Prevention

- Treat any "this can only happen once per X" assumption as a
  liability the moment a retry/reopen/reject-and-resubmit flow is added
  near it — grep for hardcoded fallback constants (`0`, `null`,
  sentinel values) whenever a new uniqueness constraint is introduced
  on the same table/entity.
- In-memory test fakes for a persistence layer should enforce the same
  constraints (uniqueness, NOT NULL, foreign keys) the real database
  enforces, or tests will stay green through bugs the constraint exists
  specifically to catch. Prefer an embedded real engine (PGlite) over a
  fake for anything a schema constraint is meant to guard.
- `persistBestEffort`-style wrappers that swallow persistence errors to
  protect run availability are the right call for *transient* DB
  hiccups, but they also swallow constraint violations that indicate a
  real, reproducible application bug — consider surfacing (not just
  logging) constraint-violation-class errors distinctly from
  connectivity errors.
- Never let drizzle emit an `ADD COLUMN ... NOT NULL` with no default
  directly against a schema that might already have rows in any
  deployed environment; rewrite as nullable-add → backfill → tighten,
  and verify the rewritten migration's final state matches the
  original snapshot so the schema-drift gate still passes.
