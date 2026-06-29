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
- **g(n):** sum of action `cost`. **h(n):** in `astar` mode, the count of unmet `goalState` predicates **× the pool's minimum action cost** (the min-cost scaling keeps the heuristic admissible even for fractional costs); in `bfs` mode, `0`. **f = g + h.** Open list = priority queue by `f`; closed set keyed by a stable serialization of `state`.
- **Goal test:** all `goalState` predicates satisfied (`h === 0`).
- **Optimality:** the unmet-predicate heuristic is admissible iff each action satisfies ≤1 new goal predicate; document the chosen mode. Provide a `mode: 'astar' | 'bfs'` flag where `bfs` runs **uniform-cost search (h = 0)** — guaranteed least-cost even when actions carry multiple effects. **Default (`plan()` with no `mode`): auto-select** — use `bfs` when any action sets ≥2 goal predicates to their goal values (the inadmissibility condition), otherwise `astar` (h = unmet-predicate count × the pool's minimum action cost, which keeps it admissible even for fractional costs). Both return a minimum-cost plan and differ only in search efficiency; each heuristic is consistent under its selection condition, so the first goal node popped is optimal. (Implemented in `plan.ts`.)
- **Dependency graph:** derive `dependsOn` from precondition/effect chains so the orchestrator can parallelize independent steps. Each step depends on the **latest preceding step that establishes each of its preconditions** (a precondition met by the initial state adds no edge); all edges point strictly backward, so the graph is acyclic and consistent with the step order.
- **Replan:** `plan(goalSpec, { replanOf })` — with the current world state supplied as `goalSpec.initialState` — recomputes from the new state; returns a new `Plan` linked via `replanOf`. The planner only orders the pool it's given: when re-planning returns no plan, the **orchestrator** may re-invoke the extractor to *append* new actions (see `orchestrator.md`, `goal-extractor.md`) and call `plan` again over the expanded pool — the planner itself stays LLM-free.

## Error / edge cases
- Unsatisfiable goal (no producer, precondition deadlock, cyclic prerequisites, wrong value, partially-reachable goal…) → return `null` (UI shows "no plan"); never throw. Forward search just exhausts the open list, so cyclic prerequisites need no special-casing — they simply never reach the goal.
- Malformed action — empty/missing `verify`, `cost ≤ 0`, or a **duplicate id** in the pool — is rejected at intake with a clear *thrown* error (invariant). This is distinct from the `null` no-plan result, which is reserved for a well-formed but unsatisfiable goal.
- Cap search: `maxNodes` (configurable) bounds the worst case; exceeding it returns `null`.
- **Single-occurrence assumption:** the extractor authors *monotonic*-effect action graphs (a fact, once set, stays set), so an optimal plan never needs to *reuse* an action, and `PlanStep`/`dependsOn` identify steps by `actionId`. Non-monotonic/consumable effects — where an optimal plan legitimately repeats an action — would need per-occurrence step instance ids across `PlanStep` and the `simulate` oracle; that is a deliberate future data-model change behind its own ADR, not an M0 concern.

## Acceptance criteria
- Deterministic: same input ⇒ identical plan.
- Unit-tested against the eval set (≥ 50 goal→expected-plan cases); meets PRD §8 plan-validity target.
- Produces correct ordering for the canonical chained example (analyze→change→test→PR) and for a branching/parallel example.
- Returns a clean no-plan result for an unsatisfiable goal.

## Out of scope
LLM calls, execution, persistence, UI. (This module is pure and synchronous.)
