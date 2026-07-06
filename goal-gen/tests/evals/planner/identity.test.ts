import { describe, expect, it } from 'vitest';
import { plan } from '../../../backend/src/planner/plan';
import type { Action, GoalSpec } from '../../../backend/src/planner/types';

function action(id: string, preconditions = {}, effects = {}): Action {
  return {
    id,
    name: id,
    cost: 1,
    preconditions,
    effects,
    executor: 'shell',
    payload: { command: 'true' },
    verify: { command: 'true' },
  };
}

const baseSpec: GoalSpec = {
  goalText: 'stable goal identity',
  initialState: {},
  goalState: { done: true },
  constraints: [],
  actions: [action('make-done', {}, { done: true })],
  completionPolicy: 'verify-only',
};

describe('planner identity invariants', () => {
  it('keeps goalSpecId stable across replans of the same goal content', () => {
    const a = plan(baseSpec);
    const b = plan(
      {
        ...baseSpec,
        initialState: { noise: 1 },
        actions: [action('make-done', {}, { done: true }), action('irrelevant', { noise: 1 }, { noise: 2 })],
      },
    );

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.goalSpecId).toBe(b!.goalSpecId);
  });

  it('keeps planId unique when replanOf differs', () => {
    const original = plan(baseSpec);
    const replanned = plan(baseSpec, { replanOf: original?.id });

    expect(original).not.toBeNull();
    expect(replanned).not.toBeNull();
    expect(replanned!.replanOf).toBe(original!.id);
    expect(replanned!.id).not.toBe(original!.id);
  });
});
