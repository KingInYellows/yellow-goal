/**
 * Unit tests for the plan-simulation oracle (simulate.ts).
 * These run GREEN now — they validate the eval oracle itself, independent of the
 * (not-yet-implemented) planner. If these pass, the harness can be trusted.
 */
import { describe, it, expect } from 'vitest';
import type { Action, GoalSpec, Plan, PlanStep } from '../../../backend/src/planner/types';
import {
  satisfies,
  simulatePlan,
  checkOrder,
  checkNoCycle,
  checkDependencyOrder,
  scorePlan,
} from '../../../backend/src/planner/simulate';

const act = (
  id: string,
  cost: number,
  preconditions: Record<string, boolean>,
  effects: Record<string, boolean>,
): Action => ({
  id,
  name: id,
  cost,
  preconditions,
  effects,
  executor: 'shell',
  payload: { command: 'true' },
  verify: { command: 'true' },
});

const step = (actionId: string, dependsOn: string[] = []): PlanStep => ({
  actionId,
  status: 'pending',
  dependsOn,
});

const planOf = (steps: PlanStep[]): Plan => ({
  id: 'p',
  goalSpecId: 'g',
  steps,
  totalCost: 0,
  createdFromState: {},
});

// analyze -> change -> test
const spec: GoalSpec = {
  goalText: 'demo',
  initialState: {},
  goalState: { tested: true },
  constraints: [],
  completionPolicy: 'verify-only',
  actions: [
    act('analyze', 1, {}, { analyzed: true }),
    act('change', 2, { analyzed: true }, { changed: true }),
    act('test', 1, { changed: true }, { tested: true }),
  ],
};

describe('satisfies', () => {
  it('matches exact predicates', () => {
    expect(satisfies({ a: true, b: 1 }, { a: true })).toBe(true);
    expect(satisfies({ a: false }, { a: true })).toBe(false);
    expect(satisfies({}, { a: true })).toBe(false);
  });
});

describe('simulatePlan', () => {
  it('accepts a valid ordered plan and sums cost', () => {
    const r = simulatePlan(spec, planOf([step('analyze'), step('change'), step('test')]));
    expect(r.valid).toBe(true);
    expect(r.reachedGoal).toBe(true);
    expect(r.totalCost).toBe(4);
    expect(r.failures).toHaveLength(0);
  });

  it('flags an unmet precondition (wrong order)', () => {
    const r = simulatePlan(spec, planOf([step('change'), step('analyze'), step('test')]));
    expect(r.preconditionsOk).toBe(false);
    expect(r.valid).toBe(false);
    expect(r.failures.some((f) => f.kind === 'precondition')).toBe(true);
  });

  it('flags a plan that does not reach the goal', () => {
    const r = simulatePlan(spec, planOf([step('analyze'), step('change')]));
    expect(r.reachedGoal).toBe(false);
    expect(r.failures.some((f) => f.kind === 'goal')).toBe(true);
  });

  it('flags an unknown action id', () => {
    const r = simulatePlan(spec, planOf([step('ghost')]));
    expect(r.failures.some((f) => f.kind === 'unknown-action')).toBe(true);
  });
});

describe('checkOrder', () => {
  it('passes when the partial order holds', () => {
    const p = planOf([step('analyze'), step('change'), step('test')]);
    expect(checkOrder(p, [['analyze', 'change'], ['change', 'test']])).toHaveLength(0);
  });
  it('fails when an ordering is violated', () => {
    const p = planOf([step('analyze'), step('test'), step('change')]);
    expect(checkOrder(p, [['change', 'test']]).length).toBeGreaterThan(0);
  });
});

describe('checkNoCycle / checkDependencyOrder', () => {
  it('detects a dependency cycle', () => {
    const p = planOf([step('a', ['b']), step('b', ['a'])]);
    expect(checkNoCycle(p).length).toBeGreaterThan(0);
  });
  it('accepts an acyclic graph', () => {
    const p = planOf([step('a'), step('b', ['a'])]);
    expect(checkNoCycle(p)).toHaveLength(0);
  });
  it('flags a dependency that does not precede its dependent', () => {
    const p = planOf([step('a', ['b']), step('b')]); // a depends on b but a is first
    expect(checkDependencyOrder(p).length).toBeGreaterThan(0);
  });
});

describe('scorePlan', () => {
  it('passes a valid plan within cost + order expectations', () => {
    const p = planOf([step('analyze'), step('change'), step('test')]);
    const s = scorePlan(spec, p, { costUpperBound: 4, requiredOrder: [['analyze', 'test']] });
    expect(s.pass).toBe(true);
    expect(s.score).toBe(1);
  });
  it('fails when cost exceeds the bound', () => {
    const p = planOf([step('analyze'), step('change'), step('test')]);
    const s = scorePlan(spec, p, { costUpperBound: 3 });
    expect(s.pass).toBe(false);
    expect(s.failures.some((f) => f.kind === 'cost')).toBe(true);
  });
});
