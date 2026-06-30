# Feature: M1 Walking-Skeleton CLI Loop

## Overview

Build the first end-to-end slice of M1: a single CLI runner that wires the full
**extract → plan → confirm-DoD → execute → verify → replan** loop, `claude -p`
only, serial, stdout-only — no HTTP API, DB, or frontend. The deterministic
planner (M0) is reused as-is; the executor mechanics are already proven by the
de-risk spike. This slice surfaces the integration risk of the loop earliest and
yields a demoable system, while the three new modules (extractor, executor,
orchestrator) are written behind their existing spec interfaces so the later API
layer wraps them without a rewrite.

- **Invoke:** `npx tsx backend/src/runner.ts "<goal>"`
- **Source brainstorm:** `docs/brainstorms/2026-06-29-m1-walking-skeleton-cli-loop-brainstorm.md`
- **Decision constraints (operator):** walking skeleton first; pure Node CLI shell (no server/UI in this slice).

## Problem Statement

### Current pain points

M0 gives a deterministic planner but nothing executes a plan. There is no path
from a plain-English goal to real, ground-truth-verified changes. The M1
critical path (`docs/prd.md` §6/§12) is the single-executor core, and its
highest remaining risk is **integration** — wiring an unreliable LLM extractor,
a subprocess executor, and a replan loop together around the planner.

### User impact

The single operator wants to type a goal and watch the system extract an action
graph, plan it, get a definition-of-done confirmation, execute serially, verify
against ground truth, and replan on failure — observable on stdout, with no
infrastructure to stand up.

### Business value

Proves the M1 loop works end-to-end on real `claude -p` runs, freezing the
contracts (extractor/executor/orchestrator) that the M1-production API + live
view will build on. De-risks the wiring before any UI investment.

## Current State

- **Planner (M0, done):** `backend/src/planner/{plan,simulate,types}.ts`, green
  at `npm run eval:planner` (70/70). `plan(goalSpec, opts): Plan | null`.
  **Throws** on malformed actions (`cost <= 0`, empty `verify`, duplicate
  `action.id`); `null` means well-formed-but-unsatisfiable. `simulate.ts`
  exports `satisfies(state, goalState)` for the termination check.
- **Executor spike (done):** `tests/spikes/executor-spike.ts` +
  `executor-spike-findings.md` proved `claude -p` spawn, the JSON envelope shape,
  the worktree lifecycle, the ground-truth oracle, and the `tsx`-vs-strip-types
  decision.
- **Specs already define the interfaces** (do not reinvent):
  `.claude/specs/{goal-extractor,executor-router,orchestrator,planner}.md`.
- **Greenfield:** `backend/src/` contains only `planner/`. The extractor,
  executor, and orchestrator modules do not exist yet.
- **Tooling gap:** `package.json` has no `tsx` and no run script; `zod ^3.24.0`
  and `js-yaml` are present (devDeps). tsconfig is strict
  (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, ESM).

## Proposed Solution

### High-level architecture

```
runner.ts (thin CLI entry)
   │  parse argv → goalText
   ▼
LlmExtractor.extract(goalText) ──► GoalSpec (zod-validated, 1 repair round)
   │
   ▼
plan(goalSpec, {})  ──►  Plan | null        (deterministic; reused M0)
   │
   ▼
confirm-DoD gate (stdin y/n over goalState + per-action verify)
   │  y
   ▼
Orchestrator loop (serial):
   for each pending step:
     ClaudeCodeExecutor.run(action, ctx) ──► AgentRun  (claude -p in worktree)
     ground-truth oracle (porcelain/HEAD, noise-filtered) → diffRef + activity log
     run action.verify.command → exit code = pass/fail gate
     on pass:  update currentState (successPredicate ?? effects); continue
     on fail:  build FailureEvidence → replan ladder
   terminate when satisfies(currentState, goalSpec.goalState)
```

The three new modules sit behind their spec interfaces; `runner.ts` carries no
business logic. All side effects live in the executor/orchestrator; the planner
stays pure.

