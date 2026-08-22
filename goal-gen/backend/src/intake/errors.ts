/** Structured intake error — CLI commands serialize an array of these to stderr as JSON. */
export interface IntakeValidationError {
  code: string;
  message: string;
  field?: string;
}

/** Thrown by normalizeRequest/validateCanonicalRequest-adjacent helpers on invalid input. Carries
 *  the full structured error list so callers never have to re-parse `.message`. */
export class IntakeValidationFailure extends Error {
  readonly errors: readonly IntakeValidationError[];

  constructor(errors: readonly IntakeValidationError[]) {
    super(errors.map((error) => error.message).join('; ') || 'request validation failed');
    this.name = 'IntakeValidationFailure';
    this.errors = errors;
  }
}
