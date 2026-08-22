import { z } from 'zod';

/** RepoProfile — mirrors goal-gen/schemas/vendored/repo-profile.schema.json exactly. */
export const RepoProfileSchemaVersion = 'yellow-goal/repo-profile/v1' as const;

const RepoProfileCommandConfidence = z.enum(['verified', 'configured', 'suggested', 'unknown']);
const RepoProfileCommandSideEffectClass = z.enum([
  'none',
  'workspace-only',
  'repository-write',
  'external-mutation',
  'unknown',
]);

const RepoProfileCommandSchema = z
  .object({
    id: z.string(),
    argv: z.array(z.string()).min(1),
    cwd: z.string().optional(),
    sourceEvidenceRef: z.string(),
    confidence: RepoProfileCommandConfidence,
    sideEffectClass: RepoProfileCommandSideEffectClass,
  })
  .strict();

const RepoProfileTargetSchema = z.object({
  repository: z.string(),
  defaultBranch: z.string().nullable().optional(),
  requestedRef: z.string().optional(),
  resolvedRef: z.string(),
  headSha: z.string().min(7),
  inspectedAt: z.string().datetime({ offset: true }),
});

export const RepoProfileSchema = z
  .object({
    schemaVersion: z.literal(RepoProfileSchemaVersion),
    target: RepoProfileTargetSchema,
    repositoryKinds: z
      .array(z.string())
      .refine((arr) => new Set(arr).size === arr.length, { message: 'repositoryKinds must be unique' }),
    instructionFiles: z.array(z.string()),
    manifests: z.array(z.record(z.unknown())).optional(),
    commands: z.array(RepoProfileCommandSchema),
    openPullRequests: z.array(z.record(z.unknown())).optional(),
    issues: z.array(z.record(z.unknown())).optional(),
    ciWorkflows: z.array(z.record(z.unknown())).optional(),
    releaseSignals: z.array(z.record(z.unknown())).optional(),
    protectedPaths: z.array(z.string()).optional(),
    evidenceRefs: z.array(z.string()),
  })
  .strict();

export type RepoProfile = z.infer<typeof RepoProfileSchema>;
