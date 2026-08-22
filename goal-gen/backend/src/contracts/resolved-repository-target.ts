import { z } from 'zod';

/** ResolvedRepositoryTarget — mirrors goal-gen/schemas/app/resolved-repository-target.schema.json.
 *  Net-new app contract: the outcome of resolving a RepositoryGoalRequest.target into an exact,
 *  inspectable commit. */
export const ResolvedRepositoryTargetSchemaVersion = 'yellow-goal/resolved-repository-target/v1' as const;

const ResolvedRepositoryTargetProvider = z.enum(['local-git', 'github']);
const ResolvedRepositoryTargetAccessLevel = z.enum(['full-read', 'partial-read', 'unavailable']);

export const ResolvedRepositoryTargetSchema = z
  .object({
    schemaVersion: z.literal(ResolvedRepositoryTargetSchemaVersion),
    provider: ResolvedRepositoryTargetProvider,
    identity: z.string().min(1),
    defaultBranch: z.string().nullable().optional(),
    requestedRef: z.string(),
    resolvedRef: z.string(),
    sha: z.string().min(7),
    inspectionTimestamp: z.string().datetime({ offset: true }),
    accessLevel: ResolvedRepositoryTargetAccessLevel,
    toolLimitations: z.array(z.string()),
  })
  .strict();

export type ResolvedRepositoryTarget = z.infer<typeof ResolvedRepositoryTargetSchema>;
