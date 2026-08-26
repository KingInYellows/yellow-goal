import { z } from 'zod';

/**
 * RepositoryGoalRequest — mirrors goal-gen/schemas/vendored/request.schema.json exactly (nested
 * target/intent/mode; no flat `{repository, goal}` shortcut here). Flat convenience input is
 * expanded into this canonical shape by backend/src/intake before it ever reaches this schema —
 * see schemas/README.md "No changes needed" for why permissionProfile/orchestrationProfile live
 * inside the already-untyped `orchestration` bucket rather than as top-level fields.
 */
export const RepositoryGoalRequestSchemaVersion = 'yellow-goal/request/v1' as const;

const RequestTargetSchema = z.object({
  repository: z.string().min(1),
  ref: z.string().optional(),
  priorityPullRequest: z.union([z.number().int().min(1), z.string()]).optional(),
});

const RequestIntentSchema = z.object({
  goal: z.string().min(3),
  whyNow: z.string().optional(),
  successNotes: z.array(z.string()).optional(),
});

const RequestModeSchema = z.enum(['review-and-compile', 'review-only', 'approved-implementation']);

const RequestConstraintsSchema = z
  .object({
    readOnlyTarget: z.boolean().optional(),
    allowExternalResearch: z.boolean().optional(),
    allowTargetEdits: z.boolean().optional(),
    allowPush: z.boolean().optional(),
    allowMerge: z.boolean().optional(),
    allowDeploy: z.boolean().optional(),
    allowSecretReads: z.literal(false).optional(),
  })
  .catchall(z.boolean());

/** Guardrail overrides for an executable run (RR2) — every field optional, defaulting via
 *  `defaultRunConfig()` (ADR-0010). Strict: a typo in spend-controlling config must fail closed,
 *  not silently run with defaults. */
const ExecutionGuardrailsSchema = z
  .object({
    maxBudgetUsd: z.number().positive().optional(),
    maxReplans: z.number().int().min(0).optional(),
    maxReextractions: z.number().int().min(0).optional(),
    maxRetriesPerAction: z.number().int().min(1).optional(),
    actionTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

/** Run intent configuration (RR2, plans/specs/request-to-run-pipeline.md). Lives inside the
 *  untyped vendored `orchestration` bucket like `permissionProfile` does, so the vendored
 *  request.schema.json stays verbatim. Strict, unlike its passthrough parent — unknown keys
 *  here configure real execution and must be rejected. */
export const RequestExecutionSchema = z
  .object({
    autoConfirmDod: z.boolean().optional(),
    model: z.string().min(1).optional(),
    guardrails: ExecutionGuardrailsSchema.optional(),
  })
  .strict();

export type RequestExecution = z.infer<typeof RequestExecutionSchema>;

/** The vendored `orchestration` property is `{"type":"object"}` (no field constraints) — this
 *  narrower shape is a compatible refinement: everything it accepts still validates against the
 *  loose JSON Schema. `permissionProfile`/`orchestrationProfile` are populated by intake, not
 *  hand-authored by request callers. */
const RequestOrchestrationSchema = z
  .object({
    provider: z.string().optional(),
    leadModel: z.string().optional(),
    reviewModel: z.string().optional(),
    implementationModel: z.string().optional(),
    maxParallelWorkers: z.number().int().min(1).optional(),
    permissionProfile: z.string().optional(),
    orchestrationProfile: z.string().optional(),
    execution: RequestExecutionSchema.optional(),
    researchBounds: z
      .object({
        maxExternalQueries: z.number().int().min(0).optional(),
        maxExternalSources: z.number().int().min(0).optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

const RequestOverridesSchema = z
  .object({
    repositoryPurpose: z.string().optional(),
    commands: z.record(z.unknown()).optional(),
    protectedPaths: z.array(z.string()).optional(),
  })
  .passthrough();

export const RepositoryGoalRequestSchema = z
  .object({
    schemaVersion: z.literal(RepositoryGoalRequestSchemaVersion),
    requestId: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    target: RequestTargetSchema,
    intent: RequestIntentSchema,
    mode: RequestModeSchema,
    pack: z.string().optional(),
    constraints: RequestConstraintsSchema.optional(),
    orchestration: RequestOrchestrationSchema.optional(),
    overrides: RequestOverridesSchema.optional(),
  })
  .strict();

export type RepositoryGoalRequest = z.infer<typeof RepositoryGoalRequestSchema>;
