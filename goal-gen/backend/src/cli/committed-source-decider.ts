import type { FixtureDecision } from './observed-fixture-decider';
import type { ObservedCheckOutcome } from './observed-fixture-observer';
import type { CommittedSourceProfile } from './committed-source-profiles';

export type CaptureFault = {
  code: string;
  message: string;
};

export function decideCommittedSource(input: {
  profile: CommittedSourceProfile;
  outcomes: ObservedCheckOutcome[];
  missing: string[];
  faults: CaptureFault[];
}): FixtureDecision {
  const reasons: string[] = [];
  for (const fault of input.faults) {
    reasons.push(`capture-fault:${fault.code}:${fault.message}`);
  }
  for (const relative of input.missing) {
    reasons.push(`missing-blob:${relative}`);
  }
  for (const row of input.outcomes) {
    if (row.status !== 'passed') reasons.push(`check:${row.id}:${row.status}`);
  }
  if (input.profile.requiredCheckIds.some((id) => !input.outcomes.some((row) => row.id === id))) {
    reasons.push('required-check-missing');
  }
  if (reasons.length > 0) return { accepted: false, reasons };
  return { accepted: true, reasons: ['all required checks observed passed for captured source'] };
}
