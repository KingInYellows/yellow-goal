import { randomUUID } from 'node:crypto';
import type { RepositoryGoalRequest } from '../contracts/request';
import { RepositoryGoalRequestSchema, RepositoryGoalRequestSchemaVersion } from '../contracts/request';
import { IntakeValidationFailure, type IntakeValidationError } from './errors';
import { isKnownOrchestrationProfile } from './orchestration-profiles';
import { isKnownPermissionProfile } from './permission-profiles';

const DEFAULT_MODE: RepositoryGoalRequest['mode'] = 'review-and-compile';
const DEFAULT_REF = 'AUTO';
const DEFAULT_PACK = 'repository-goal-packet@1';
const DEFAULT_PERMISSION_PROFILE = 'inspect';
const DEFAULT_ORCHESTRATION_PROFILE = 'claude-fable-opus-sonnet@1';

/**
 * Flat convenience input: satisfies AC-1 of 09_IMPLEMENTATION_MILESTONE.md ("A valid request
 * containing only repository and goal is accepted"). `goal` is preserved verbatim, including
 * whitespace — never trimmed or reworded here.
 */
export interface FlatRepositoryGoalRequestInput {
  repository: string;
  goal: string;
  ref?: string;
  priorityPullRequest?: number | string;
  whyNow?: string;
  successNotes?: string[];
  mode?: RepositoryGoalRequest['mode'];
  pack?: string;
  requestId?: string;
  permissionProfile?: string;
  orchestrationProfile?: string;
  researchBounds?: {
    maxExternalQueries?: number;
    maxExternalSources?: number;
  };
}

export interface RequestNormalizationDeps {
  /** Injectable so double-compile determinism tests can pin the generated id. Defaults to
   *  node:crypto randomUUID, which satisfies the requestId pattern
   *  (^[A-Za-z0-9][A-Za-z0-9._-]*$). */
  generateRequestId?: () => string;
}

function defaultGenerateRequestId(): string {
  return randomUUID();
}

/**
 * Expands a flat convenience input into the canonical nested RepositoryGoalRequest shape
 * (goal-gen/schemas/vendored/request.schema.json), applying defaults and rejecting unknown
 * permission/orchestration profiles before the shape is even assembled. Throws
 * IntakeValidationFailure with structured errors on any invalid input.
 */
export function normalizeRequest(
  input: FlatRepositoryGoalRequestInput,
  deps: RequestNormalizationDeps = {},
): RepositoryGoalRequest {
  const errors: IntakeValidationError[] = [];

  if (!input.repository || input.repository.trim().length === 0) {
    errors.push({ code: 'MISSING_REPOSITORY', message: 'repository is required', field: 'repository' });
  }

  if (typeof input.goal !== 'string' || input.goal.length < 3) {
    errors.push({
      code: 'INVALID_GOAL',
      message: 'goal must be a plain-English string of at least 3 characters',
      field: 'goal',
    });
  }

  const permissionProfile = input.permissionProfile ?? DEFAULT_PERMISSION_PROFILE;
  if (!isKnownPermissionProfile(permissionProfile)) {
    errors.push({
      code: 'UNKNOWN_PERMISSION_PROFILE',
      message: `unknown permission profile: ${permissionProfile}`,
      field: 'permissionProfile',
    });
  }

  const orchestrationProfile = input.orchestrationProfile ?? DEFAULT_ORCHESTRATION_PROFILE;
  if (!isKnownOrchestrationProfile(orchestrationProfile)) {
    errors.push({
      code: 'UNKNOWN_ORCHESTRATION_PROFILE',
      message: `unknown orchestration profile: ${orchestrationProfile}`,
      field: 'orchestrationProfile',
    });
  }

  if (errors.length > 0) {
    throw new IntakeValidationFailure(errors);
  }

  const generateRequestId = deps.generateRequestId ?? defaultGenerateRequestId;
  const requestId = input.requestId ?? generateRequestId();

  const candidate: RepositoryGoalRequest = {
    schemaVersion: RepositoryGoalRequestSchemaVersion,
    requestId,
    target: {
      repository: input.repository,
      ref: input.ref ?? DEFAULT_REF,
      ...(input.priorityPullRequest !== undefined ? { priorityPullRequest: input.priorityPullRequest } : {}),
    },
    intent: {
      goal: input.goal,
      ...(input.whyNow !== undefined ? { whyNow: input.whyNow } : {}),
      ...(input.successNotes !== undefined ? { successNotes: input.successNotes } : {}),
    },
    mode: input.mode ?? DEFAULT_MODE,
    pack: input.pack ?? DEFAULT_PACK,
    orchestration: {
      permissionProfile,
      orchestrationProfile,
      ...(input.researchBounds !== undefined ? { researchBounds: input.researchBounds } : {}),
    },
  };

  const parsed = RepositoryGoalRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new IntakeValidationFailure(
      parsed.error.issues.map((issue) => ({
        code: 'SCHEMA_VALIDATION_FAILED',
        message: issue.message,
        field: issue.path.join('.') || undefined,
      })),
    );
  }

  return parsed.data;
}
