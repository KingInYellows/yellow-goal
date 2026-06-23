/**
 * Planner eval set — GATE: plan validity ≥ 98% (PRD §8, ADR-0012).
 *
 * Eval-driven: the per-fixture suite AUTO-SKIPS until `plan()` is implemented (M0).
 * The fixture-integrity checks below run NOW so the eval set is exercised immediately.
 */
import { describe, it, expect } from 'vitest';
import { loadFixtures, toGoalSpec } from './fixtures';
import { plan, isPlannerImplemented } from '../../../backend/src/planner/plan';
import { simulatePlan, checkOrder } from '../../../backend/src/planner/simulate';

const fixtures = loadFixtures();
const ready = isPlannerImplemented();

describe('eval fixtures load + are well-formed', () => {
  it('loads at least 50 unique cases', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(50);
  });
  it('includes unsatisfiable (no-plan) cases', () => {
    expect(fixtures.filter((f) => !f.expect.hasPlan).length).toBeGreaterThanOrEqual(5);
  });
  it('covers every composition tier', () => {
    const tiers = new Set(fixtures.map((f) => f.tier));
    for (const t of ['trivial', 'linear', 'branching', 'parallel', 'multi-effect', 'min-cost', 'unsatisfiable', 'stress']) {
      expect(tiers).toContain(t);
    }
  });
});

(ready ? describe : describe.skip)('planner eval set (GATE: plan validity ≥ 98%)', () => {
  for (const f of fixtures) {
    it(`${f.tier}/${f.id}`, () => {
      const goalSpec = toGoalSpec(f);
      const p = plan(goalSpec);
      if (!f.expect.hasPlan) {
        expect(p).toBeNull(); // unsatisfiable ⇒ clean no-plan, never an invalid plan
        return;
      }
      expect(p).not.toBeNull();
      const sim = simulatePlan(goalSpec, p!);
      expect(sim.valid).toBe(true);
      if (f.expect.costUpperBound !== undefined) {
        expect(sim.totalCost).toBeLessThanOrEqual(f.expect.costUpperBound);
      }
      if (f.expect.requiredOrder) {
        expect(checkOrder(p!, f.expect.requiredOrder)).toHaveLength(0);
      }
    });
  }
});

if (!ready) {
  describe.skip('planner eval set — pending plan() implementation (M0)', () => {
    it('enable by implementing backend/src/planner/plan.ts', () => {});
  });
}
