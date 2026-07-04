# Feature: Gate & Control Mechanics

## Overview

The orchestrator's `confirm()` callback fires at four distinct points today
(initial DoD confirm, a **synchronous** sign-off gate, and two automatic
mid-run re-confirms), all routed through one undiscriminated `DodConfirmer`
signature — and pause/resume has no equivalent at all. This shell builds the
gate/control primitives the future HTTP layer will trigger (cancel is already
free per the existing `AbortSignal`), keeping them testable in isolation via
the existing `Harness` pattern before any real HTTP server exists (that's
shell 04). The single-slot pending-gate object explicitly lives OUTSIDE
`Orchestrator` (R23) in a new per-run wrapper, since the orchestrator instance
itself has no concept of "API caller resolves this later."

## Origin

- Spec: `plans/specs/m1-backend-api-persistence-controls.md`
- Covers: R22, R23, R24, R25, R26, R27, R29, R30, R31
- Shell: `m1-backend-api-persistence-controls-02-gate-control-mechanics`

## Pattern Survey

**Four `confirm()` call sites today** (`backend/src/orchestrator/orchestrator.ts`):
- `:248` — initial DoD confirm (`kind: 'dod'`).
- `:274` — the **existing synchronous** sign-off gate for `verify+signoff`/
  `operator-defined` completion policies. R30 requires REPLACING this
  call entirely with the new `AwaitingAcceptance` mechanism — not adding a
  `kind` to it, since its decision shape (`'accept' | 'reject'`) and endpoint
  (`POST /runs/:id/accept`) differ from the other three gates
  (`POST /runs/:id/step {decision: boolean}`).
- `:324` — re-confirm when a replan/forced-replan introduces a
  previously-unconfirmed action (`kind: 'reconfirm'`).
- `:641` — re-confirm for actions added by the re-extraction ladder
  (`kind: 'reconfirm'`).

