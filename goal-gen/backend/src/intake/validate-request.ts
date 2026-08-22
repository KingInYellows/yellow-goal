import type { RepositoryGoalRequest } from '../contracts/request';
import { RepositoryGoalRequestSchema } from '../contracts/request';
import { IntakeValidationFailure, type IntakeValidationError } from './errors';
import { isKnownOrchestrationProfile } from './orchestration-profiles';
import { isKnownPermissionProfile } from './permission-profiles';

export interface RequestValidationError {
  path: string;
  message: string;
}

export interface RequestValidationResult {
  valid: boolean;
  errors: RequestValidationError[];
}

function schemaIssuesToErrors(issues: readonly { path: PropertyKey[]; message: string }[]): IntakeValidationError[] {
  return issues.map((issue) => ({
    code: 'SCHEMA_VALIDATION_FAILED',
    message: issue.message,
    field: issue.path.length > 0 ? issue.path.join('.') : undefined,
  }));
}

/**
 * Optional profile fields may be absent. A present value must be in the known set — same
 * fail-closed rule `normalizeRequest` applies on `request create`, so a hand-authored or
 * packet-extracted request cannot carry `bypassPermissions` or a typo into inspect/analyze/compile.
 */
function collectUnknownProfileErrors(request: RepositoryGoalRequest): IntakeValidationError[] {
  const errors: IntakeValidationError[] = [];
  const permissionProfile = request.orchestration?.permissionProfile;
  if (permissionProfile !== undefined && !isKnownPermissionProfile(permissionProfile)) {
    errors.push({
      code: 'UNKNOWN_PERMISSION_PROFILE',
      message: `unknown permission profile: ${permissionProfile}`,
      field: 'orchestration.permissionProfile',
    });
  }
  const orchestrationProfile = request.orchestration?.orchestrationProfile;
  if (orchestrationProfile !== undefined && !isKnownOrchestrationProfile(orchestrationProfile)) {
    errors.push({
      code: 'UNKNOWN_ORCHESTRATION_PROFILE',
      message: `unknown orchestration profile: ${orchestrationProfile}`,
      field: 'orchestration.orchestrationProfile',
    });
  }
  return errors;
}

function collectCanonicalRequestErrors(candidate: unknown): {
  request?: RepositoryGoalRequest;
  errors: IntakeValidationError[];
} {
  const parsed = RepositoryGoalRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    return { errors: schemaIssuesToErrors(parsed.error.issues) };
  }
  const profileErrors = collectUnknownProfileErrors(parsed.data);
  if (profileErrors.length > 0) {
    return { errors: profileErrors };
  }
  return { request: parsed.data, errors: [] };
}

function toValidationErrors(errors: readonly IntakeValidationError[]): RequestValidationError[] {
  return errors.map((error) => ({
    path: error.field ?? '(root)',
    message: error.message,
  }));
}

/**
 * Validates a value already claiming to be the canonical, nested RepositoryGoalRequest shape
 * (e.g. a contracts/request.json read back out of a packet, or a hand-authored request file) —
 * unlike normalizeRequest, this performs no defaulting or expansion. Unknown
 * permission/orchestration profiles fail closed even though the Zod schema itself is a
 * compatible refinement of the untyped vendored `orchestration` object.
 */
export function validateCanonicalRequest(candidate: unknown): RequestValidationResult {
  const { errors } = collectCanonicalRequestErrors(candidate);
  if (errors.length === 0) {
    return { valid: true, errors: [] };
  }
  return { valid: false, errors: toValidationErrors(errors) };
}

/**
 * Shared loader for inspect / analyze / compile. Throws IntakeValidationFailure so the CLI
 * reports VALIDATION_FAILED rather than treating a bad hand-authored request as an unexpected error.
 */
export function parseCanonicalRequest(candidate: unknown): RepositoryGoalRequest {
  const { request, errors } = collectCanonicalRequestErrors(candidate);
  if (!request) {
    throw new IntakeValidationFailure(errors);
  }
  return request;
}
