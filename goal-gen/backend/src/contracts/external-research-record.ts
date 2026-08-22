import { z } from 'zod';

/** ExternalResearchRecord — mirrors goal-gen/schemas/app/external-research-record.schema.json.
 *  Net-new app contract linking a bounded external-research question to the EvidenceRecord that
 *  captured it. */
export const ExternalResearchRecordSchemaVersion = 'yellow-goal/external-research-record/v1' as const;

const ExternalResearchRecordSourceKind = z.enum([
  'official-docs',
  'official-repo',
  'standard',
  'primary-research',
  'other',
]);

export const ExternalResearchRecordSchema = z
  .object({
    schemaVersion: z.literal(ExternalResearchRecordSchemaVersion),
    id: z.string().regex(/^ext-[A-Za-z0-9._-]+$/),
    question: z.string().min(3),
    sourceUrl: z.string().min(1),
    sourceKind: ExternalResearchRecordSourceKind,
    retrievedAt: z.string().datetime({ offset: true }),
    summary: z.string().min(1),
    evidenceId: z.string().regex(/^ev-[A-Za-z0-9._-]+$/),
  })
  .strict();

export type ExternalResearchRecord = z.infer<typeof ExternalResearchRecordSchema>;
