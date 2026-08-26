# Spec: M1 Backend — API, Persistence & Controls

> **RECONSTRUCTED SPEC — 2026-08-26.** The original spec was authored before shells 01/02
> were expanded and implemented (PRs #11, #12) but was **never committed** — no version of
> `plans/specs/m1-backend-api-persistence-controls.md` exists anywhere in git history
> (verified via `git log --all -- 'goal-gen/plans/specs/*'`). This file is a best-effort
> reconstruction from the artifacts that survive: the two committed shells
> (`plans/m1-backend-api-persistence-controls-01-persistence-foundation.md`,
> `plans/m1-backend-api-persistence-controls-02-gate-control-mechanics.md`), R-id references
> in shipped code comments, `.claude/specs/api.md`, and `docs/prd.md` §6/§12.
> Recovered requirements cite their evidence. R-ids whose content could not be recovered are
> listed explicitly under "Unrecovered scope" — they must be re-derived, not guessed.

## Purpose

Bridge the walking-skeleton CLI loop (`plans/m1-walking-skeleton-cli-loop.md`, shipped) to
the PRD §6 v1 bar: durable persistence (Postgres/Drizzle), gate & control mechanics an HTTP
layer can drive (confirm/step gates, pause/resume, cancel, completion sign-off), an async
event pipeline, and the HTTP API + realtime stream (`.claude/specs/api.md`). The walking
skeleton proved the loop; this milestone makes it operable.

## Shell decomposition — status as of 2026-08-26

| Shell | Covers | Status |
|---|---|---|
| 01 persistence-foundation | R1–R6, R35 | Shipped — PR #11 (`2f37f3f`) |
| 02 gate-control-mechanics | R22–R27, R29–R31 | Shipped — PR #12 (`2d827a3`) |
| 03 async event pipeline *(name inferred from shell-02 references to "shell 03's async event-log writer")* | R19 + unknown | **Never written** |
| 04 HTTP API layer *(named directly by shell 02: "before any real HTTP server exists (that's shell 04)")* | unknown | **Never written** |

The original spec defined at least **R1–R35**. Shells 01/02 account for 16 of them; R19 and
R32 are partially recoverable from shell-02 prose; the remaining 17 are unrecovered (below).

## Recovered requirements

Grouped by shell coverage. Where a specific R-id ↔ requirement mapping is directly evidenced
(a code comment or shell text naming the R-id), the evidence is cited; otherwise the mapping
within a group is inferred from the shell's step list.

### Persistence foundation (R1–R6, R35 — shell 01, shipped in PR #11)

- Postgres schema via Drizzle for `goal_specs`, `plans`, `plan_steps`, `runs`, `agent_runs`,
  `run_events` (`backend/src/db/schema.ts`), derived from `planner/types.ts` and
  `backend/src/types.ts` — never from the stale blueprint doc.
- Idempotent `upsertPlan()` handling the content-addressed `Plan.id`
  (`backend/src/planner/plan.ts` `planId()`; `ON CONFLICT DO NOTHING`).
- Deterministic `stepId` minting per plan step at persistence time (`actionId` is proven
  non-unique within a plan).
- Injectable `runId` (UUID) for API-invoked runs, replacing the colliding per-instance
  `run-${n}` counter.
- **R5 — durable event-log write** (`run_events`). Evidence: `orchestrator.ts:83` comment
  "Durable event-log write (R5)".
- Diff/patch content captured before worktree teardown (`diffContent` on `agent_runs`,
  `backend/src/executors/diff-capture.ts`).
- **R35 — `drizzle-kit push` is never used in this repo** (generate → migrate only).
  Evidence: shell 01 Step 1.

### Gate & control mechanics (R22–R27, R29–R31 — shell 02, shipped in PR #12)

- **R22** — cancel rides the existing `AbortSignal`; the API layer owns and aborts the
  controller it constructed (no orchestrator-side change).
- **R23** — the single-slot pending gate lives OUTSIDE `Orchestrator`, in a per-run wrapper
  (`backend/src/orchestrator/run-session.ts` `RunSession`), not in a registry keyed by
  request id.
- **R24** — `DodConfirmer` gains a `kind: 'dod' | 'reconfirm'` parameter for
  observability/UI only, not endpoint routing.
- **R25** — every gate races its resolution against the `AbortSignal`; a gate promise is
  never left pending forever.
- **R26** — pause takes effect before the *next* step dispatch, never preempting an
  in-flight step.
- **R27** — pause/resume state is in-memory only on the session instance, never persisted.
- **R29** — `RunStatus` gains `'awaiting-acceptance'` (TS union `backend/src/types.ts:161` +
  DB enum + migration). Evidence: `orchestrator.ts:81` "Transition an existing run's status
  (R29/R30)".
- **R30** — the synchronous sign-off gate is REPLACED by the `AwaitingAcceptance` mechanism:
  a distinct `acceptanceGate` dep with decision shape `'accept' | 'reject'`, resolved by
  `POST /runs/:id/accept` (vs. `DodConfirmer`'s boolean / `POST /runs/:id/step`).
- **R31** — on entering the acceptance gate, `updateRunStatus('awaiting-acceptance')` and the
  `AwaitingAcceptance` event write are synchronous and awaited BEFORE the gate awaits — never
  via the async event drain. Evidence: `orchestrator.ts:324` comment naming R31; implemented
  at `orchestrator.ts:917-924` (`persistAwaitingAcceptance`).

### Partially recovered from shell-02 prose

- **R19** — an async `onEvent` queue / lazy event-log drain handling every event type *other*
  than the synchronous `AwaitingAcceptance` write. Evidence: shell 02 "shell 03's future
  async `onEvent` queue (R19) which handles every OTHER event type". Belongs to never-written
  shell 03. Only this one sentence of its definition survives.
- **R32** — the spec's explicit non-requirements clause. Evidence: shell 02 cites R32 twice —
  the in-memory-only pause latch is "a spec'd non-requirement (R32)", and crash-recovery of a
  pending gate is "explicitly out of scope per R32 (no crash-resume in this phase)". The full
  clause list is not recoverable.

## Unrecovered scope

**R7–R18, R20–R21, R28, R33–R34 (17 R-ids) have no surviving definition.** Given the
milestone name (API · persistence · controls) and the surviving design input
`.claude/specs/api.md`, they most plausibly covered: the REST endpoint surface, the
WebSocket/SSE stream (`StreamEvent` union, reconnect/replay from last event id), event
persistence semantics beyond R5/R19, the read models (`GET /plans/:id`, `GET /runs/:id`,
`GET /history`), single-admin session auth, and structured API errors. **That is inference,
not recovery.** Re-derive these against `.claude/specs/api.md` + PRD §6 before writing
shells 03+; do not implement from this paragraph.

## Design (recovered subsections)

The original spec had at least two design subsections, each cited by a shell:

### Data Model (Drizzle / Postgres)

Cited by shell 01 Step 4 ("reconcile field-level detail against the spec's own Data Model
section"). The shipped schema — `backend/src/db/schema.ts` plus migrations
`0000_medical_madripoor` and `0001_fixed_marvex` — is now the authoritative record of this
subsection's outcome.

### Gate Mechanics

Cited by shell 02 Context Files ("R22-R31, `## Design` → `### Gate Mechanics`"). The shipped
implementation — `backend/src/orchestrator/run-session.ts` and the gate paths at
`orchestrator.ts:319-328` / `:917-924` — is now the authoritative record.

## Forward guidance (2026-08-26)

Remaining scope (shells 03+) should be **re-decomposed, not resumed**. The harness
integration work (the yellow-harness coordination workspace's six-step order) makes a
canonical request-to-run pipeline and a single versioned event protocol
(`backend/src/contracts/run-event.ts`, `yellow-goal/run-event/v1` — currently emitted by
nothing) the next yellow-goal milestone, with an external *process* consumer
(yellow-plugins) rather than only the in-process frontend `.claude/specs/api.md` assumes.
Concretely:

- The event-shape unification (orchestrator's unversioned `insertRunEvent` rows + the
  runner's ad-hoc `{t, ev, ...}` stdout lines → `run-event/v1`, including minting the
  schema's required `sequence`) likely subsumes R19's queue design.
- The transport question (stdio/CLI `run` verb vs. HTTP server) now precedes the endpoint
  surface, so shell 04's HTTP-first assumption needs revisiting before the unrecovered
  R-ids are re-derived.