### Key design decisions (resolving the SpecFlow gaps)

1. **Two distinct oracles, never conflated.** The **activity oracle**
   (`git status --porcelain` non-empty *after noise-filtering* OR moved HEAD)
   only answers "did the agent change anything" → populates `AgentRun.diffRef`
   and an activity log line. The **verify oracle** (`action.verify.command` exit
   code) is the *only* thing that gates pass/fail and the replan trigger.
2. **WorldState update rule (the riskiest seam).** On a verify **pass**, the
   orchestrator updates `currentState` by applying
   `action.verify.successPredicate` if present; if absent (command-only verify),
   it falls back to applying `action.effects`. This stays anchored to ground
   truth because the update only happens *after* a real verify pass — never from
   a declared effect alone. On a verify **fail**, `currentState` is NOT updated.
3. **`plan()` throws → treat as malformed spec, not a crash.** The orchestrator
   wraps every `plan()` call in try/catch. A thrown error (bad cost / empty
   verify / duplicate id) is logged, consumes one re-extraction attempt, and
   feeds the validation error into `expand()` as evidence. `null` (unsatisfiable)
   takes the normal re-plan → re-extract ladder.
4. **Noise-filtered activity oracle.** Known side-effect paths (`ruvector.db`,
   `.claude/`, and a configurable list) are stripped from porcelain output
   before deciding "agent made a change," fixing the spike's documented
   false-positive (§7).
