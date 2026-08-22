import { z } from 'zod';

/** OrchestrationProfile — mirrors goal-gen/schemas/app/orchestration-profile.schema.json. Net-new
 *  app contract: the versioned model-role resolution (which exact model each semantic role uses),
 *  distinct from OrchestrationSpec (the execution/wave contract) — see contracts/orchestration.ts. */
export const OrchestrationProfileSchemaVersion = 'yellow-goal/orchestration-profile/v1' as const;

const OrchestrationProfileBindingSchema = z
  .object({
    modelId: z.string().min(1),
    provider: z.string().min(1),
  })
  .strict();

const OrchestrationProfileRoleBindingsSchema = z
  .object({
    lead: OrchestrationProfileBindingSchema,
    architecture: OrchestrationProfileBindingSchema,
    security: OrchestrationProfileBindingSchema,
    'complex-debugging': OrchestrationProfileBindingSchema,
    implementation: OrchestrationProfileBindingSchema,
    'unit-tests': OrchestrationProfileBindingSchema,
    documentation: OrchestrationProfileBindingSchema,
    'evidence-mapping': OrchestrationProfileBindingSchema,
    'release-review': OrchestrationProfileBindingSchema,
  })
  .strict();

export const OrchestrationProfileSchema = z
  .object({
    schemaVersion: z.literal(OrchestrationProfileSchemaVersion),
    id: z.string().regex(/^[a-z0-9-]+@[0-9]+$/),
    provider: z.string().min(1),
    roleBindings: OrchestrationProfileRoleBindingsSchema,
    resolvedAt: z.string().datetime({ offset: true }),
    claudeCodeVersion: z.string().optional(),
    docSource: z.string().min(1),
  })
  .strict();

export type OrchestrationProfile = z.infer<typeof OrchestrationProfileSchema>;
