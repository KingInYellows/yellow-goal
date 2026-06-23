# Spec — Planner (deterministic GOAP A\*)

**Component:** `backend/src/planner/` · **Owns the canonical data model** used across the app.
**Depends on:** nothing (pure). **Consumed by:** orchestrator, api. **Principle:** deterministic; no LLM here.

## Purpose
Given a `GoalSpec` (a candidate action pool + initial/goal state), produce a valid, lowest-cost ordered `Plan` and dependency graph — or a clear "no plan" result. Re-plan from an updated state on demand.

## Canonical data model
```ts
type Primitive = boolean | number | string;
type WorldState = Record<string, Primitive>;

type ExecutorKind = 'claude-code' | 'codex' | 'antigravity' | 'mcp' | 'shell';

interface Action {
  id: string;
  name: string;
  cost: number;                      // > 0
  preconditions: Partial<WorldState>;
  effects: Partial<WorldState>;      // intended; real effect verified at runtime
  executor: ExecutorKind;
  payload: { prompt?: string; command?: string; mcpTool?: {name:string;args:unknown}; repoPath?: string; permissionMode?: string };
  verify: { command?: string; successPredicate?: Partial<WorldState> }; // REQUIRED
}

type CompletionPolicy = 'verify-only' | 'verify+signoff' | 'operator-defined';

interface GoalSpec {
  goalText: string;
  initialState: WorldState;
  goalState: Partial<WorldState>;    // definition of done
  constraints: string[];
  actions: Action[];                 // candidate pool (LLM-authored; append-only across re-extractions)
  completionPolicy: CompletionPolicy; // how "done" is judged; extractor recommends, operator confirms
}

interface PlanStep { actionId: string; status: 'pending'|'active'|'done'|'failed'|'skipped'; dependsOn: string[]; }
interface Plan { id: string; goalSpecId: string; steps: PlanStep[]; totalCost: number; createdFromState: WorldState; replanOf?: string; }
```

## Behavior
- **Search:** forward (progressive) A\* over `WorldState`. Node = `{state, actions[], g}`; edge = an action whose preconditions hold in `state`; successor applies `effects`.
- **g(n):** sum of action `cost`. **h(n):** count of unmet `goalState` predicates. **f = g + h.** Open list = priority queue by `f`; closed set keyed by a stable serialization of `state`.
- **Goal test:** all `goalState` predicates satisfied (`h === 0`).
- **Optimality:** the unmet-predicate heuristic is admissible iff each action satisfies ≤1 new goal predicate; document the chosen mode. Provide a `mode: 'astar' | 'bfs'` flag — BFS guarantees shortest when actions have multi-effects.
- **Dependency graph:** derive `dependsOn` from precondition/effect chains so the orchestrator can parallelize independent steps.
- **Replan:** `plan(currentState, goalSpec, {replanOf})` recomputes from the new state; returns a new `Plan` linked via `replanOf`. The planner only orders the pool it's given: when re-planning returns no plan, the **orchestrator** may re-invoke the extractor to *append* new actions (see `orchestrator.md`, `goal-extractor.md`) and call `plan` again over the expanded pool — the planner itself stays LLM-free.

## Error / edge cases
- Unsatisfiable goal → return `{ plan: null, reason }` (UI shows "no plan"); never throw.
- Cyclic precondition/effect definitions → detect and reject with a clear error.
- Action with empty/missing `verify` → reject at intake (invariant).
- Cap search: max nodes expanded / max plan length (configurable) to bound worst case.

## Acceptance criteria
- Deterministic: same input ⇒ identical plan.
- Unit-tested against the eval set (≥ 50 goal→expected-plan cases); meets PRD §8 plan-validity target.
- Produces correct ordering for the canonical chained example (analyze→change→test→PR) and for a branching/parallel example.
- Returns a clean no-plan result for an unsatisfiable goal.

## Out of scope
LLM calls, execution, persistence, UI. (This module is pure and synchronous.)
