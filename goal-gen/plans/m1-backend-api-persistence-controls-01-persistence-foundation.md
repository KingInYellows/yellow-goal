# Feature: Persistence Foundation

## Overview

The backend has zero `dependencies` today (only devDependencies) and no `api/`,
`db/`, or `mcp/` directories — this is greenfield persistence work. Everything
downstream (event streaming, gate mechanics, the HTTP API) needs a stable
identity model first: `actionId` is proven non-unique within a plan (existing
tests dispatch the same `actionId` 2-3 times in one plan), so `stepId` must be
newly minted; `GET /plans/:id` returns multiple `runs` per plan, so a durable
`runId` must be minted and stamped everywhere; and the walking-skeleton's
`RunState.runId = run-${n}` per-instance counter collides if an `Orchestrator`
is ever reused within one process. This shell establishes that identity model
and the Postgres schema everything else builds on.

## Origin

- Spec: `plans/specs/m1-backend-api-persistence-controls.md`
- Covers: R1, R2, R3, R4, R5, R6, R35
- Shell: `m1-backend-api-persistence-controls-01-persistence-foundation`

## Pattern Survey

**Module layout is already decided, not inferred** — `goal-gen/CLAUDE.md` line 24
names `db/` explicitly as a sibling of `api/`/`planner/`/`executors/`, and line
42 licenses it for side effects ("Small, pure functions in the planner; side
effects only in executors/db"). Recommended concrete layout:

```
backend/src/db/
  schema.ts     # Drizzle pgTable defs; named const per table; row types via
                # $inferSelect/$inferInsert exported alongside — mirrors
                # extractors/schema.ts's file-level convention (JSDoc header,
                # named const exports, inferred types exported alongside),
                # translated from zod to Drizzle idiom. No db/types.ts —
                # the repo's convention is a shared types.ts is owned by
                # planner/ and backend/src/, not duplicated per-module.
  client.ts     # Drizzle db instance + pg Pool setup
  repository.ts # typed insert/upsert functions per table
  migrations/   # drizzle-kit generate output (kept in-module, matches the
                # self-contained-module convention in executors/, extractors/)
goal-gen/drizzle.config.ts   # root-level, matches vitest.config.ts placement;
                             # tsconfig.json's "*.config.ts" glob already covers it
goal-gen/tests/db/           # mirrors the confirmed tests/orchestrator/ pattern
```

No `index.ts` barrel anywhere in this repo (confirmed across `planner/`,
`extractors/`, `executors/`, `orchestrator/`) — import `db/schema.ts` and
`db/client.ts` directly, not through a barrel.

**Canonical source types** (schema must derive from these, not the stale
`docs/05-self-hosted-build-blueprint.md` blueprint):
- `backend/src/planner/types.ts`: `GoalSpec`, `Action`, `Plan`, `PlanStep`
  (`{ actionId, status, dependsOn }` — no `stepId` today), `WorldState`,
  `CompletionPolicy`, `ExecutorKind`.
- `backend/src/types.ts`: `AgentRun` (`{ id, planId, actionId, executor,
  startedAt, endedAt?, status, stdout?, stderr?, exitCode?, diffRef?, tokens?,
  costUsd? }` — no `stepId`, no `runId`, no `diffContent` today), `RunConfig`,
  `RunStatus` (`'succeeded' | 'failed' | 'cancelled' | 'budget-exhausted'` —
  do **not** touch this here; `awaiting-acceptance` is R29, covered by shell
  `m1-backend-api-persistence-controls-02-gate-control-mechanics`).

**`Plan.id` is content-addressed** (`backend/src/planner/plan.ts:153-166`,
`planId()` hashes `{goalSpecId, actionIds, sortedInitialState, replanOf}`) — a
replan that produces identical resulting content yields the *same* `Plan.id`.
`plans` table inserts must be upsert (`ON CONFLICT DO NOTHING`/`DO UPDATE`),
not a fresh-row-per-replan assumption.

**No existing pattern for injecting a fake/in-memory persistence layer** into
the test `Harness` (`tests/orchestrator/orchestrator.test.ts:32-67`) — this
shell introduces that seam, mirroring how `executor`/`verifier`/`confirm` are
already injected as swappable, stubbable dependencies.

## Implementation

- [x] Step 1: Add `drizzle-orm` and a Postgres driver (`pg`) as runtime
  `dependencies`, and `drizzle-kit` as a devDependency, in `package.json`. Add
  `db:generate` / `db:migrate` npm scripts (colon-namespaced, matching
  `test:watch` / `eval:planner`). Document in the changeset/PR that
  `drizzle-kit push` is never used in this repo (R35).
- [x] Step 2: Create `goal-gen/drizzle.config.ts` at the repo root pointing at
  `backend/src/db/schema.ts`, with migrations output to
  `backend/src/db/migrations/`.
- [x] Step 3: Uncomment and document the `DATABASE_URL` line already present
  (commented) in `goal-gen/.env.example`. Create `backend/src/db/client.ts`
  wiring a `pg.Pool` + Drizzle client from that env var.
- [x] Step 4: Create `backend/src/db/schema.ts` defining `pgTable` definitions
  for `goal_specs`, `plans`, `plan_steps`, `runs`, `agent_runs`, `run_events`
  (camelCase TS const → snake_case table name, e.g. `export const planSteps =
  pgTable('plan_steps', ...)`), derived from `planner/types.ts` and
  `backend/src/types.ts`. Export row types via `$inferSelect`/`$inferInsert`
  alongside each table, following `extractors/schema.ts`'s JSDoc-header +
  named-export convention. Reconcile field-level detail against the spec's
  own "Data Model" section (`plans/specs/m1-backend-api-persistence-controls.md`,
  the `## Design` → `### Data Model (Drizzle / Postgres)` subsection).

<!-- deepen-plan: external -->
> **Research:** Drizzle's convention is a dialect-specific `pgTable` builder
> from `drizzle-orm/pg-core`; every table must be **exported** for
> `drizzle-kit`'s static analysis to find it (unexported/malformed table
> defs can silently break `$inferInsert`, drizzle-orm#2636). `generate` →
> `migrate` (versioned, reviewable `.sql` files + a migrations-log table) is
> the production-safe pairing; `push` skips file generation and diffs
> straight against a live DB — fine for prototyping/test DBs, never
> production, consistent with this shell's R35 note in Step 1.
> See: https://orm.drizzle.team/docs/sql-schema-declaration, https://orm.drizzle.team/docs/goodies
<!-- /deepen-plan -->

- [x] Step 5: Create `backend/src/db/repository.ts` with typed insert/upsert
  functions per table — in particular an idempotent `upsertPlan()` that
  handles `Plan.id`'s content-addressing (Pattern Survey, above) via `ON
  CONFLICT DO NOTHING`.

<!-- deepen-plan: external -->
> **Research:** For a content-addressed primary key, `onConflictDoNothing()`
> — not `onConflictDoUpdate()` — is the correct idempotent-upsert primitive
> when an identical-content reinsert must be a true no-op: `DO UPDATE` still
> writes a dead tuple and can touch trigger-driven columns even when every
> value is unchanged. Caveat: `.returning()` combined with
> `onConflictDoNothing()` returns no row on the conflict path
> (drizzle-orm#2474) — if the canonical row is needed regardless of whether
> an insert occurred, follow with an explicit `SELECT` rather than relying
> on `RETURNING`.
> See: https://orm.drizzle.team/docs/insert, https://orm.drizzle.team/docs/guides/upsert
<!-- /deepen-plan -->
- [x] Step 6: Add `stepId` minting at plan-persistence time — extend the
  `AgentRun` interface in `backend/src/types.ts` with a `stepId: string`
  field, and mint one `plan_steps` row per `plan.steps[i]` (primary key
  `stepId`, independent of `actionId`) when a `Plan` is persisted via
  `repository.ts`.

<!-- deepen-plan: codebase -->
> **Codebase:** `stepId` minting here needs to be **deterministic** (e.g.
> derived from `planId` + `sequenceIndex`), not randomly generated — Step
> 5's idempotent `upsertPlan()` (`ON CONFLICT DO NOTHING`) means
> re-persisting an identical content-addressed `Plan.id` on a second run
> must not mint new orphan `plan_steps` rows. Also, a `Plan` is installed at
> multiple sites in `orchestrator.ts` (`obtainPlan`, `forcedReplan`,
> `replanLadder`, `reextract`) — all of them need this threaded through, not
> just a single initial-persistence hook. Correctly stamping `stepId` onto a
> dispatched `AgentRun` additionally needs positional information
> (`state.planCursor`) since `actionId` repeats within a plan.
<!-- /deepen-plan -->

- [x] Step 7: Add `runId` (UUID) minting for API-invoked runs — extend
  `OrchestratorDeps` (`backend/src/orchestrator/orchestrator.ts:55-65`) to
  accept an injectable `runId` (or a `runId` generator function), so the
  future API layer constructs one fresh `Orchestrator` per run and hands it a
  pre-minted UUID instead of the constructor minting its own. Replace the
  `runId: \`run-${++this.runCounter}\`` counter (around line 130/193) with
  the injected value, defaulting to a `crypto.randomUUID()`-generated one
  when not supplied (preserving current CLI/`runner.ts` behavior).

<!-- deepen-plan: codebase -->
> **Codebase:** `RunState`'s doc comment (`orchestrator.ts:68`) explicitly
> states "the orchestrator instance is reusable," and `runCounter` is
> designed to mint `run-1`, `run-2`, ... across successive `run()` calls on
> one instance. Minting `runId` as a constructor-time `OrchestratorDeps`
> field (as this step proposes) mints once per **instance**, not once per
> `run()` **call** — a second `run()` on the same instance would reuse the
> same `runId`, colliding on worktree branch names
> (`${state.runId}-${safeId}-${attempts}`). Prefer an injected generator
> function, or a parameter to `run()` itself, over a constructor-time value.
> Also: the actual current bug is that every *new* instance's `runCounter`
> starts at 0 (so two fresh instances both mint `run-1`), not "reuse within
> one process" as this shell's Overview states — worth correcting that
> framing. No existing test catches this: all 19 `Harness`/`build()` call
> sites in `orchestrator.test.ts` build a fresh instance per test.
<!-- /deepen-plan -->

- [x] Step 8: Capture diff/patch content before worktree teardown — add a new
  capture function (e.g. `backend/src/executors/diff-capture.ts`) that runs
  `git diff` (plus untracked files) against the worktree, called from inside
  `executeStep()`'s `try` block (`orchestrator.ts`, between the executor call
  around line 368 and the `finally` block at lines 398-404) — before
  `handle.cleanup()` destroys the git objects. Add a `diffContent?: string`
  field to `AgentRun` (`backend/src/types.ts`) alongside the existing
  `diffRef?: string` pointer, and persist it via `repository.ts`'s
  `agent_runs` insert.

