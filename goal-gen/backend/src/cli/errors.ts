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
