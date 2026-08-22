import { z } from 'zod';

/** OrchestrationSpec — mirrors goal-gen/schemas/vendored/orchestration.schema.json, including the
 *  documented typed-`waves[]` completion and the profileId/teamMode/fallbackMode/
 *  mutationBoundaries/validationOwnership/lead completion (schemas/README.md). This is the
 *  execution contract (teams/waves), distinct from OrchestrationProfile (versioned model-role
 *  resolution) — see contracts/orchestration-profile.ts. */
export const OrchestrationSpecSchemaVersion = 'yellow-goal/orchestration/v1' as const;

const OrchestrationTeamMode = z.enum(['agent-team-preferred']);
const OrchestrationFallbackMode = z.enum(['subagents']);

const OrchestrationWaveName = z.enum(['investigation', 'implementation', 'verification']);

const OrchestrationTeammateSchema = z
  .object({
    role: z.string(),
    modelRole: z.string(),
    modelId: z.string(),
    ownership: z.array(z.string()),
  })
  .strict();

const OrchestrationWaveSchema = z
  .object({
    name: OrchestrationWaveName,
    maxActive: z.number().int().min(1).max(3),
    readOnly: z.boolean(),
    requiresPlanApproval: z.boolean(),
    freshContext: z.boolean(),
    teammates: z.array(OrchestrationTeammateSchema),
  })
  .strict();

const OrchestrationLeadSchema = z.object({
  role: z.string(),
  modelRole: z.string(),
  modelId: z.string(),
  responsibilities: z.array(z.string()).min(1),
});

export const OrchestrationSpecSchema = z
  .object({
    schemaVersion: z.literal(OrchestrationSpecSchemaVersion),
    profileId: z.string().min(1),
    provider: z.string().min(1),
    lead: OrchestrationLeadSchema,
    teamMode: OrchestrationTeamMode,
    fallbackMode: OrchestrationFallbackMode,
    waves: z.array(OrchestrationWaveSchema).min(1),
    maxConcurrentWorkers: z.number().int().min(1).max(8),
    exclusiveFileOwnership: z.boolean().optional(),
    requirePlanApproval: z.boolean().optional(),
    mutationBoundaries: z.array(z.string()).min(1),
    validationOwnership: z.string().min(1),
    stopConditions: z.array(z.string()).min(1),
    humanApproval: z.array(z.string()),
  })
  .strict()
  .refine(
    (spec) => spec.lead.responsibilities.some((r) => /sole integrator|final decision/i.test(r)),
    {
      message: 'lead.responsibilities must include sole-integrator/final-decision-maker semantics',
      path: ['lead', 'responsibilities'],
    },
  );

export type OrchestrationSpec = z.infer<typeof OrchestrationSpecSchema>;
