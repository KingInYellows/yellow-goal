/**
 * The real run's fixed goal (AGX-R9, R10): exactly one action whose prompt is the approved
 * profile's milestone text. No extractor, planner, retry, replan or remediation is involved — the
 * worker gets one attempt and the candidate verifier alone judges it.
 */
import type { CandidateOfflineProfile } from '../cli/candidate-offline-profiles';
import { RunApprovalError } from '../cli/errors';
import type { Action } from '../planner/types';

export function buildFixedAction(profile: CandidateOfflineProfile): Action {
  if (profile.milestoneText === undefined) {
    throw new RunApprovalError(
      'MANIFEST_INVALID',
      `profile ${profile.id}@${profile.version} has no worker milestone; select a real-run version such as ${profile.id}@2`,
      { profile: `${profile.id}@${profile.version}` },
    );
  }
  return {
    id: 'milestone',
    name: `${profile.id}@${profile.version} milestone`,
    cost: 1,
    preconditions: {},
    effects: { done: true },
    executor: 'claude-code',
    payload: { prompt: profile.milestoneText },
    // Never executed: the engine judges the candidate with `acceptance verify-candidate` (AGX-R18).
    // Not a shell no-op, so anything that did execute it would fail closed.
    verify: { command: `acceptance verify-candidate ${profile.id}@${profile.version}` },
  };
}