**`DodConfirmer` today** (`orchestrator.ts:54`): `(dod: DodInfo, signal:
AbortSignal) => Promise<boolean>`. R24 adds a third parameter,
`kind: 'dod' | 'reconfirm'` — purely for observability (R24: "the `kind`
field exists for observability/UI purposes, not to route to a different
endpoint"), so both existing production callers of this type
(`stdinConfirm` at `:866`, `runner.ts:52`'s `autoConfirm` shortcut) need a
one-line signature update, not new logic.

**`stdinConfirm`** (`orchestrator.ts:866-889`) is the existing reference
implementation of the "race a promise against `AbortSignal`" pattern (R25):
a short-circuit on `signal.aborted` before creating the readline interface,
plus passing `{ signal }` into `rl.question` so an abort mid-prompt rejects
promptly. The new HTTP-resolved gates must follow the same shape: a promise
that resolves either from the HTTP decision or from the `AbortSignal` firing,
whichever comes first — never left pending forever.

<!-- deepen-plan: codebase -->
> **Codebase:** `stdinConfirm` does not literally use `Promise.race` — it
> delegates the abort-race to `readline`'s own `{ signal }` support. The new
> gates' explicit `Promise.race`/deferred-based construction (Step 4) is new
> plumbing, not a mirrored implementation of existing code — treat
> `stdinConfirm` as validating the *shape* of the pattern (short-circuit +
> signal-aware waiting), not as reusable logic.
<!-- /deepen-plan -->

<!-- deepen-plan: external -->
> **Research:** All three primitives below (pending gate, pause/resume latch,
> persist-before-await) reduce to the JS **deferred-promise** pattern
> (`p-defer` or the native ES2024 `Promise.withResolvers()`) composed with one
> reusable `raceWithAbort(promise, signal)` helper — register the `abort`
> listener with `{ once: true }` and remove it in a `finally` on both
> settlement paths, rejecting with `signal.reason ?? new DOMException('Aborted', 'AbortError')`.
> Write this helper once and share it across the pending-gate (Step 4), the
> pause/resume latch (Step 5), and the acceptance gate (Step 6) rather than
> re-deriving the race per call site. Avoid the `p-cancelable` promise-subclass
> shape (extending `Promise` with `.cancel()`) — it breaks `.then()` typing
> (tracked upstream as p-cancelable#20); prefer a plain object with
> `pause()`/`resume()`/`whenResumed()` control methods, which is already this
> plan's chosen shape.
<!-- /deepen-plan -->

**No existing "wrapper above `Orchestrator`" module.** `OrchestratorDeps`
(`:79-91`) is deliberately DI-shaped (`confirm`, `signal`, `persistence`, all
optional with production defaults) specifically so a caller outside the class
can supply HTTP-backed implementations — per the class's own header comment,
"entirely behind the spec interfaces so the later API layer wraps it." This
shell is the first thing to actually BE that wrapper, ahead of the real HTTP
layer (shell 04). Recommended name: `RunSession` — owns the single pending-gate
slot, the pause/resume latch, and constructs the `Orchestrator` instance with
`confirm`/`persistence` bound to that state. Lives in
`backend/src/orchestrator/run-session.ts`, a sibling of `orchestrator.ts` (not
under a not-yet-existing `api/` — CLAUDE.md's `api/` directory is shell 04's
to create).

**`RunStatus` today** (`backend/src/types.ts:160`): `'succeeded' | 'failed' |
'cancelled' | 'budget-exhausted'`, with a comment "`awaiting-acceptance` sign-off
is deferred past v1" that this shell removes (R29). The DB-level
`runStatusEnum` (`backend/src/db/schema.ts:19`) is a superset already primed
for this: `['running', 'succeeded', 'failed', 'cancelled', 'budget-exhausted']`
— this shell adds `'awaiting-acceptance'` to both the TS union and the DB enum
(a new Drizzle migration).

**`insertRunEvent()` already exists but is unwired** (`backend/src/db/repository.ts`,
flagged by the code-simplicity-reviewer on shell 01 as "spec-mandated forward
scope, not dead code"). Shell 02's Consumes section says it "consumes... the
`run_events` table the `AwaitingAcceptance` event write lands in" — this shell
is where that first wiring happens, via a direct synchronous call (R31), not
through shell 03's future async `onEvent` queue (R19) which handles every
OTHER event type. `PersistenceProvider` (`orchestrator.ts:65-69`) needs a new
method, `updateRunStatus(runId, status)`, since only `insertRun` (initial
creation) exists today — no existing "transition an existing run's status"
repository function.

## Implementation

- [x] Step 1: Add `'awaiting-acceptance'` to `RunStatus` in `backend/src/types.ts`
  (R29), removing the "deferred past v1" comment. Add the same member to
  `runStatusEnum` in `backend/src/db/schema.ts`, and generate the migration
  (`npx drizzle-kit generate`) — this is a Postgres `ALTER TYPE ... ADD VALUE`,
  additive and non-breaking.

- [x] Step 2: Add `updateRunStatus(db, runId, status)` to
  `backend/src/db/repository.ts`, a plain `UPDATE runs SET status = $1 WHERE
  id = $2`. Add the corresponding method to the `PersistenceProvider`
  interface in `orchestrator.ts` and to `noopPersistence`/the test
  `fakePersistence()` double in `tests/orchestrator/orchestrator.test.ts`.

<!-- deepen-plan: codebase -->
> **Codebase:** `PersistenceProvider` (`orchestrator.ts:65-69`) also needs
> `insertRunEvent` added here alongside `updateRunStatus` — Step 6 calls
> `persistence.insertRunEvent(...)` on this same interface, but today's
> interface only has `upsertPlan`/`insertRun`/`insertAgentRun`, and
> `repository.ts`'s existing `insertRunEvent()` function (unwired until this
> shell) is a free-standing export, not yet a `PersistenceProvider` method.
> Add both methods to the interface, `noopPersistence`, and
> `fakePersistence()` in this step, not just `updateRunStatus` — otherwise
> Step 6 has no typed seam to call through.
<!-- /deepen-plan -->

- [x] Step 3: Add the `kind: 'dod' | 'reconfirm'` third parameter to
  `DodConfirmer`'s type signature. Update `stdinConfirm` and `runner.ts`'s
  `autoConfirm` closure to accept (and ignore, or log for CLI observability)
  the new parameter. Update the three surviving `this.confirm(...)` call
  sites (`:248` dod, `:324` reconfirm, `:641` reconfirm) to pass the correct
  `kind` literal.

- [x] Step 4: Design and implement the single pending-gate slot type:
  `PendingGate = { runId: string; kind: 'dod' | 'reconfirm' | 'accept';
  dod: DodInfo; resolve: (decision) => void } | null`, one slot per
  `RunSession` instance (one `RunSession` per API-invoked run, so "per-run"
  and "per-instance" coincide — no cross-run keying needed, matching R23's
  "not a registry keyed by request ID"). Implement the abort-race (R25):
  whichever settles first between the HTTP-provided decision and
  `signal.aborted` wins, composed via the shared `raceWithAbort` helper.

<!-- deepen-plan: external -->
> **Research:** Make `resolve()`/`dispose()` on the gate idempotent —
> no-op (return `false`/`void`, don't throw) if the slot is already `null` —
> to survive a duplicate or late-arriving decision (directly relevant here:
> the two automatic mid-run re-confirms and the initial DoD confirm all
> route through the same gate mechanism, so a stale second resolution attempt
> is a realistic case, not a hypothetical one). Also tie the gate's disposal
> to the owning `RunSession`'s `AbortSignal` — register an abort listener
> that calls `dispose()` on the open gate — so a torn-down session never
> leaves a promise that nothing will ever settle.
<!-- /deepen-plan -->

- [x] Step 5: Implement the pause/resume latch as its own small class or
  closure — `{ pause(): void; resume(): void; whenResumed(): Promise<void> }`
  — re-armable (a second `pause()` after a `resume()` creates a fresh pending
  promise, not reusing a settled one). Compose it with the `AbortSignal` at
  the call site (`Promise.race([gate.whenResumed(), abortPromise])`), checked
  at the top of the orchestrator's main run-loop (`orchestrator.ts`'s `for
  (;;)` loop, alongside the existing `if (this.signal.aborted)` check at
  `:259`) — takes effect before the *next* step dispatch, never preempting an
  in-flight step (R26). Pause/resume state is in-memory only on the
  `RunSession`/`Orchestrator` instance, never persisted (R27) — document this
  explicitly as a comment near the class, since it's easy to mistake for an
  oversight rather than a spec'd non-requirement (R32).

- [x] Step 6: Implement the `AwaitingAcceptance` mechanism replacing the
  synchronous sign-off gate at `orchestrator.ts:274`. Add a new
  `OrchestratorDeps` field distinct from `confirm` — e.g. `acceptanceGate?:
  (dod: DodInfo, signal: AbortSignal) => Promise<'accept' | 'reject'>` — since
  its decision shape and resolving endpoint (`POST /runs/:id/accept`) differ
  from `DodConfirmer`'s boolean/`POST /runs/:id/step` shape. On entering the
  gate: **synchronously and awaited** (R31, not via the lazy `onEvent` drain
  R19 uses for other events, since shell 03's async event-log writer doesn't
  exist until the next shell) call `persistence.updateRunStatus(runId,
  'awaiting-acceptance')` and `persistence.insertRunEvent(...)` (a
  `type: 'AwaitingAcceptance'` row), THEN await the gate resolution. A
  default in-process implementation (mirroring `stdinConfirm`'s role as the
  CLI/test default) should exist so existing non-HTTP callers keep working
  unchanged.

<!-- deepen-plan: external -->
> **Research:** Node's run-to-completion semantics mean this ordering is
> already race-free against a concurrent same-process `GET /runs/:id` poll
> **as long as both persistence calls are `await`ed before opening the
> gate** — no other code (including an HTTP handler in the same process,
> per the in-process embedding architecture this whole spec assumes) can run
> between "status persisted" and "now awaiting the gate." The one way to
> silently break this guarantee is a fire-and-forget (`void
> persistence.updateRunStatus(...)`, not awaited) — treat "always await the
> persistence calls before opening the gate" as a hard invariant here, not a
> style preference. Crash-recovery (reconciling a `PendingGate` after a
> server restart) and idempotent/conditional writes for retried transitions
> are real concerns for a durable version of this pattern, but are explicitly
> out of scope per R32 (no crash-resume in this phase).
<!-- /deepen-plan -->

- [x] Step 7: Implement `RunSession` (`backend/src/orchestrator/run-session.ts`)
  wrapping one `Orchestrator` instance: owns the pending-gate slot (Step 4),
  the pause/resume latch (Step 5), and supplies `confirm`/`acceptanceGate`
  implementations bound to that slot. Exposes the resolution surface the
  future HTTP layer (shell 04) will call: `resolveGate(runId, decision)`,
  `pause()`, `resume()` — plus whatever cancel wiring is needed to expose the
  underlying `AbortController` (R22 needs no orchestrator-side change; the
  API layer calls `.abort()` directly on the controller it constructed, so
  `RunSession` should own/expose that controller too).

- [x] Step 8: Unit-test the gate mechanics with a NEW `buildSession()` test
  helper alongside the existing `build()` (`tests/orchestrator/orchestrator.test.ts`),
  using a stand-in resolver call (e.g. a test helper that calls
  `resolveGate()` after a short delay) in place of a real HTTP request. Cover:
  dod/reconfirm/accept gates resolving via the stand-in resolver; abort-race
  resolving a pending gate as declined when the signal fires first; pause
  taking effect before, not during, an in-flight step; resume unblocking a
  paused run; re-arming pause after a resume; the `AwaitingAcceptance`
  status/event write landing synchronously before the gate awaits (assert via
  `fakePersistence()`'s in-memory double, extended with the new
  `updateRunStatus`/`insertRunEvent` methods); the sign-off gate itself
  (`verify+signoff`/`operator-defined` completion policies) reaching
  `AwaitingAcceptance` and resolving both `'accept'` and `'reject'`.

<!-- deepen-plan: codebase -->
> **Codebase:** `build()` (`tests/orchestrator/orchestrator.test.ts`)
> constructs an `Orchestrator` directly with `confirm` already resolved to a
> fixed sync/boolean function — there is no seam in it for a gate resolved
> *later* by an external call, since `RunSession` sits above `Orchestrator`
> entirely. Step 8 needs a genuinely new `buildSession()` helper (constructing
> a `RunSession`, which in turn constructs its own `Orchestrator`), not an
> extension of `build()`'s existing option bag. Separately: the sign-off gate
> at `:274` (`verify+signoff`/`operator-defined` policies) has **zero
> existing test coverage** — grepping the 23-test file for
> `signoff`/`verify+signoff`/`operator-defined`/`accept` returns no hits — so
> the new `AwaitingAcceptance` tests here are that code path's first-ever
> coverage, not a regression-safety net for previously-tested behavior.
<!-- /deepen-plan -->

## Verification

- `npm run typecheck` -> no type errors.
- `npm test -- tests/orchestrator` -> existing 23 tests still pass unchanged,
  plus new gate-mechanics tests from Step 8.
- `npx drizzle-kit generate` -> produces the `awaiting-acceptance` enum-value
  migration; `npm test -- tests/db` still passes (schema tests unaffected by
  an additive enum value).

## References

<!-- deepen-plan: external -->
- `p-defer` (deferred-promise construction) — https://github.com/sindresorhus/p-defer
- `Promise.withResolvers()` (ES2024 native deferred) — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers
- `abort-controller-x` (`catchAbortError`, AbortSignal composition helpers) — https://github.com/deeplay-io/abort-controller-x
- p-cancelable typing issue (avoid promise-subclassing for cancelable gates) — https://github.com/sindresorhus/p-cancelable/issues/20
- `AbortSignal.any()` / `AbortSignal.timeout()` (composing multiple cancellation sources) — https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static
- XState persistence (`getPersistedSnapshot`, restoring from snapshot) — https://stately.ai/docs/persistence
- XState discussion #1265 (persisting on every transition via `onTransition`) — https://github.com/statelyai/xstate/discussions/1265
<!-- /deepen-plan -->

## Context Files

- `backend/src/orchestrator/orchestrator.ts:54` (`DodConfirmer`), `:65-91`
  (`PersistenceProvider`/`OrchestratorDeps`), `:248,274,324,641` (the four
  `confirm()` call sites), `:866-889` (`stdinConfirm`'s abort-race pattern to
  mirror).
- `backend/src/types.ts:160` (`RunStatus`).
- `backend/src/db/schema.ts:19` (`runStatusEnum`), `backend/src/db/repository.ts`
  (`insertRunEvent`, unwired until this shell).
- `backend/src/runner.ts:52` (`autoConfirm` CLI shortcut needing the `kind`
  param update).
- `tests/orchestrator/orchestrator.test.ts` (`Harness`, `fakePersistence()`).
- `plans/specs/m1-backend-api-persistence-controls.md` — R22-R31, `## Design`
  → `### Gate Mechanics`.