<!-- deepen-plan: codebase -->
> **Codebase:** `activityOracle` (`claude-code-executor.ts:260-274`) already
> distinguishes a moved `HEAD` (`headMoved`, i.e. the agent ran `git
> commit`) from dirty working-tree changes (`diffRef: commit:${sha}` vs
> `dirty:${count}`). A bare working-tree `git diff` after a commit returns
> empty — the capture must diff against the worktree's stored baseline
> (`WorktreeHandle.initialSha`, `worktree.ts:69`), not just the working
> tree, and should reuse `worktree.ts`'s exported isolated `git()`/`GIT_ENV`
> rather than spawning a fresh raw process.
<!-- /deepen-plan -->

<!-- deepen-plan: external -->
> **Research:** For capturing tracked + untracked changes against a
> specific baseline SHA (not just working-tree HEAD), the non-destructive
> technique is `git ls-files --others --exclude-standard` (lists untracked
> files without touching the index) combined with `git archive <baseSha>`
> to a temp dir + `git diff --no-index <baseDir> <workDir>` (treats both
> sides as plain filesystem trees, so new files appear as ordinary
> additions). Avoid `git add -N .` unless a `git reset` is guaranteed
> afterward — it mutates the index. Use `execFile`/`spawn`, not `exec`, and
> treat exit code 1 from `git diff` as "differences found," not a failure.
> Run the capture *before* worktree deletion and persist the result
> durably.
> See: https://git-scm.com/docs/git-diff, https://git-scm.com/docs/git-add
<!-- /deepen-plan -->

