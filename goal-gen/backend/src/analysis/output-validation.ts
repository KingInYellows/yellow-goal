/**
 * Deep validation gate for `AnalysisProviderOutput`, run BEFORE an analysis bundle is written to
 * disk. Exists because `RepositoryAssessmentSchema.findings` is `z.array(z.record(z.unknown()))`
 * — loosely typed at the container level (each finding is validated against `FindingSchema`
 * separately, since `Finding` is its own top-level contract, not composed strictly into
 * `RepositoryAssessment`). A provider's top-level `.safeParse(assessment)` therefore does NOT
 * catch an out-of-enum `Finding.severity`/`.classification` — only a per-element `FindingSchema`
 * check does. Without this gate, an invalid finding could pass provider-level validation, get
 * written to `assessment.json` by `writeAnalysisBundle`, and only be caught much later by
 * `compilePacket`'s own (separate, independent) finding validation — by which point an invalid
 * bundle already exists on disk. This module is that missing early gate.
 */
import {
  FindingSchema,
  GoalResolutionSchema,
  MilestoneSpecSchema,
  RepositoryAssessmentSchema,
  type Finding,
} from '../contracts';
import { AnalysisProviderError, type AnalysisProviderOutput } from './types';

export interface FindingsValidationResult {
  valid: boolean;
  findings: Finding[];
  errors: string[];
}

/** Validates every element of `rawFindings` against `FindingSchema` individually. Non-throwing —
 *  callers that need the exact zod error text (e.g. to build a model repair prompt) use this
 *  directly; callers that just want a hard gate use {@link assertValidAnalysisOutput}. */
export function validateFindingsAgainstSchema(rawFindings: readonly Record<string, unknown>[]): FindingsValidationResult {
  const findings: Finding[] = [];
  const errors: string[] = [];
  rawFindings.forEach((raw, i) => {
    const result = FindingSchema.safeParse(raw);
    if (result.success) {
      findings.push(result.data);
    } else {
      errors.push(`findings[${i}]: ${result.error.message}`);
    }
  });
  return { valid: errors.length === 0, findings, errors };
}

/**
 * Full pre-write gate: re-validates `output.assessment.findings[]` element-by-element against
 * `FindingSchema` (the real gap this module closes), plus a defense-in-depth re-validation of the
 * already-typed `assessment`/`goalResolution`/`milestone` objects against their own contract
 * schemas (cheap; guards against `AnalysisProviderOutput`'s type guarantees ever being loosened
 * or bypassed by a future provider). Throws {@link AnalysisProviderError} naming every problem
 * found — never returns a partial or corrected result; the caller must not write anything to disk
 * if this throws.
 */
export function assertValidAnalysisOutput(output: AnalysisProviderOutput): void {
  const errors: string[] = [];

  const findingsCheck = validateFindingsAgainstSchema(output.assessment.findings);
  if (!findingsCheck.valid) errors.push(...findingsCheck.errors);

  const assessmentCheck = RepositoryAssessmentSchema.safeParse(output.assessment);
  if (!assessmentCheck.success) errors.push(`assessment: ${assessmentCheck.error.message}`);

  const goalResolutionCheck = GoalResolutionSchema.safeParse(output.goalResolution);
  if (!goalResolutionCheck.success) errors.push(`goalResolution: ${goalResolutionCheck.error.message}`);

  const milestoneCheck = MilestoneSpecSchema.safeParse(output.milestone);
  if (!milestoneCheck.success) errors.push(`milestone: ${milestoneCheck.error.message}`);

  if (errors.length > 0) {
    throw new AnalysisProviderError(`analysis output failed validation before bundle write: ${errors.join('; ')}`);
  }
}
