import { MUTATED_CANDIDATE_REASON, type AcceptanceEvidenceRecord } from './acceptance-evidence';
import type { ObservedFixtureProfile } from './observed-fixture-profiles';
import type { ObservationResult } from './observed-fixture-observer';

export type FixtureDecision = {
  accepted: boolean;
  reasons: string[];
};

export type RecorderInvocation = {
  exit: number;
  stdout: string;
  stderr: string;
  record?: AcceptanceEvidenceRecord;
};

function overlaysMatch(actual: Record<string, string>, approved: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(actual), ...Object.keys(approved)]);
  for (const key of keys) {
    if (actual[key] !== approved[key]) return false;
  }
  return true;
}

export function decideObservedFixture(input: {
  profile: ObservedFixtureProfile;
  observation: ObservationResult;
  recorder?: RecorderInvocation;
}): FixtureDecision {
  const reasons: string[] = [];
  if (input.observation.faults.length > 0) {
    for (const fault of input.observation.faults) {
      reasons.push(`observation-fault:${fault.code}:${fault.message}`);
    }
    return { accepted: false, reasons };
  }
  if (input.recorder === undefined) {
    return { accepted: false, reasons: ['recorder-not-invoked'] };
  }
  if (input.recorder.exit !== 0 || input.recorder.record === undefined) {
    return {
      accepted: false,
      reasons: [`recorder-exit:${input.recorder.exit}:${input.recorder.stderr.trim() || 'no record'}`],
    };
  }
  const record = input.recorder.record;
  if (record.status !== 'passed') {
    reasons.push(`record-status:${record.status}`);
  }
  for (const row of input.observation.checks) {
    if (row.status !== 'passed') reasons.push(`check:${row.id}:${row.status}`);
    if (row.reason === MUTATED_CANDIDATE_REASON) reasons.push(`leftover-mutation:${row.id}`);
  }
  if (input.profile.requiredCheckIds.some((id) => !input.observation.checks.some((row) => row.id === id))) {
    reasons.push('required-check-missing');
  }
  if (!overlaysMatch(input.observation.overlay, input.profile.approvedFiles)) {
    reasons.push('candidate-overlay-not-approved');
  }
  if (reasons.length > 0) return { accepted: false, reasons };
  return { accepted: true, reasons: ['all required checks observed passed for the approved candidate'] };
}
