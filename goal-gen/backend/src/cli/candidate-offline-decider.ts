import { MUTATED_CANDIDATE_REASON } from './acceptance-evidence';
import type { CandidateOfflineProfile } from './candidate-offline-profiles';
import type { FixtureDecision, RecorderInvocation } from './observed-fixture-decider';
import type { ObservationResult } from './observed-fixture-observer';

export function decideCandidateOffline(input: {
  profile: CandidateOfflineProfile;
  observation: ObservationResult;
  recorder?: RecorderInvocation;
  unauthorized?: string[];
}): FixtureDecision {
  const reasons: string[] = [];
  if (input.unauthorized !== undefined && input.unauthorized.length > 0) {
    return {
      accepted: false,
      reasons: input.unauthorized.map((path) => `unauthorized-path:${path}`),
    };
  }
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
  const overlayKeys = Object.keys(input.observation.overlay);
  for (const relative of overlayKeys) {
    const inBase = Object.prototype.hasOwnProperty.call(input.profile.baseFiles, relative);
    const allowed = input.profile.allowedPaths.includes(relative);
    if (!inBase && !allowed) reasons.push(`unauthorized-overlay:${relative}`);
  }
  if (reasons.length > 0) return { accepted: false, reasons };
  return { accepted: true, reasons: ['all required checks observed passed for a semantically valid candidate'] };
}
