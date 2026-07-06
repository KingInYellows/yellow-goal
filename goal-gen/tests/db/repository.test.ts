/**
 * Repository behavior tests (embedded PGlite — no live `DATABASE_URL`, no CI exclusion needed):
 * `upsertPlan()` idempotency on repeated content-addressed `Plan.id`, `stepId` uniqueness across
 * repeated `actionId`s within one plan, and `runId`/`diffContent` round-tripping through
 * `agent_runs`.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertAgentRun, insertRun, updateRunStatus, upsertGoalSpec, upsertPlan } from '../../backend/src/db/repository';
import { agentRuns, planSteps, plans, runs } from '../../backend/src/db/schema';
import type { Plan } from '../../backend/src/planner/types';
import { createTestDb } from './pglite-setup';

let ctx: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  ctx = await createTestDb();
  await upsertGoalSpec(ctx.db, {
    id: 'goal_1',
    goalText: 'repository test goal',
    goalState: { done: true },
    completionPolicy: 'verify-only',
  });
});

afterEach(async () => {
  await ctx.client.close();
});

/** `A` repeats — proves `plan_steps.id` must be independent of `actionId` (R2). */
const REPEATED_PLAN: Plan = {
  id: 'plan_repeat',
  goalSpecId: 'goal_1',
  totalCost: 3,
  createdFromState: {},
  steps: [
    { actionId: 'A', status: 'pending', dependsOn: [] },
    { actionId: 'B', status: 'pending', dependsOn: [] },
    { actionId: 'A', status: 'pending', dependsOn: [] },
  ],
};

describe('repository — upsertPlan idempotency (plan Step 5/6)', () => {
  it('re-persisting an identical content-addressed Plan.id is a true no-op (no duplicate plan or orphan plan_steps rows)', async () => {
    await upsertPlan(ctx.db, REPEATED_PLAN);
    await upsertPlan(ctx.db, REPEATED_PLAN); // same Plan.id, same content — repeat persist

    const planRows = await ctx.db.select().from(plans).where(eq(plans.id, REPEATED_PLAN.id));
    expect(planRows).toHaveLength(1);

    const stepRows = await ctx.db.select().from(planSteps).where(eq(planSteps.planId, REPEATED_PLAN.id));
    expect(stepRows).toHaveLength(3); // one per plan.steps[i]; the second upsertPlan() minted nothing new
  });

  it('mints a unique deterministic stepId per sequence index even when actionId repeats', async () => {
    await upsertPlan(ctx.db, REPEATED_PLAN);

    const stepRows = await ctx.db.select().from(planSteps).where(eq(planSteps.planId, REPEATED_PLAN.id));
    const ids = stepRows.map((r) => r.id);
    expect(new Set(ids).size).toBe(3); // unique per row despite actionId 'A' appearing at index 0 and 2
    expect(stepRows.filter((r) => r.actionId === 'A')).toHaveLength(2); // both A occurrences ARE persisted
    // Deterministic: re-deriving the same (planId, sequenceIndex) yields the same id both times.
    await upsertPlan(ctx.db, REPEATED_PLAN);
    const stepRowsAgain = await ctx.db.select().from(planSteps).where(eq(planSteps.planId, REPEATED_PLAN.id));
    expect(stepRowsAgain.map((r) => r.id).sort()).toEqual(ids.sort());
  });
});

describe('repository — runId / diffContent round-tripping (plan Step 7/8)', () => {
  it('round-trips runId and full diffContent through agent_runs', async () => {
    await upsertPlan(ctx.db, REPEATED_PLAN);
    await insertRun(ctx.db, { id: 'run_rt', planId: REPEATED_PLAN.id, status: 'running' });

    const diffContent = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n';
    await insertAgentRun(ctx.db, {
      id: 'ar_rt',
      runId: 'run_rt',
      planId: REPEATED_PLAN.id,
      stepId: 'plan_repeat:0',
      actionId: 'A',
      executor: 'claude-code',
      status: 'succeeded',
      startedAt: new Date().toISOString(),
      diffContent,
    });

    const rows = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, 'ar_rt'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBe('run_rt');
    expect(rows[0]?.diffContent).toBe(diffContent);

    const runRows = await ctx.db.select().from(runs).where(eq(runs.id, 'run_rt'));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.planId).toBe(REPEATED_PLAN.id);
  });

  it('updateRunStatus updates an existing run and throws when the run is missing', async () => {
    await upsertPlan(ctx.db, REPEATED_PLAN);
    await insertRun(ctx.db, { id: 'run_status', planId: REPEATED_PLAN.id, status: 'running' });

    await updateRunStatus(ctx.db, 'run_status', 'awaiting-acceptance');
    const rows = await ctx.db.select().from(runs).where(eq(runs.id, 'run_status'));
    expect(rows[0]?.status).toBe('awaiting-acceptance');

    await expect(updateRunStatus(ctx.db, 'missing_run', 'succeeded')).rejects.toThrow(/missing_run/);
  });
});
