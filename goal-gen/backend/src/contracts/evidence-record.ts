import { z } from 'zod';

/**
 * EvidenceRecord — mirrors goal-gen/schemas/vendored/evidence-record.schema.json, including the
 * documented `targetSha` correction (schemas/README.md). Append-only in practice: nothing here
 * enforces immutability, since that is a store-layer concern for worker B, not a shape concern.
 */
export const EvidenceRecordSchemaVersion = 'yellow-goal/evidence/v1' as const;

const EvidenceRecordSourceType = z.enum([
  'repository-file',
  'git-metadata',
  'github-api',
  'ci-log',
  'external-primary',
  'external-secondary',
  'human-input',
]);

const EvidenceRecordSensitivity = z.enum([
  'public',
  'internal',
  'protected-metadata',
  'sensitive-content-excluded',
]);

export const EvidenceRecordSchema = z
  .object({
    schemaVersion: z.literal(EvidenceRecordSchemaVersion),
    id: z
      .string()
      .regex(/^ev-[A-Za-z0-9._-]+$/),
    sourceType: EvidenceRecordSourceType,
    repository: z.string().optional(),
    ref: z.string().optional(),
    targetSha: z.string().min(7).optional(),
    path: z.string().optional(),
    url: z.string().optional(),
    retrievedAt: z.string().datetime({ offset: true }),
    contentHash: z.string().min(16),
    sensitivity: EvidenceRecordSensitivity,
    facts: z.array(z.string()),
    excerpt: z.string().optional(),
    citationLabel: z.string().optional(),
  })
  .strict();

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
