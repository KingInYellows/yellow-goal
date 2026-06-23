/**
 * Plan simulation oracle — the structural validator used by the planner eval set (ADR-0013).
 *
 * Why this exists: many goals have several equally-optimal plans, so exact-matching one
 * "golden" plan over-fits. Instead we assert *structural properties* by forward-executing
 * the plan against the GoalSpec's own effect model:
 *   - every action's preconditions hold at its step,
 *   - the goalState is reached,
 *   - cost is within a known bound, partial-order/dependency constraints hold, no cycles.
 *
 * This is the same idea as VAL (the classical-planning validator); reimplemented natively
 * rather than taking a PDDL/C++ dependency. It is pure and synchronous.
 */
import type { GoalSpec, Plan, WorldState } from './types';

export type SimFailureKind =
  | 'precondition'
  | 'goal'
  | 'unknown-action'
  | 'order'
  | 'cycle'
  | 'dependency'
  | 'cost';

export interface SimFailure {
  kind: SimFailureKind;
  stepIndex?: number;
  actionId?: string;
  detail: string;
}

export interface SimResult {
  valid: boolean; // every precondition held AND goalState reached
  reachedGoal: boolean;
  preconditionsOk: boolean;
  finalState: WorldState;
  totalCost: number;
  failures: SimFailure[];
}

/** True iff every predicate in `predicates` matches `state` exactly. */
export function satisfies(state: WorldState, predicates: Partial<WorldState>): boolean {
  return Object.entries(predicates).every(([k, v]) => state[k] === v);
}

/** Forward-execute a plan against a GoalSpec and report structural validity. */
export function simulatePlan(goalSpec: GoalSpec, plan: Plan): SimResult {
  const byId = new Map(goalSpec.actions.map((a) => [a.id, a]));
  const state: WorldState = { ...goalSpec.initialState };
  const failures: SimFailure[] = [];
  let totalCost = 0;
  let preconditionsOk = true;

  plan.steps.forEach((step, i) => {
    const action = byId.get(step.actionId);
    if (!action) {
      preconditionsOk = false;
      failures.push({
        kind: 'unknown-action',
        stepIndex: i,
        actionId: step.actionId,
        detail: `action "${step.actionId}" is not in the GoalSpec pool`,
      });
      return;
    }
    if (!satisfies(state, action.preconditions)) {
      preconditionsOk = false;
      failures.push({
        kind: 'precondition',
        stepIndex: i,
        actionId: action.id,
        detail: `unmet preconditions for "${action.id}"`,
      });
    }
    Object.assign(state, action.effects);
    totalCost += action.cost;
  });

  const reachedGoal = satisfies(state, goalSpec.goalState);
  if (!reachedGoal) {
    failures.push({ kind: 'goal', detail: 'goalState not satisfied after executing the plan' });
  }

  return {
    valid: preconditionsOk && reachedGoal,
    reachedGoal,
    preconditionsOk,
    finalState: state,
    totalCost,
    failures,
  };
}

/** Each [a, b] requires action `a` to appear strictly before action `b` in the plan. */
export function checkOrder(
  plan: Plan,
  requiredOrder: ReadonlyArray<readonly [string, string]>,
): SimFailure[] {
  const pos = new Map<string, number>();
  plan.steps.forEach((s, i) => {
    if (!pos.has(s.actionId)) pos.set(s.actionId, i);
  });
  const failures: SimFailure[] = [];
  for (const [a, b] of requiredOrder) {
    const pa = pos.get(a);
    const pb = pos.get(b);
    if (pa === undefined || pb === undefined || pa >= pb) {
      failures.push({ kind: 'order', detail: `expected "${a}" before "${b}"` });
    }
  }
  return failures;
}

/** Detect cycles in the plan's `dependsOn` graph. */
export function checkNoCycle(plan: Plan): SimFailure[] {
  const deps = new Map(plan.steps.map((s) => [s.actionId, s.dependsOn]));
  const mark = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const failures: SimFailure[] = [];

  const visit = (id: string): boolean => {
    if (mark.get(id) === 1) return true; // back-edge ⇒ cycle
    if (mark.get(id) === 2) return false;
    mark.set(id, 1);
    for (const d of deps.get(id) ?? []) {
      if (visit(d)) return true;
    }
    mark.set(id, 2);
    return false;
  };

  for (const id of deps.keys()) {
    if (visit(id)) {
      failures.push({ kind: 'cycle', actionId: id, detail: `dependency cycle involving "${id}"` });
      break;
    }
  }
  return failures;
}

/** Every `dependsOn` target must appear earlier in the step order. */
export function checkDependencyOrder(plan: Plan): SimFailure[] {
  const pos = new Map(plan.steps.map((s, i) => [s.actionId, i]));
  const failures: SimFailure[] = [];
  plan.steps.forEach((s, i) => {
    for (const d of s.dependsOn) {
      const pd = pos.get(d);
      if (pd === undefined || pd >= i) {
        failures.push({
          kind: 'dependency',
          stepIndex: i,
          actionId: s.actionId,
          detail: `dependency "${d}" must precede "${s.actionId}"`,
        });
      }
    }
  });
  return failures;
}

export interface PlanExpectations {
  costUpperBound?: number;
  requiredOrder?: ReadonlyArray<readonly [string, string]>;
}

export interface Score {
  pass: boolean;
  score: number; // 0..1, fraction of checks passed (for reporting)
  failures: SimFailure[];
}

/** Composite scorer used by the eval runner: validity + structure + (optional) expectations. */
export function scorePlan(goalSpec: GoalSpec, plan: Plan, expect: PlanExpectations = {}): Score {
  const sim = simulatePlan(goalSpec, plan);
  const cycleFails = checkNoCycle(plan);
  const depFails = checkDependencyOrder(plan);
  const orderFails = expect.requiredOrder ? checkOrder(plan, expect.requiredOrder) : [];
  const costOk = expect.costUpperBound === undefined || sim.totalCost <= expect.costUpperBound;

  const checks: boolean[] = [
    sim.preconditionsOk,
    sim.reachedGoal,
    cycleFails.length === 0,
    depFails.length === 0,
  ];
  if (expect.requiredOrder) checks.push(orderFails.length === 0);
  if (expect.costUpperBound !== undefined) checks.push(costOk);

  const failures = [...sim.failures, ...cycleFails, ...depFails, ...orderFails];
  if (!costOk) {
    failures.push({
      kind: 'cost',
      detail: `plan cost ${sim.totalCost} exceeds upper bound ${expect.costUpperBound}`,
    });
  }
  const passed = checks.filter(Boolean).length;
  return { pass: failures.length === 0, score: passed / checks.length, failures };
}
