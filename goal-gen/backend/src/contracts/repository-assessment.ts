import { z } from 'zod';

/** RepositoryAssessment — mirrors goal-gen/schemas/vendored/repository-assessment.schema.json. */
export const RepositoryAssessmentSchemaVersion = 'yellow-goal/repository-assessment/v1' as const;

const RepositoryAssessmentRatingValue = z.enum(['strong', 'adequate', 'fragile', 'weak', 'not-proven']);

const RepositoryAssessmentRatingSchema = z.object({
  area: z.string(),
  rating: RepositoryAssessmentRatingValue,
  evidenceRefs: z.array(z.string()).optional(),
  whatRaisesIt: z.string().optional(),
});

const RepositoryAssessmentExecutiveJudgmentSchema = z
  .object({
    usefulness: z.string(),
    functionality: z.string(),
    cohesion: z.string(),
    milestoneReadiness: z.string(),
  })
  .strict();

export const RepositoryAssessmentSchema = z
  .object({
    schemaVersion: z.literal(RepositoryAssessmentSchemaVersion),
    executiveJudgment: RepositoryAssessmentExecutiveJudgmentSchema,
    ratings: z.array(RepositoryAssessmentRatingSchema),
    findings: z.array(z.record(z.unknown())),
    evidenceGaps: z.array(z.string()),
    biggestConstraint: z.string().min(3),
  })
  .strict();

export type RepositoryAssessment = z.infer<typeof RepositoryAssessmentSchema>;
