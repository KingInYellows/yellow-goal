import { z } from 'zod';

/** ValidationResult — mirrors goal-gen/schemas/app/validation-result.schema.json. Net-new app
 *  contract: the packet-validation checklist (07_PACKET_CONTRACT.md "Required validation"). */
export const ValidationResultSchemaVersion = 'yellow-goal/validation-result/v1' as const;

const ValidationCheckStatus = z.enum(['passed', 'failed', 'skipped', 'unavailable', 'not-run']);

const ValidationCheckSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    status: ValidationCheckStatus,
    details: z.string().optional(),
  })
  .strict();

export const ValidationResultSchema = z
  .object({
    schemaVersion: z.literal(ValidationResultSchemaVersion),
    checks: z.array(ValidationCheckSchema),
    overall: z.enum(['passed', 'failed']),
  })
  .strict();

export type ValidationResult = z.infer<typeof ValidationResultSchema>;
