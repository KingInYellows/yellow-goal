/** Bad flags/positionals — a CLI usage mistake, not a request/packet validation failure. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/**
 * A command that depends on another worker's module whose module is not present (or does not
 * export the expected function) at run time. This is expected to disappear once the lead wires
 * the real module in at integration — the message names exactly what was expected so that wiring
 * is a one-line fix, not a debugging session.
 */
export class NotWiredError extends Error {
  constructor(command: string, modulePath: string, exportName: string) {
    super(`'${command}' is not wired yet: expected ${modulePath} to export ${exportName}()`);
    this.name = 'NotWiredError';
  }
}

/** Fixture/recorder contract failure — no record written (exit 1). */
export class AcceptanceEvidenceError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AcceptanceEvidenceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Observed-fixture workflow failure that is not a recorder-field invention. */
export class ObservedFixtureError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ObservedFixtureError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Every refusal code a run manifest / approval can produce (ADR-0020, runbook refusal table). */
export const RUN_APPROVAL_ERROR_CODES = [
  'MANIFEST_INVALID',
  'APPROVAL_TTY_REQUIRED',
  'APPROVAL_DECLINED',
  'APPROVAL_OUT_EXISTS',
  'APPROVAL_OUT_UNWRITABLE',
  'APPROVAL_MISSING',
  'APPROVAL_INVALID',
  'APPROVAL_ENGINE_MISMATCH',
  'APPROVAL_HASH_MISMATCH',
  'APPROVAL_EXPIRED',
  'APPROVAL_CONSUMED',
  'APPROVAL_STATE_UNAVAILABLE',
  'AUTH_MODE_MISMATCH',
  'TOOLS_UNCONFINED',
  'EVIDENCE_DESTINATION_REFUSED',
  'EVIDENCE_WRITE_FAILED',
  'RUN_CANCELLED',
] as const;
export type RunApprovalErrorCode = (typeof RUN_APPROVAL_ERROR_CODES)[number];

/** Run-manifest / run-approval refusal (ADR-0020) — nothing minted, consumed, or spawned (exit 1). */
export class RunApprovalError extends Error {
  readonly code: RunApprovalErrorCode;
  readonly details?: unknown;

  constructor(code: RunApprovalErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'RunApprovalError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
