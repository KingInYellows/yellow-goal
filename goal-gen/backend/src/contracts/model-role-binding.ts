import { z } from 'zod';

/** ModelRoleBinding — mirrors goal-gen/schemas/app/model-role-binding.schema.json. Net-new app
 *  contract: one semantic role resolved to one exact model identifier. */
export const ModelRoleBindingSchemaVersion = 'yellow-goal/model-role-binding/v1' as const;

export const ModelRoleBindingSchema = z
  .object({
    schemaVersion: z.literal(ModelRoleBindingSchemaVersion),
    role: z.string().min(1),
    modelId: z.string().min(1),
    provider: z.string().min(1),
  })
  .strict();

export type ModelRoleBinding = z.infer<typeof ModelRoleBindingSchema>;