- [x] Step 9: Extend the `Harness` interface and `build()` factory in
  `tests/orchestrator/orchestrator.test.ts` with an optional injectable
  persistence dependency (mirroring how `executor`/`verifier`/`confirm` are
  already stubbable), so existing orchestrator tests remain unaffected while
  new tests can assert on persisted rows.
- [x] Step 10: Write `tests/db/schema.test.ts` and `tests/db/repository.test.ts`
  covering: table creation, `upsertPlan()`'s idempotency on repeated
  content-addressed `Plan.id`s, `stepId` uniqueness across repeated
  `actionId`s in one plan, and `runId`/`diffContent` round-tripping through
  `agent_runs`. FK ordering: insert `goal_specs` → `plans` → `plan_steps`,
  and a `runs` row before `agent_runs`, to satisfy foreign keys.

<!-- deepen-plan: codebase -->
> **Codebase:** `vitest.config.ts`'s `include: ['tests/**/*.test.ts']` means
> any `.test.ts` file runs under plain `npm test`. This repo already
> established a precedent for excluding tests that need a live external
> resource: `tests/integration/runner.probe.ts` is named `.probe.ts`
> specifically so neither `npm test` nor `npm run eval` ever runs it and CI
> never spawns `claude` (confirmed via file header + commit `c319d02`,
> "excluded from CI"). `tests/db/*.test.ts` as named here, if it requires a
> live `DATABASE_URL` Postgres, would break `npm test`/CI, silently
> violating that established precedent.
<!-- /deepen-plan -->

