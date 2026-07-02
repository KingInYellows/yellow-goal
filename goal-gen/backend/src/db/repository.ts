/**
 * Typed insert/upsert functions per table (R1, R2, R5, R6, R35). This module never mints ids
 * itself — identity minting stays the caller's job (`planner/plan.ts` for `Plan.id`/`goalSpecId`,
 * `stepId()` below for `plan_steps`, the orchestrator/API layer for `runId`/`AgentRun.id`).
 *
 * `upsertPlan()` handles `Plan.id`'s content-addressing (`planner/plan.ts` `planId()`) via
 * `onConflictDoNothing()`: a replan that produces identical resulting content yields the same
 * `Plan.id`, and re-persisting it must be a true no-op, not a mutating `DO UPDATE` (which would
 * still write a dead tuple). `onConflictDoNothing()` + `.returning()` returns no row on the
 * conflict path (drizzle-orm#2474) — callers needing the canonical row regardless of insert
 * outcome should follow up with an explicit `SELECT`, not rely on `RETURNING` here.
 */
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { Plan } from '../planner/types';
import {
  agentRuns,
  goalSpecs,
  planSteps,
  plans,
  runEvents,
  runs,
  type NewAgentRunRow,
  type NewGoalSpecRow,
  type NewRunEventRow,
  type NewRunRow,
} from './schema';

/** Structural type covering both the pg (`node-postgres`) and PGlite-backed Drizzle instances. */
export type Database = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Deterministic `plan_steps.id` — `planId` + `sequenceIndex`, independent of `actionId` (R2). */
export function stepId(planId: string, sequenceIndex: number): string {
  return `${planId}:${sequenceIndex}`;
}

/** Idempotent: identical `GoalSpec` content ⇒ identical `id` (content-addressed) ⇒ true no-op. */
export async function upsertGoalSpec(db: Database, row: NewGoalSpecRow): Promise<void> {
  await db.insert(goalSpecs).values(row).onConflictDoNothing({ target: goalSpecs.id });
}

/**
 * Idempotent upsert of a `Plan` and its `plan_steps` (R2). A replan yielding an identical
 * `Plan.id` — and thus identical `plan.steps` content — re-persists as a true no-op on both
 * tables, never minting orphan `plan_steps` rows.
 */
export async function upsertPlan(db: Database, plan: Plan): Promise<void> {
  await db
    .insert(plans)
    .values({ id: plan.id, goalSpecId: plan.goalSpecId, replanOf: plan.replanOf ?? null })
    .onConflictDoNothing({ target: plans.id });
  if (plan.steps.length === 0) return;
  const rows = plan.steps.map((step, sequenceIndex) => ({
    id: stepId(plan.id, sequenceIndex),
    planId: plan.id,
    actionId: step.actionId,
    sequenceIndex,
    status: step.status,
  }));
  await db.insert(planSteps).values(rows).onConflictDoNothing({ target: planSteps.id });
}

/** `runId` is a fresh UUID minted per `run()` call (R3) — collision is not expected, but the
 *  insert is still idempotent for safety against a caller retrying the same `runId`. */
export async function insertRun(db: Database, row: NewRunRow): Promise<void> {
  await db.insert(runs).values(row).onConflictDoNothing({ target: runs.id });
}

/** `AgentRun.id` is unique per executor invocation; a plain insert is sufficient. */
export async function insertAgentRun(db: Database, row: NewAgentRunRow): Promise<void> {
  await db.insert(agentRuns).values(row);
}

/** `run_events.id` is a bigserial minted by Postgres itself (R5/R16); a plain insert is sufficient. */
export async function insertRunEvent(db: Database, row: NewRunEventRow): Promise<void> {
  await db.insert(runEvents).values(row);
}
