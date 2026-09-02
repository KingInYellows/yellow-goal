/**
 * Schema-level tests (embedded PGlite — no live `DATABASE_URL`, no CI exclusion needed): all 6
 * tables + enums are created via `drizzle-kit`'s `pushSchema`, and a full FK-respecting insert
 * chain round-trips (goal_specs -> plans -> plan_steps -> runs -> agent_runs -> run_events).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentRuns,
  goalSpecs,
  planSteps,
  plans,
  runEvents,
  runs,
} from '../../backend/src/db/schema';
import { createTestDb } from './pglite-setup';

let ctx: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  ctx = await createTestDb();
});

afterEach(async () => {
  await ctx.client.close();
});

describe('db/schema — table creation', () => {
  it('creates all 6 tables and accepts a full FK-respecting insert chain', async () => {
    const { db } = ctx;

    await db.insert(goalSpecs).values({
      id: 'goal_1',
      goalText: 'test goal',
      goalState: { done: true },
      completionPolicy: 'verify-only',
    });
    await db.insert(plans).values({ id: 'plan_1', goalSpecId: 'goal_1' });
    await db.insert(planSteps).values({
      id: 'plan_1:0',
      planId: 'plan_1',
      actionId: 'a1',
      sequenceIndex: 0,
      status: 'pending',
    });
    // FK ordering: a `runs` row must exist before `agent_runs` can reference it.
    await db.insert(runs).values({ id: 'run_1', planId: 'plan_1', status: 'running' });
    await db.insert(agentRuns).values({
      id: 'ar_1',
      runId: 'run_1',
      planId: 'plan_1',
      stepId: 'plan_1:0',
      actionId: 'a1',
      executor: 'claude-code',
      status: 'succeeded',
      startedAt: new Date().toISOString(),
    });
    await db.insert(runEvents).values({ runId: 'run_1', planId: 'plan_1', sequence: 0, type: 'test.event', payload: {} });

    expect(await db.select().from(goalSpecs)).toHaveLength(1);
    expect(await db.select().from(plans)).toHaveLength(1);
    expect(await db.select().from(planSteps)).toHaveLength(1);
    expect(await db.select().from(runs)).toHaveLength(1);
    expect(await db.select().from(agentRuns)).toHaveLength(1);
    expect(await db.select().from(runEvents)).toHaveLength(1);
  });

  it('rejects an agent_runs insert whose stepId has no matching plan_steps row (FK enforced)', async () => {
    const { db } = ctx;
    await db.insert(goalSpecs).values({
      id: 'goal_2',
      goalText: 'fk test',
      goalState: {},
      completionPolicy: 'verify-only',
    });
    await db.insert(plans).values({ id: 'plan_2', goalSpecId: 'goal_2' });
    await db.insert(runs).values({ id: 'run_2', planId: 'plan_2', status: 'running' });

    await expect(
      db.insert(agentRuns).values({
        id: 'ar_orphan',
        runId: 'run_2',
        planId: 'plan_2',
        stepId: 'plan_2:0', // never inserted into plan_steps
        actionId: 'a1',
        executor: 'claude-code',
        status: 'succeeded',
        startedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
  });
});