<!-- deepen-plan: external -->
> **Research:** PGlite (`@electric-sql/pglite`, driver `drizzle-orm/pglite`)
> — Postgres compiled to WASM, no Docker daemon, runs in-process — is the
> recommended embedded DB for tests under the `tests/**/*.test.ts` glob; no
> CI exclusion is needed since nothing external is required. Reserve
> testcontainers/docker-compose for a separate, explicitly-excluded
> integration tier (mirroring the `.probe.ts` convention) that runs
> `drizzle-kit migrate` against real migration files. Note: PGlite's
> `pushSchema` API (for applying schema in tests) is flagged as
> under-documented even by Drizzle's own maintainers — verify its import
> path (e.g. `drizzle-orm/pglite/kit`) against the installed Drizzle
> version before relying on it.
> See: https://orm.drizzle.team/docs/connect-pglite, https://github.com/electric-sql/pglite
<!-- /deepen-plan -->

- [x] Step 11: Run `npx drizzle-kit generate` to produce the initial migration
  SQL in `backend/src/db/migrations/`, and verify `npm run typecheck` passes
  cleanly (strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` —
  match existing conventions like explicit non-null assertions and `import
  type` for type-only imports).

## Verification

- `npm run typecheck` -> no type errors.
- `npm test -- tests/db` -> new schema/repository tests pass.
- `npm test -- tests/orchestrator` -> existing orchestrator tests still pass
  unchanged (Harness extension is additive).
- `npx drizzle-kit generate` -> produces valid migration SQL without errors;
  apply against a local Postgres instance and confirm the resulting schema
  matches `schema.ts`.

<!-- deepen-plan: external -->
## References

- Drizzle ORM: SQL Schema Declaration — https://orm.drizzle.team/docs/sql-schema-declaration
- Drizzle ORM: Goodies (`$inferSelect`/`$inferInsert`) — https://orm.drizzle.team/docs/goodies
- Drizzle Kit: generate — https://orm.drizzle.team/docs/drizzle-kit-generate
- Drizzle Kit: migrate — https://orm.drizzle.team/docs/drizzle-kit-migrate
- Drizzle Kit: push — https://orm.drizzle.team/docs/drizzle-kit-push
- Drizzle ORM: Insert (`onConflictDoNothing`/`onConflictDoUpdate`) — https://orm.drizzle.team/docs/insert
- Drizzle ORM: Upsert guide — https://orm.drizzle.team/docs/guides/upsert
- drizzle-orm#2474 (`.returning()` + `onConflictDoNothing()` no-row gotcha) — https://github.com/drizzle-team/drizzle-orm/issues/2474
- drizzle-orm#2636 (`$inferInsert` empty-shape caveat on malformed exports) — https://github.com/drizzle-team/drizzle-orm/issues/2636
- Drizzle ORM: Connect PGlite — https://orm.drizzle.team/docs/connect-pglite
- PGlite project (WASM Postgres) — https://github.com/electric-sql/pglite
- Vitest: exclude config semantics — https://vitest.dev/config/exclude
- git-scm: git-diff (`--no-index`) — https://git-scm.com/docs/git-diff
- git-scm: git-add (`-N`/`--intent-to-add`) — https://git-scm.com/docs/git-add
<!-- /deepen-plan -->

## Context Files

- `backend/src/planner/types.ts` — canonical `GoalSpec`/`Plan`/`PlanStep`/`Action` shapes.
- `backend/src/planner/plan.ts:153-166` — `planId()`, the content-addressing
  logic `upsertPlan()` must handle.
- `backend/src/types.ts` — canonical `AgentRun`/`RunConfig`/`RunStatus`/`RunSummary`
  shapes; do not add `awaiting-acceptance` to `RunStatus` here (that's shell
  `m1-backend-api-persistence-controls-02-gate-control-mechanics`, R29).
- `backend/src/orchestrator/orchestrator.ts:55-65` (`OrchestratorDeps`),
  `:68-109` (`RunState`), `:130`/`:193` (the `runCounter` bug), `:359-404`
  (`executeStep()`'s try/finally where diff capture must be inserted).
- `backend/src/executors/worktree.ts:72` (`cleanup()` interface), `:85-94`
  (`teardown()` timing).
- `backend/src/executors/claude-code-executor.ts:250-274` (`activityOracle()`,
  current `diffRef` production — no existing diff-content capture).
- `tests/orchestrator/orchestrator.test.ts:32-67` (`Harness` interface and
  `build()` factory to extend).
- `backend/src/extractors/schema.ts` — file-level convention to mirror for
  `db/schema.ts` (JSDoc header, named const exports, inferred types exported
  alongside).
- `package.json` — zero runtime dependencies today; `drizzle-orm`/`drizzle-kit`/`pg`
  to be added.
- `.env.example` — commented-out `DATABASE_URL` line to uncomment/document.
- `plans/specs/m1-backend-api-persistence-controls.md` (`## Design` →
  `### Data Model`) — pre-worked schema detail to reconcile against.
