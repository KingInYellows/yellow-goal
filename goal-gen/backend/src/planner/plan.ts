/**
 * Deterministic forward A* GOAP planner (ADR-0004, .claude/specs/planner.md).
 *
 * STUB — to be implemented in M0. The eval suites in tests/evals/planner/ define the
 * target behavior and AUTO-SKIP until this is implemented (see `isPlannerImplemented`).
 *
 * Implementation contract (planner.md):
 *   - deterministic: same input ⇒ identical plan;
 *   - forward A* over symbolic WorldState (g = Σcost, h = unmet goal predicates);
 *   - returns `null` (never throws) for an unsatisfiable goal;
 *   - bounds search by maxNodes / max plan length;
 *   - derives `dependsOn` from precondition/effect chains.
 */
import type { GoalSpec, Plan } from './types';

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export interface PlanOptions {
  mode?: 'astar' | 'bfs';
  replanOf?: string;
  maxNodes?: number;
}

export function plan(_goalSpec: GoalSpec, _opts: PlanOptions = {}): Plan | null {
  throw new NotImplementedError(
    'planner not implemented yet (M0) — see .claude/specs/planner.md and docs/decisions/0004-deterministic-planner.md',
  );
}

/** Eval-harness guard: true once `plan` no longer throws NotImplementedError. */
export function isPlannerImplemented(): boolean {
  try {
    plan({
      goalText: '',
      initialState: {},
      goalState: {},
      constraints: [],
      actions: [],
      completionPolicy: 'verify-only',
    });
    return true;
  } catch (err) {
    return !(err instanceof NotImplementedError);
  }
}