5. **`tsx` is the runner.** The spike falsified `node --experimental-strip-types`
   (rejects TS parameter properties at runtime; `tsc` won't catch it). Add `tsx`
   devDep + a `runner` script. `tsc --noEmit` stays the type-check gate.
6. **Minimal-but-present guardrails.** Enforce budget cap, replan cap,
   re-extraction cap, per-action retries, and a per-action timeout now. Defer
   60-min wall-clock and full loop-detection, but carry a
   `failures: Map<actionId, FailureRecord[]>` so loop-detection is an additive
   change later, not a rewrite.

## Implementation Plan

### Phase 1: Foundation — interfaces, config, skeleton, stubs

- [ ] 1.1: Add `tsx` to `devDependencies` and a `"runner": "tsx backend/src/runner.ts"` script in `package.json`. Verify `npx tsx backend/src/runner.ts` resolves.
- [ ] 1.2: Define shared interface types (per the specs) in `backend/src/types.ts` (or per-module): `Executor`, `RunContext {runId, worktreePath, signal, budgetUsdRemaining}`, `AgentRun`, `LlmExtractor {extract, expand}`, `FailureEvidence`, `FailureRecord`, `RunConfig`/guardrails. Reuse `planner/types.ts` for `GoalSpec`/`Action`/`WorldState`/`Plan`. Use `import type` (verbatimModuleSyntax).
- [ ] 1.3: Define guardrail config as named constants in `backend/src/orchestrator/guardrails.ts`: `MAX_BUDGET_USD=20`, `MAX_REPLANS=5`, `MAX_REEXTRACTIONS=2`, `MAX_RETRIES_PER_ACTION=3`, `MAX_SAME_SUBGOAL_FAILURES=2`, `ACTION_TIMEOUT_MS=600_000`. No magic numbers in the loop.
- [ ] 1.4: Implement `backend/src/runner.ts` skeleton: argv parse, structured stdout log (JSON-lines or pretty), `process.exitCode` + throw-based control flow (never `process.exit()` mid-run). Wire to **stub** extractor + executor so the loop shape runs end-to-end before real integration.
- [ ] 1.5: Implement `StubExecutor` (implements `Executor`) returning configurable `AgentRun` + verify outcomes, and `StubExtractor` returning fixture `GoalSpec`s — concrete deliverables here, used by the unit tests in Phase 5.

### Phase 2: Executor — `ClaudeCodeExecutor` + worktree + oracles

- [ ] 2.1: `backend/src/executors/worktree.ts` — `mkdtemp` scratch repo, isolated git env (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`), `git init` + empty commit, `git worktree add -b run-<id>`, capture `initialSha`; teardown in `finally` (each git call uses the non-throwing `git()` helper — non-zero is non-fatal — so teardown errors never mask setup errors; partial-creation failures are caught and call teardown with `.catch(() => {})` for the same reason) with `git worktree remove --force` then `prune` then `rm` scratch root; `git worktree prune` at startup as a crash backstop. **Note:** v1 uses a throwaway scratch repo to prove loop mechanics — pointing the worktree at the operator's configured target repo is deferred to a later milestone; the integration probe (task 5.3) likewise runs in a scratch repo by design. Promote verbatim from the spike.
- [ ] 2.2: `backend/src/executors/claude-code-executor.ts` — `spawn('claude', ['-p', prompt, '--output-format','json','--permission-mode','bypassPermissions','--model',MODEL,'--max-turns','10'], {cwd: worktreePath, stdio:['ignore','pipe','pipe'], env})`. Stream stdout/stderr into buffers (not `exec`/`maxBuffer`).
- [ ] 2.3: Envelope parsing: `JSON.parse(stdout)` → on `SyntaxError`, attempt last-`{…}`-block extraction → still failing = `RUN_FAIL`. Validate with the spike's `ResultEnvelope` zod schema (`.passthrough()`). Cost from `total_cost_usd ?? 0`.
- [ ] 2.4: Success classification: `exitCode === 0 && envelope.is_error === false && envelope.subtype === 'success'`. Map to `AgentRun.status`.
- [ ] 2.5: Cancellation: subscribe to `ctx.signal`; on abort send SIGTERM, then SIGKILL after a 5s grace; wait for the `close` event (not `exit`) before teardown. Per-action timeout via `ACTION_TIMEOUT_MS` (separate from wall-clock).
- [ ] 2.6: Activity oracle: `git status --porcelain` + `git rev-parse HEAD`, **filter known-noise paths** (`ruvector.db`, `.claude/`, configurable), then `changed = filteredPorcelain !== '' || headSha !== initialSha` → set `AgentRun.diffRef`. This does NOT gate pass/fail.

### Phase 3: Extractor — `LlmExtractor.extract()` + `expand()`

- [ ] 3.1: `backend/src/extractors/schema.ts` — zod schema derived from `planner/types.ts` for `GoalSpec`/`Action`, including the `verify` refinement (at least one of `command` non-empty OR `successPredicate` non-empty). Guard array access (`noUncheckedIndexedAccess`).
- [ ] 3.2: `backend/src/extractors/prompts.ts` — extraction prompt (lead "return ONLY valid JSON", inline TS-interface schema, one few-shot example, low temperature, "start with `{` end with `}`") and the `expand()` prompt (append-only, ids disjoint from `existingPool`, grounded in `FailureEvidence`).
- [ ] 3.3: `backend/src/extractors/llm-extractor.ts` — `extract(req)`: call the executor's `claude -p` path → pre-process result (strip ```json fences / BOM / trailing comma) → `safeParse` → on fail, one repair round (re-prompt with formatted zod issues) → `safeParse` → still failing = structured `ExtractionError` (never pass junk to `plan()`). Emit a measurement log line `{firstTry, repairNeeded, success}`.
- [ ] 3.4: `expand(goalText, currentState, failureEvidence, existingPool)`: same repair path; **dedup guard** — reject/namespace ids that collide with `existingPool` before returning, so `plan()` never throws on duplicates.

### Phase 4: Orchestrator loop

- [ ] 4.1: `backend/src/orchestrator/orchestrator.ts` — drive extract → `plan()` → confirm-DoD → execute → verify → replan. Carry mutable `currentState`, counters (`replans`, `reextractions`, `accumulatedCostUsd`), and `failures: Map<actionId, FailureRecord[]>`.
- [ ] 4.2: Confirm-DoD gate: print `goalText`, `goalState` predicates, `completionPolicy`, and each action's `{name, verify}` to stdout, then `y/n` over stdin. `n` → clean non-zero exit ("cancelled at DoD confirmation"); no replan/extraction. Treat `operator-defined` policy as `verify+signoff` in v1.
- [ ] 4.3: Execute step: budget check **before dispatch** (`accumulatedCostUsd >= MAX_BUDGET_USD` → `budget-exhausted` terminal), run executor, apply activity oracle, then run `verify.command` (exit code gates pass/fail). If `verify.command` is absent or empty, the action has no ground-truth gate and is treated as a verify-fail immediately (invariant #2 — we never pass on a declared effect alone); the extractor schema (step 3.1) requires at least one of `command` or `successPredicate`, but the orchestrator must handle command-absent actions without crashing. On pass → update `currentState` (`successPredicate ?? effects`); on fail within `MAX_RETRIES_PER_ACTION` → each retry gets a **fresh, clean worktree** (not a reset of the same tree) to avoid dirty-state accumulation; else record failure.
- [ ] 4.4: Replan ladder: on verify-fail (retries exhausted) build `FailureEvidence` and re-`plan()` over current pool. `plan()` returns plan → swap in (count a replan). `null` OR `MAX_SAME_SUBGOAL_FAILURES` reached → `expand()` (count a re-extraction) → re-`plan()`. **Wrap every `plan()` in try/catch**: a throw (malformed action: `cost ≤ 0` / empty `verify` / duplicate `id`) → log, consume a re-extraction with the validation error as evidence fed to `expand()`; note that the malformed action remains in the pool but is bounded by the re-extraction cap (the append-only constraint means we do not remove or mutate existing pool entries). Caps exhausted / still `null` → `failed` terminal.
- [ ] 4.5: Termination: after each verify pass, `satisfies(currentState, goalSpec.goalState)` → `succeeded`. Emit a final structured run summary (status, cost, replans, re-extractions, per-action outcomes). **Sign-off gap (real code gap in PR #8):** when `completionPolicy` is `verify+signoff` or `operator-defined`, specs and ADR-0008 require an awaiting-acceptance prompt after `goalState` is satisfied; the shipped orchestrator normalizes `operator-defined` → `verify+signoff` at the DoD gate but does not implement a post-execution sign-off prompt — it marks `succeeded` unconditionally. A second `stdinConfirm`-style prompt after termination is needed for `verify+signoff` goals; this is deferred but must be addressed before enabling operator-judged goals in production.

### Phase 5: Testing + end-to-end probe

- [ ] 5.1: Unit tests `tests/orchestrator/*.test.ts` (StubExecutor/StubExtractor, deterministic): budget accumulation + trip, replan/re-extraction counter caps, the WorldState update rule, the `plan()` throw-catch path, termination firing on the right iteration, `n` at the DoD gate.
- [ ] 5.2: Unit test `tests/extractor/repair.test.ts` — feed a known-malformed LLM response fixture through the repair round, assert it passes zod (no real LLM call). Asserts the load-bearing repair path is live.
- [ ] 5.3: Integration probe `tests/integration/runner.probe.ts` (non-`.test.ts`, excluded from the `vitest` glob, **not** in `npm test`/`eval`) — real `claude -p` against a trivial goal in a scratch repo; assert the loop completes, replans on an injected verify-fail, and self-terminates at the caps.
- [ ] 5.4: Run the probe once end-to-end; capture cost + outcome. `npm run typecheck` green; `npm test` green (unit only, no spend).

## Technical Specifications

### Files to create

- `backend/src/runner.ts` — thin CLI entry.
- `backend/src/types.ts` — `Executor`, `RunContext`, `AgentRun`, `LlmExtractor`, `FailureEvidence`, `FailureRecord`, `RunConfig`.
- `backend/src/executors/claude-code-executor.ts`, `backend/src/executors/worktree.ts`, `backend/src/executors/stub-executor.ts`.
- `backend/src/extractors/llm-extractor.ts`, `backend/src/extractors/schema.ts`, `backend/src/extractors/prompts.ts`, `backend/src/extractors/stub-extractor.ts`.
- `backend/src/orchestrator/orchestrator.ts`, `backend/src/orchestrator/guardrails.ts`.
- `tests/orchestrator/*.test.ts`, `tests/extractor/repair.test.ts`, `tests/integration/runner.probe.ts`.

### Files to modify

- `package.json` — add `tsx` devDep + `"runner"` script. (Keep `zod` resolvable for production code paths.)

### Key types (resolved from SpecFlow gaps)

```ts
interface FailureEvidence {
  actionId: string
  verifyCommand?: string
  verifyExitCode?: number
  verifyStdout?: string
  verifyStderr?: string
  agentStderr?: string
  diffRef?: string
}
interface FailureRecord { actionId: string; verifyExitCode: number; verifyStderr: string; at: string }
```

`Executor` / `RunContext` / `AgentRun` per `.claude/specs/executor-router.md`;
`LlmExtractor.extract` / `expand` per `.claude/specs/goal-extractor.md`.

### Dependencies

- `tsx@^4` (devDependency) — TS CLI execution (`tsc` stays the type-check gate).
- `zod@^3.24` (already present) — envelope + GoalSpec validation.

## Testing Strategy

- **Unit (in `npm test`, stubbed, deterministic, zero spend):** orchestrator
  loop logic, guardrail caps, WorldState update rule, `plan()` throw-catch, the
  zod-repair path. Requires the `StubExecutor`/`StubExtractor` from Phase 1.
- **Integration (manual, real `claude -p`, costs money):**
  `tests/integration/runner.probe.ts`, non-`.test.ts`, excluded from the vitest
  glob so CI never spawns `claude`. Covers extractor conformance, executor
  ground-truth oracle, worktree lifecycle.
- **End-to-end:** the full runner against a trivial real goal (the probe).

## Acceptance Criteria

1. `npx tsx backend/src/runner.ts "<trivial goal>"` runs the full loop and exits
   0 on a goal the executor can satisfy; final stdout summary reports status,
   cost, replans, re-extractions.
2. Ground truth is read via the noise-filtered porcelain/HEAD oracle; `git diff`
   is never used for change detection. Known side-effect files (`ruvector.db`,
   `.claude/`) do not register as agent activity.
3. Verify pass/fail is gated solely by `action.verify.command` exit code;
   `currentState` updates from `successPredicate ?? effects` on pass only.
4. A `plan()` throw is caught and routed to re-extraction (not a crash); `null`
   takes the replan→re-extract ladder; both terminate gracefully at caps.
5. Budget / replan / re-extraction / per-action-retry / per-action-timeout caps
   are enforced via named constants and each has a corresponding terminal state.
6. `expand()` output never collides ids with the existing pool (dedup guard).
7. The confirm-DoD gate prints the full DoD and a `y/n`; `n` exits non-zero
   cleanly with no execution.
8. `npm run typecheck` green; `npm test` green and spends $0 (no real `claude`).
9. The integration probe completes end-to-end against real `claude -p`,
   including an injected verify-fail → replan, within the budget cap.

## Edge Cases & Error Handling

- **Extractor:** empty/garbage goal → structured error, runner prints it and
  exits non-zero. JSON valid but semantically bad (cost 0 / missing verify) →
  caught at `plan()` throw → re-extract. Repair still fails → `ExtractionError`.
- **Executor:** non-zero exit / `is_error` / timeout → `AgentRun.status='failed'`,
  feeds verify-fail path. `SyntaxError` on envelope → `RUN_FAIL`. AbortSignal →
  SIGTERM→SIGKILL, worktree still torn down.
- **Orchestrator:** infinite-replan protection via `MAX_REPLANS` +
  `MAX_SAME_SUBGOAL_FAILURES`; budget checked before each dispatch; `failures`
  map retained for future loop-detection.
- **Worktree:** crash-safe teardown (`finally`, never `process.exit()` mid-run);
  `git worktree remove --force` before deleting the scratch root (never `rm -rf`
  first — documented data-loss hazard).

## Security Considerations

- Secrets via env only; subscription creds read from `~/.claude/.credentials.json`
  by `claude -p` (no `ANTHROPIC_API_KEY` in code/logs). Redact env from logs.
- Worktrees are **collision-avoidance, not a sandbox** (ADR-0009); the host is
  the blast radius in v1 (`--permission-mode bypassPermissions`). Per-run
  containers are M2.

## Deferred (explicitly out of this slice)

Persistence/resume, HTTP API + frontend/live-view, 60-min wall-clock guardrail,
full loop-detection, multi-executor routing, `--bare`/cost optimization,
pgvector memory (M3).

## References

- Brainstorm: `docs/brainstorms/2026-06-29-m1-walking-skeleton-cli-loop-brainstorm.md`
- Specs: `.claude/specs/{goal-extractor,executor-router,orchestrator,planner}.md`
- Spike: `tests/spikes/executor-spike.ts`, `tests/spikes/executor-spike-findings.md`
- Planner API: `backend/src/planner/{plan,simulate,types}.ts`
- ADRs: `docs/decisions/{0006-extraction-via-claude-p,0009-worktree-isolation,0010-*}.md`
- PRD: `docs/prd.md` §6/§12
- External: [Claude Code headless](https://code.claude.com/docs/en/headless) · [git-worktree](https://git-scm.com/docs/git-worktree) · [Node child_process](https://nodejs.org/api/child_process.html)

## Stack Decomposition

<!-- stack-topology: linear -->
<!-- stack-trunk: main -->

Unit tests are co-located with the code they cover (repair test in #3, orchestrator
tests in #4); only the real-`claude` integration probe stands alone as #5.

### 1. agent/feat/m1-runner-foundation
- **Type:** feat
- **Description:** Runner skeleton, shared interfaces, guardrail config, and test stubs
- **Scope:** package.json, backend/src/runner.ts, backend/src/types.ts, backend/src/orchestrator/guardrails.ts, backend/src/executors/stub-executor.ts, backend/src/extractors/stub-extractor.ts
- **Tasks:** 1.1, 1.2, 1.3, 1.4, 1.5
- **Depends on:** (none)

### 2. agent/feat/m1-claude-executor
- **Type:** feat
- **Description:** ClaudeCodeExecutor with worktree lifecycle and noise-filtered ground-truth oracle
- **Scope:** backend/src/executors/claude-code-executor.ts, backend/src/executors/worktree.ts
- **Tasks:** 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
- **Depends on:** #1

### 3. agent/feat/m1-llm-extractor
- **Type:** feat
- **Description:** LlmExtractor extract/expand with zod schema, prompts, and the load-bearing repair round (+ repair unit test)
- **Scope:** backend/src/extractors/llm-extractor.ts, backend/src/extractors/schema.ts, backend/src/extractors/prompts.ts, tests/extractor/repair.test.ts
- **Tasks:** 3.1, 3.2, 3.3, 3.4, 5.2
- **Depends on:** #2

### 4. agent/feat/m1-orchestrator-loop
- **Type:** feat
- **Description:** Orchestrator loop — confirm-DoD gate, execute→verify→replan ladder, WorldState update rule, plan() throw-catch — with stubbed unit tests; unstub the runner
- **Scope:** backend/src/orchestrator/orchestrator.ts, backend/src/runner.ts, tests/orchestrator/*.test.ts
- **Tasks:** 4.1, 4.2, 4.3, 4.4, 4.5, 5.1
- **Depends on:** #3

### 5. agent/test/m1-runner-e2e
- **Type:** test
- **Description:** Real-`claude` integration probe and end-to-end run (excluded from the CI vitest glob so it never spends)
- **Scope:** tests/integration/runner.probe.ts
- **Tasks:** 5.3, 5.4
- **Depends on:** #4
