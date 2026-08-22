import { z } from 'zod';

/** Finding — mirrors goal-gen/schemas/vendored/finding.schema.json exactly. All eight mission
 *  classifications already map 1:1 onto the vendored enum (schemas/README.md "No changes
 *  needed"); no `info` severity was added, per explicit instruction. */
export const FindingSchemaVersion = 'yellow-goal/finding/v1' as const;

const FindingSeverity = z.enum(['blocking', 'high', 'medium', 'low']);

const FindingClassification = z.enum([
  'verified_defect',
  'strongly_supported_risk',
  'documentation_contradiction',
  'missing_evidence',
  'intentional_limitation',
  'obsolete_finding',
  'duplicate_finding',
  'unknown',
]);

const FindingStatus = z.enum(['open', 'fixed', 'obsolete', 'accepted-risk', 'blocked']);

export const FindingSchema = z
  .object({
    schemaVersion: z.literal(FindingSchemaVersion),
    id: z.string().regex(/^F-[A-Za-z0-9._-]+$/),
    severity: FindingSeverity,
    classification: FindingClassification,
    title: z.string().min(3),
    evidenceRefs: z.array(z.string()).min(1),
    affectedFiles: z.array(z.string()).optional(),
    consequence: z.string(),
    requiredBehavior: z.string(),
    regressionRequirement: z.string().optional(),
    status: FindingStatus.optional(),
  })
  .strict();

export type Finding = z.infer<typeof FindingSchema>;
