/**
 * Property-based planner tests (fast-check) — regression across the search space, not
 * tied to specific golden plans. AUTO-SKIP until `plan()` is implemented (M0).
 *
 * The arbitrary builds a *constructively solvable* spec (a chain of N actions, each adding
 * one new fact), so a correct planner must always find a goal-reaching plan — and we can
 * derive an unsatisfiable variant by demanding a fact no action produces.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { plan, isPlannerImplemented } from '../../../backend/src/planner/plan';
import { simulatePlan } from '../../../backend/src/planner/simulate';
import type { Action, GoalSpec } from '../../../backend/src/planner/types';

const solvableSpec = fc.integer({ min: 1, max: 8 }).map((n): GoalSpec => {
  const actions: Action[] = [];
  for (let i = 0; i < n; i++) {
    actions.push({
      id: `a${i}`,
      name: `a${i}`,
      cost: 1,
      preconditions: i === 0 ? {} : { [`f${i - 1}`]: true },
      effects: { [`f${i}`]: true },
      executor: 'shell',
      payload: { command: 'true' },
      verify: { command: 'true' },
    });
  }
  return {
    goalText: 'chain',
    initialState: {},
    goalState: { [`f${n - 1}`]: true },
    constraints: [],
    actions,
    completionPolicy: 'verify-only',
  };
});

(isPlannerImplemented() ? describe : describe.skip)('planner properties', () => {
  it('determinism: same spec ⇒ identical plan', () => {
    fc.assert(
      fc.property(solvableSpec, (spec) => {
        expect(plan(spec)).toEqual(plan(spec));
      }),
    );
  });

  it('validity: a solvable spec yields a goal-reaching, precondition-respecting plan', () => {
    fc.assert(
      fc.property(solvableSpec, (spec) => {
        const p = plan(spec);
        expect(p).not.toBeNull();
        expect(simulatePlan(spec, p!).valid).toBe(true);
      }),
    );
  });

  it('no-plan: an unreachable goal predicate ⇒ null', () => {
    fc.assert(
      fc.property(solvableSpec, (spec) => {
        const unreachable: GoalSpec = { ...spec, goalState: { __never_produced__: true } };
        expect(plan(unreachable)).toBeNull();
      }),
    );
  });
});
