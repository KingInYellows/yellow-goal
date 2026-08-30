/**
 * The ONE mapping path from a canonical `RepositoryGoalRequest` to executable run inputs
 * (RR3, plans/specs/request-to-run-pipeline.md). Every entry point that turns a request into a
 * run — the CLI `run` verb, the M1 runner's `--request` form — goes through here; nothing else
 * may derive run inputs from a request.
 *
 * Fail-closed on intent (RR4): only `mode: 'approved-implementation'` may execute. Review modes
 * are refused with an IntakeValidationFailure BEFORE any extractor/executor/worktree work, so
 * the CLI reports the same VALIDATION_FAILED envelope it uses for malformed requests.
 */
import { readFile } from 'node:fs/promises';
import type { RepositoryGoalRequest } from '../contracts/request';
import { IntakeValidationFailure, parseCanonicalRequest, permissionProfileAllowsTargetWrite } from '../intake';
import { defaultRunConfig } from '../orchestrator/guardrails';
import type { RunConfig } from '../types';

export interface RunInputs {
  /** `intent.goal` verbatim — the compiler's goal-preservation invariant applies to runs too. */
  goalText: string;
  runConfig: RunConfig;
  /** Auto-confirm DoD/reconfirm gates only; never the completion sign-off gate (RR14). Note:
   *  entry points apply RR19 on top of this — for a real executor, a request file alone cannot
   *  auto-confirm; the invoking operator's CLI `--yes` is required. */
  autoConfirm: boolean;
  /** `target.repository` verbatim — the requested repository to execute against. */
  repository: string;
  /** `target.ref` if present — the specific ref/branch to check out. */
  ref?: string;
}

export interface RunMappingOptions {
  /** RR18: a request file may LOWER guardrail caps freely, but raising any cap above the
   *  ADR-0010 defaults requires this explicit operator opt-in (CLI `--allow-guardrail-override`).
   *  Without it, a raised cap is a validation failure — a hostile or mistyped request file must
   *  not be able to raise spend ceilings on its own. */
  allowGuardrailOverride?: boolean;
}

/** Spend/time-relevant caps a request may not raise above the ADR-0010 defaults without RR18
 *  consent. `model` is deliberately not listed: it selects unit cost, not a ceiling. */
const RAISABLE_GUARDRAILS = [
  'maxBudgetUsd',
  'maxReplans',
  'maxReextractions',
  'maxRetriesPerAction',
  'actionTimeoutMs',
] as const;

export function requestToRunInputs(request: RepositoryGoalRequest, options: RunMappingOptions = {}): RunInputs {
  if (request.mode !== 'approved-implementation') {
    throw new IntakeValidationFailure([
      {
        code: 'RUN_MODE_NOT_EXECUTABLE',
        message: `request mode '${request.mode}' cannot execute — a run requires mode 'approved-implementation'`,
        field: 'mode',
      },
    ]);
  }

  // Fail closed on explicitly-declared non-writable targets (readOnlyTarget / allowTargetEdits).
  const constraints = request.constraints;
  if (constraints?.readOnlyTarget === true || constraints?.allowTargetEdits === false) {
    throw new IntakeValidationFailure([
      {
        code: 'RUN_CONSTRAINTS_FORBID_EXECUTION',
        message:
          "request constraints forbid an executable run — 'readOnlyTarget: true' / 'allowTargetEdits: false' cannot combine with an executable mode",
        field: 'constraints',
      },
    ]);
  }

  // RR21 (plans/specs/request-to-run-pipeline.md) — default-deny on target-write declaration.
  // The vendored schema documents readOnlyTarget: true / allowTargetEdits: false as the DEFAULT
  // when `constraints` is omitted (schemas/vendored/request.schema.json); the zod contract above
  // narrows it as optional-without-zod-defaults, so an omitted (or under-specified) `constraints`
  // block must not silently pass through to execution. Only an explicit
  // `allowTargetEdits: true` clears this gate — absence is read as read-only, not as false.
  if (constraints?.allowTargetEdits !== true) {
    throw new IntakeValidationFailure([
      {
        code: 'RUN_CONSTRAINTS_NOT_DECLARED_WRITABLE',
        message:
          "request constraints do not declare the target writable — an executable run requires 'constraints.allowTargetEdits: true' ('readOnlyTarget'/'allowTargetEdits' default to read-only when 'constraints' is omitted)",
        field: 'constraints',
      },
    ]);
  }

  // RR21 — fail closed on the selected permission profile too (policies/permission-profiles.json).
  // Profiles that forbid target writes ('inspect', 'compile') must not reach execution even if
  // constraints above were satisfied, and an absent/unrecognized profile is treated as NOT
  // declared writable (fail closed), matching the constraints guard's posture. This is
  // deliberately fail-closed REJECTION only: mapping the profile onto the executor's own
  // permission mode (e.g. `bypassPermissions` vs. scoped modes) is provider-protocol-v1 work and
  // stays out of scope here.
  const permissionProfile = request.orchestration?.permissionProfile;
  if (permissionProfile === undefined || !permissionProfileAllowsTargetWrite(permissionProfile)) {
    throw new IntakeValidationFailure([
      {
        code: 'RUN_PERMISSION_PROFILE_FORBIDS_EXECUTION',
        message:
          permissionProfile === undefined
            ? "request has no 'orchestration.permissionProfile' — an executable run requires a profile that permits target writes (e.g. 'implement')"
            : `permission profile '${permissionProfile}' forbids target writes and cannot combine with an executable mode`,
        field: 'orchestration.permissionProfile',
      },
    ]);
  }

  const execution = request.orchestration?.execution;
  const overrides: Partial<RunConfig> = {
    ...(execution?.guardrails ?? {}),
    ...(execution?.model !== undefined ? { model: execution.model } : {}),
  };

  if (options.allowGuardrailOverride !== true) {
    const ceilings = defaultRunConfig();
    const raised = RAISABLE_GUARDRAILS.filter((name) => {
      const requested = execution?.guardrails?.[name];
      return requested !== undefined && requested > ceilings[name];
    });
    if (raised.length > 0) {
      throw new IntakeValidationFailure(
        raised.map((name) => ({
          code: 'RUN_GUARDRAILS_EXCEED_DEFAULTS',
          message: `guardrail '${name}' (${execution?.guardrails?.[name]}) exceeds the default ceiling (${ceilings[name]}) — raising caps requires the operator's --allow-guardrail-override`,
          field: `orchestration.execution.guardrails.${name}`,
        })),
      );
    }
  }

  return {
    goalText: request.intent.goal,
    runConfig: defaultRunConfig(overrides),
    autoConfirm: execution?.autoConfirmDod === true,
    repository: request.target.repository,
    ref: request.target.ref,
  };
}

/**
 * Read + validate a request file into the canonical shape (same loader semantics as
 * inspect/analyze/compile: malformed JSON or an invalid request throws IntakeValidationFailure,
 * so callers surface VALIDATION_FAILED rather than UNEXPECTED_ERROR).
 */
export async function loadRunRequest(filePath: string): Promise<RepositoryGoalRequest> {
  const raw = await readFile(filePath, 'utf8');
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch (err) {
    throw new IntakeValidationFailure([
      {
        code: 'REQUEST_FILE_INVALID_JSON',
        message: `${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    ]);
  }
  return parseCanonicalRequest(candidate);
}
