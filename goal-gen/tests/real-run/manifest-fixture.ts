/**
 * The one `config-repair@2` run-manifest literal the executor, fake-worker, harness and probe
 * suites build on. Dependency-light (no vitest), so the human-run permission probe can import it.
 */
import { candidateProfileDigest, getCandidateOfflineProfile } from '../../backend/src/cli/candidate-offline-profiles';
import type { RunManifest } from '../../backend/src/cli/run-manifest';

export function realRunManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  const profile = getCandidateOfflineProfile('config-repair', '2');
  return {
    schemaVersion: 'yellow-goal/run-manifest/v1',
    engineVersion: '0.2.0',
    protocolId: 'yellow-goal/provider-protocol/v2',
    profile: { id: profile.id, version: profile.version, digest: candidateProfileDigest(profile) },
    requestHash: 'd'.repeat(64),
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    allowedTools: ['Edit(./SITE)', 'Edit(./site.json)', 'Read(./**)'],
    disallowedTools: [],
    maxTurns: 8,
    caps: { perActionUsd: 0.5, totalUsd: 5 },
    actionTimeoutMs: 300_000,
    runWallClockMs: 600_000,
    authMode: 'subscription',
    attemptCount: 1,
    expiresInMinutes: 60,
    // The executor never reads the evidence destinations; the engine owns them (AGX-R8a).
    evidence: { bundleDir: '/nonexistent/goal-gen/bundle', spendLedgerPath: '/nonexistent/goal-gen/spend.jsonl' },
    ...overrides,
  };
}
