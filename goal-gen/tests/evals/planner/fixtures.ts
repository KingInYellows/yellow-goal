/**
 * Fixture schema + loader for the planner eval set (ADR-0013).
 *
 * Fixtures use a MINIMAL action shape (id/cost/preconditions/effects) because the planner
 * only reasons over those; `toGoalSpec()` hydrates executor/payload/verify/name defaults so
 * the result is a schema-valid GoalSpec. Each YAML file under fixtures/ is a list of cases.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { Action, GoalSpec } from '../../../backend/src/planner/types';

const primitive = z.union([z.boolean(), z.number(), z.string()]);
const stateSchema = z.record(primitive);
const orderPair = z.tuple([z.string(), z.string()]);

const fixtureActionSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  cost: z.number().positive(),
  preconditions: stateSchema.default({}),
  effects: stateSchema.default({}),
});

export const fixtureSchema = z.object({
  id: z.string(),
  tier: z.string(),
  goalText: z.string().default(''),
  initialState: stateSchema.default({}),
  goalState: stateSchema,
  constraints: z.array(z.string()).default([]),
  actions: z.array(fixtureActionSchema).default([]),
  expect: z.object({
    hasPlan: z.boolean(),
    costUpperBound: z.number().optional(),
    requiredOrder: z.array(orderPair).optional(),
  }),
});

export type Fixture = z.infer<typeof fixtureSchema>;

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Load + validate every case from fixtures/*.yaml. Throws with file/index context on error. */
export function loadFixtures(): Fixture[] {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const out: Fixture[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const raw = yaml.load(readFileSync(join(FIXTURES_DIR, file), 'utf8'));
    if (!Array.isArray(raw)) {
      throw new Error(`fixture file ${file} must be a YAML list of cases`);
    }
    raw.forEach((entry, i) => {
      const parsed = fixtureSchema.safeParse(entry);
      if (!parsed.success) {
        throw new Error(`invalid fixture in ${file}[${i}]: ${parsed.error.message}`);
      }
      const fx = parsed.data;
      if (seen.has(fx.id)) throw new Error(`duplicate fixture id "${fx.id}" (in ${file})`);
      seen.add(fx.id);

      // Referential integrity: requiredOrder must reference real actions.
      const ids = new Set(fx.actions.map((a) => a.id));
      for (const [a, b] of fx.expect.requiredOrder ?? []) {
        if (!ids.has(a) || !ids.has(b)) {
          throw new Error(`fixture "${fx.id}": requiredOrder references unknown action (${a} -> ${b})`);
        }
      }
      out.push(fx);
    });
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}

/** Hydrate a fixture into a schema-valid GoalSpec for the planner. */
export function toGoalSpec(fx: Fixture): GoalSpec {
  const actions: Action[] = fx.actions.map(
    (a): Action => ({
      id: a.id,
      name: a.name ?? a.id,
      cost: a.cost,
      preconditions: a.preconditions,
      effects: a.effects,
      executor: 'shell',
      payload: { command: 'true' },
      verify: { command: 'true' },
    }),
  );
  return {
    goalText: fx.goalText,
    initialState: fx.initialState,
    goalState: fx.goalState,
    constraints: fx.constraints,
    actions,
    completionPolicy: 'verify-only',
  };
}
