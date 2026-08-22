import { z } from 'zod';

/** RunEvent — mirrors goal-gen/schemas/vendored/run-event.schema.json, including its
 *  `additionalProperties: true` (payload shape varies by event `type`; not modeled per-type
 *  here). */
export const RunEventSchemaVersion = 'yellow-goal/run-event/v1' as const;

export const RunEventSchema = z
  .object({
    schemaVersion: z.literal(RunEventSchemaVersion),
    runId: z.string(),
    sequence: z.number().int().min(0),
    timestamp: z.string().datetime({ offset: true }),
    type: z.string(),
    payload: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type RunEvent = z.infer<typeof RunEventSchema>;
