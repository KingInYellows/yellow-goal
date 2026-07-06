/**
 * Drizzle Postgres schema (R1, R35) — derived from `planner/types.ts` and `backend/src/types.ts`,
 * reconciled against `plans/specs/m1-backend-api-persistence-controls.md`'s "Data Model" section
 * (NOT the stale `docs/05-self-hosted-build-blueprint.md`).
 *
 * `runs.status` is a DB-level superset of the TS `RunStatus` (adds `'running'` for an in-flight
 * run row) — it deliberately does NOT add `'awaiting-acceptance'` here; that's R29, covered by
 * shell `m1-backend-api-persistence-controls-02-gate-control-mechanics`.
 *
 * Migrations via `drizzle-kit generate` + `migrate` only (R35) — `drizzle-kit push` is never used
 * in this repo.
 */
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { bigserial, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { WorldState } from '../planner/types';

export const completionPolicyEnum = pgEnum('completion_policy', ['verify-only', 'verify+signoff', 'operator-defined']);
export const stepStatusEnum = pgEnum('step_status', ['pending', 'active', 'done', 'failed', 'skipped']);
export const runStatusEnum = pgEnum('run_status', ['running', 'succeeded', 'failed', 'cancelled', 'budget-exhausted']);
export const agentRunStatusEnum = pgEnum('agent_run_status', ['running', 'succeeded', 'failed', 'cancelled']);
export const executorKindEnum = pgEnum('executor_kind', ['claude-code', 'codex', 'antigravity', 'mcp', 'shell']);

/** `GoalSpec.id`, content-derived (`goal_${hash}`, `planner/plan.ts`). */
export const goalSpecs = pgTable('goal_specs', {
  id: text('id').primaryKey(),
  goalText: text('goal_text').notNull(),
  goalState: jsonb('goal_state').notNull().$type<Partial<WorldState>>(),
  completionPolicy: completionPolicyEnum('completion_policy').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

/**
 * `Plan.id` is content-addressed (`planner/plan.ts` `planId()`) — a replan that produces
 * identical resulting content yields the same id. `repository.ts`'s `upsertPlan()` handles this
 * via `onConflictDoNothing()`, not a fresh-row-per-replan assumption.
 */
export const plans = pgTable('plans', {
  id: text('id').primaryKey(),
  goalSpecId: text('goal_spec_id').notNull().references(() => goalSpecs.id),
  replanOf: text('replan_of').references((): AnyPgColumn => plans.id),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

/**
 * `id` is newly minted per R2 (independent of `actionId`, which is proven non-unique within one
 * plan). Deterministic — derived from `planId` + `sequenceIndex` — so re-persisting an identical
 * content-addressed `Plan.id` via `upsertPlan()`'s `ON CONFLICT DO NOTHING` is a true no-op
 * instead of minting orphan rows (see `repository.ts`).
 */
export const planSteps = pgTable('plan_steps', {
  id: text('id').primaryKey(),
  planId: text('plan_id').notNull().references(() => plans.id),
  actionId: text('action_id').notNull(),
  sequenceIndex: integer('sequence_index').notNull(),
  status: stepStatusEnum('status').notNull(),
});

/** `id` is a UUID minted per API-invoked run (R3), stamped onto every `agent_runs`/`run_events` row. */
export const runs = pgTable('runs', {
  id: text('id').primaryKey(),
  planId: text('plan_id').notNull().references(() => plans.id),
  status: runStatusEnum('status').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
  accumulatedCostUsd: numeric('accumulated_cost_usd', { precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
});

/**
 * Persisted `AgentRun` (`backend/src/types.ts`), extended with `stepId` (R2) and `diffContent`
 * (R6 — the actual patch text, captured before worktree teardown; distinct from the existing
 * `diffRef` pointer). `attempt` is forward-looking schema (per spec) for the retry count within
 * `executeStep()`; wiring the orchestrator to populate it is out of this shell's scope.
 */
export const agentRuns = pgTable('agent_runs', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  planId: text('plan_id').notNull().references(() => plans.id),
  stepId: text('step_id').notNull().references(() => planSteps.id),
  actionId: text('action_id').notNull(),
  attempt: integer('attempt'),
  executor: executorKindEnum('executor').notNull(),
  status: agentRunStatusEnum('status').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
  stdout: text('stdout'),
  stderr: text('stderr'),
  exitCode: integer('exit_code'),
  diffRef: text('diff_ref'),
  diffContent: text('diff_content'),
  tokens: integer('tokens'),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }),
});

/** Event log (R5); `id` doubles as the SSE event id (R16) since bigserial is strictly increasing. */
export const runEvents = pgTable('run_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  planId: text('plan_id').notNull().references(() => plans.id),
  stepId: text('step_id').references(() => planSteps.id),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export type GoalSpecRow = typeof goalSpecs.$inferSelect;
export type NewGoalSpecRow = typeof goalSpecs.$inferInsert;
export type PlanRow = typeof plans.$inferSelect;
export type NewPlanRow = typeof plans.$inferInsert;
export type PlanStepRow = typeof planSteps.$inferSelect;
export type NewPlanStepRow = typeof planSteps.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type NewAgentRunRow = typeof agentRuns.$inferInsert;
export type RunEventRow = typeof runEvents.$inferSelect;
export type NewRunEventRow = typeof runEvents.$inferInsert;
