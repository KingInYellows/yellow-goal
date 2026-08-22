import { z } from 'zod';

/** MilestoneSpec — mirrors goal-gen/schemas/vendored/milestone.schema.json exactly. Exactly one
 *  MilestoneSpec exists per packet (goal-gen/schemas/README.md). */
export const MilestoneSpecSchemaVersion = 'yellow-goal/milestone/v1' as const;

const AcceptanceCriterionVerificationType = z.enum(['command', 'workflow', 'inspection', 'human']);

const AcceptanceCriterionVerificationSchema = z
  .object({
    type: AcceptanceCriterionVerificationType,
    commandRef: z.string().optional(),
    workflowRef: z.string().optional(),
    evidenceRequirement: z.string().optional(),
    environment: z.string().optional(),
  })
  .strict();

const AcceptanceCriterionSchema = z
  .object({
    id: z.string().regex(/^AC-[A-Za-z0-9._-]+$/),
    behavior: z.string().min(3),
    verification: AcceptanceCriterionVerificationSchema,
  })
  .strict();

export const MilestoneSpecSchema = z
  .object({
    schemaVersion: z.literal(MilestoneSpecSchemaVersion),
    goal: z.string().min(3),
    whyNow: z.string().min(3),
    scope: z.array(z.string()).min(1),
    nonGoals: z.array(z.string()).min(1),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
    terminalCondition: z.string().min(3),
    risks: z.array(z.string()).optional(),
    humanGates: z.array(z.string()),
  })
  .strict();

export type MilestoneSpec = z.infer<typeof MilestoneSpecSchema>;
