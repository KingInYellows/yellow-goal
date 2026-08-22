import { z } from 'zod';

/**
 * GoalResolution — mirrors goal-gen/schemas/vendored/goal-resolution.schema.json, including the
 * documented `selectedMilestoneId` correction (schemas/README.md). MilestoneSpec itself carries
 * no self-id (exactly one milestone per packet), so this is a pipeline-assigned identifier, not a
 * cross-reference into milestone.schema.json.
 */
export const GoalResolutionSchemaVersion = 'yellow-goal/goal-resolution/v1' as const;

const GoalResolutionRelationship = z.enum(['exact', 'refined', 'prerequisite', 'blocked']);

export const GoalResolutionSchema = z
  .object({
    schemaVersion: z.literal(GoalResolutionSchemaVersion),
    requestedGoal: z.string().min(3),
    selectedGoal: z.string().min(3),
    selectedMilestoneId: z.string().min(1),
    relationship: GoalResolutionRelationship,
    rationale: z.string(),
    evidenceRefs: z.array(z.string()).min(1),
    preservedIntent: z.string().optional(),
    blockedBy: z.array(z.string()).optional(),
  })
  .strict();

export type GoalResolution = z.infer<typeof GoalResolutionSchema>;
