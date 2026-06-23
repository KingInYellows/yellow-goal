# Spec — Orchestrator / Scheduler

**Component:** `backend/src/` (orchestration loop) · **Depends on:** planner, executor-router, extractor, db, realtime. **Consumed by:** api.
**Principle:** deterministic control flow. Replan and re-extraction *triggers* are deterministic (verify-fail / no-plan / N-failures); the only LLM use is the extractor *authoring* new actions during a bounded re-extraction.

## Purpose
Execute a `Plan`: walk the dependency graph, dispatch ready action nodes (in parallel up to a limit), collect **real** results, update world state, and trigger replanning on failure or state change — all within guardrails, emitting events for the dashboard.

## Inputs / outputs
- In: a `Plan` + its `GoalSpec`, a run `mode` (`auto` | `step`), and a `RunConfig` (concurrency, budget caps).
- Out: a stream of events (see `api.md`) + persisted `AgentRun` records; a terminal run status `succeeded | failed | cancelled | budget-exhausted`, plus a non-terminal `awaiting-acceptance` when `completionPolicy` requires operator sign-off.

## Behavior
1. Compute the ready set (steps whose `dependsOn` are all `done`). Dispatch via the **executor-router**; each runs in its own git worktree. *v1: serial (`maxConcurrency` = 1); M2 dispatches up to `maxConcurrency` in parallel.*
2. On each `AgentRun` completion: run the action's `verify`; set `WorldState` from the **real** result (exit code / test output / diff), not the declared effect.
3. If verify passes → mark step `done`, recompute ready set. If it fails → mark `failed` and consult the **replan policy**.
4. **Replan policy:** if `enableReplanning`, a trigger matches (action failure / state drift), and caps allow → call `planner.plan(currentState, goalSpec, {replanOf})`. If it returns a plan → swap it in, emit `Replanned`. If it returns **no plan** (or the same subgoal has failed ≥ N times) → call `extractor.expand(goalText, currentState, failureEvidence, existingPool)` to **append** new actions (within the re-extraction cap), then plan again; emit `Replanned{reextracted:true}`. If still no plan or caps are exhausted → fail the run (or escalate).
5. **In `step` mode:** pause for operator approval between steps.
6. Terminate when a guardrail trips, no plan remains, or `goalState` is satisfied. On `goalState` satisfaction: if `completionPolicy` is `verify-only`, mark `succeeded`; if it requires sign-off (`verify+signoff` / `operator-defined`), enter **`awaiting-acceptance`** for operator sign-off — accept → `succeeded`, reject → continue/replan.

## Guardrails (mandatory)
- `maxReplans`, `maxReextractions`, `maxBudgetUsd`, `maxWallClock`, `maxRetriesPerAction`, `maxConcurrency`.
- **Defaults (v1, overridable per-run):** $20 budget · 5 replans · ≤ 2 re-extractions · 60-min wall-clock · 3 retries/action · concurrency 1.
- **Loop detection:** the same action failing the same way twice → stop and escalate to operator.
- **On a cap trip:** stop dispatching new work, mark the run paused/blocked, and surface to the operator to raise the cap, resume, or cancel (budget exhaustion → `budget-exhausted`).
- All caps enforced centrally; a forced-loop test must terminate (PRD §8 no-runaway).

## Operator controls
Confirm the definition of done (goalState + verify + `completionPolicy`) before run; approve plan; pause/resume; **kill** a run (propagate SIGTERM to the subprocess and mark `cancelled`); sign off on completion when `completionPolicy` requires it. **Reassign** a step's executor is **M2** (needs multi-executor).

## Error / edge cases
- Executor crash/timeout → treated as action failure → retry (within cap) → replan/escalate.
- Worktree conflict → never allow two writers on the same paths; serialize or branch.
- Partial parallel failure *(M2)* → other branches continue; failed branch triggers replan scoped to its subgoal.
- DB/realtime outage → keep executing; buffer events; reconcile on reconnect.
- **Verifier integrity (M2):** an agent can pass a check by editing/deleting its own `verify`/test (reward hacking). M2 hashes verify/test files before+after each action and fails on change (verify-integrity gate) + read-only test mounts (ADR-0014). v1 relies on operator-reviewed verify + worktrees.

## Acceptance criteria
- Respects dependencies; v1 runs serially in a per-run worktree (≥ 1 parallel branch is an M2 criterion).
- A forced failing action produces a visible, real replan; a failure the existing pool can't resolve produces a visible **re-extraction** that adds the needed action; recovery is reported per PRD §8.
- When `completionPolicy` requires sign-off, the run waits in `awaiting-acceptance` until the operator accepts.
- Kill actually terminates the subprocess; pause works mid-run.
- No run exceeds guardrail caps in stress tests.

## Out of scope
Plan generation (planner), CLI specifics (executor-router), rendering (frontend).
