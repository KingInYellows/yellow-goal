import { z } from 'zod';

/** CommandRecord — mirrors goal-gen/schemas/app/command-record.schema.json. Net-new app contract.
 *  The model-suggested/never-executable invariant is not expressible in the structural JSON
 *  Schema, so it's enforced here via `.refine` (documented in the schema's `executable`
 *  description). */
export const CommandRecordSchemaVersion = 'yellow-goal/command-record/v1' as const;

const CommandRecordSource = z.enum([
  'manifest-script',
  'makefile',
  'ci-workflow',
  'repository-overlay',
  'human-approved',
  'model-suggested',
]);

const CommandRecordConfidence = z.enum(['verified', 'configured', 'suggested', 'unknown']);
const CommandRecordSideEffectClass = z.enum(['read-only', 'build', 'test', 'mutating', 'unknown']);

export const CommandRecordSchema = z
  .object({
    schemaVersion: z.literal(CommandRecordSchemaVersion),
    id: z.string().min(1),
    argv: z.array(z.string()).min(1),
    workingDir: z.string(),
    source: CommandRecordSource,
    evidenceRefs: z.array(z.string()),
    confidence: CommandRecordConfidence,
    sideEffectClass: CommandRecordSideEffectClass,
    executable: z.boolean(),
  })
  .strict()
  .refine((record) => record.source !== 'model-suggested' || record.executable === false, {
    message: 'model-suggested commands must never be executable',
    path: ['executable'],
  });

export type CommandRecord = z.infer<typeof CommandRecordSchema>;
