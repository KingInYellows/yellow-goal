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
import { IntakeValidationFailure, parseCanonicalRequest } from '../intake';
import { defaultRunConfig } from '../orchestrator/guardrails';
import type { RunConfig } from '../types';

export interface RunInputs {
  /** `intent.goal` verbatim — the compiler's goal-preservation invariant applies to runs too. */
  goalText: string;
  runConfig: RunConfig;
  /** Auto-confirm DoD/reconfirm gates only; never the completion sign-off gate (RR14). */
  autoConfirm: boolean;
}

export function requestToRunInputs(request: RepositoryGoalRequest): RunInputs {
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
  // Absent constraints pass: the zod schema is optional-without-defaults, so the vendored
  // schema's documented defaults (readOnlyTarget: true) are deliberately NOT applied here —
  // divergence noted in plans/specs/request-to-run-pipeline.md follow-ups.
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

  const execution = request.orchestration?.execution;
  const overrides: Partial<RunConfig> = {
    ...(execution?.guardrails ?? {}),
    ...(execution?.model !== undefined ? { model: execution.model } : {}),
  };

  return {
    goalText: request.intent.goal,
    runConfig: defaultRunConfig(overrides),
    autoConfirm: execution?.autoConfirmDod === true,
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
