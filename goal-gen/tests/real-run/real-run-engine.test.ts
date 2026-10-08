/**
 * AGX-R8–R10, R16–R21: the real-run engine's outcome table, driven in-process with the fake worker
 * and approvals minted through the `run approve` TTY seam. Every row checks the worker invocation
 * count, the consumption marker, the spend ledger, the bundle, and that the scratch worktree is gone.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as offlineCommand from '../../backend/src/cli/candidate-offline-command';
import { getCandidateOfflineProfile } from '../../backend/src/cli/candidate-offline-profiles';
import { mintRunApprovalRecord, writeFileExclusive } from '../../backend/src/cli/run-approval';
import { manifestFromFlags } from '../../backend/src/cli/run-manifest-command';
import { seedScratchFromCapture, type RealRunInput, type ScratchSeed } from '../../backend/src/real-run/real-run-engine';
import type { RealRunOutcome } from '../../backend/src/real-run/outcome';
import {
  createFixture,
  fakeWorkerFactory,
  flagValues,
  invocations,
  ledgerEntries,
  manifestArgs,
  markerExists,
  mintApproval,
  plantOwnerRepo,
  removeFixture,
  runEngine,
  scratchRoot,
  stubCleanCredentials,
  type Fixture,
  type PlantedOwner,
} from './support';

vi.mock('../../backend/src/cli/candidate-offline-command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../backend/src/cli/candidate-offline-command')>();
  return { ...actual, verifyCandidateDocument: vi.fn(actual.verifyCandidateDocument) };
});

let fx: Fixture;

beforeEach(async () => {
  stubCleanCredentials();
  fx = await createFixture();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(offlineCommand.verifyCandidateDocument).mockClear();
  await removeFixture(fx);
});

/** One spawn happened, its worktree is gone, the approval is consumed and metered once. */
function expectOneConsumedAttempt(approvalId: string): void {
  const calls = invocations(fx);
  expect(calls).toHaveLength(1);
  expect(existsSync(scratchRoot(calls[0]!))).toBe(false);
  expect(markerExists(fx, approvalId)).toBe(true);
  expect(ledgerEntries(fx)).toHaveLength(1);
}

describe('real-run engine outcomes (AGX-R19)', () => {
  it('success: verified with a persisted bundle; the prompt is the profile milestone', async () => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    const outcome = await runEngine(fx, 'success', args);
    expect(outcome).toMatchObject({
      kind: 'verified',
      approvalId,
      bundleDir: fx.bundleDir,
      outOfScopeChanges: [],
      targetRepositoryHonored: false,
      spend: { costUsd: expect.closeTo(0.0803324, 6) as unknown as number, exitClass: 'success' },
    });
    expectOneConsumedAttempt(approvalId);
    expect(invocations(fx)[0]!.prompt).toBe(getCandidateOfflineProfile('config-repair', '2').milestoneText);
    const manifest = JSON.parse(readFileSync(path.join(fx.bundleDir, 'manifest.json'), 'utf8')) as {
      profile: { version: string };
      decision: { accepted: boolean };
      candidate: { files: Record<string, string> };
    };
    expect(manifest.profile.version).toBe('2');
    expect(manifest.decision.accepted).toBe(true);
    expect(Object.keys(manifest.candidate.files).sort()).toEqual(['SITE', 'site.json']);
    expect(existsSync(path.join(fx.bundleDir, 'COMPLETE'))).toBe(true);
  });

  it('wrong-repair: verification-rejected with the decider reasons and a bundle', async () => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    const outcome = await runEngine(fx, 'wrong-repair', args);
    expect(outcome.kind).toBe('verification-rejected');
    if (outcome.kind !== 'verification-rejected') return;
    expect(outcome.reasons.length).toBeGreaterThan(0);
    expect(outcome.approvalId).toBe(approvalId);
    expectOneConsumedAttempt(approvalId);
    expect(existsSync(path.join(fx.bundleDir, 'COMPLETE'))).toBe(true);
  });

  it.each([
    ['budget-stop', 'budget'],
    ['max-turns', 'max-turns'],
    ['error-result', 'error-result'],
    ['permission-denial', 'permission-denied'],
    ['malformed-output', 'malformed-output'],
    ['missing-cost', 'cost-unmetered'],
  ])('%s: worker-failed %s, metered once, no bundle', async (scenario, reason) => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    const outcome = await runEngine(fx, scenario, args);
    expect(outcome).toMatchObject({ kind: 'worker-failed', reason, approvalId, targetRepositoryHonored: false });
    expectOneConsumedAttempt(approvalId);
    expect(ledgerEntries(fx)[0]).toMatchObject({ approvalId, exitClass: reason, model: 'sonnet' });
    expect(existsSync(fx.bundleDir)).toBe(false);
  });

  it.each([
    ['symlink-allowed-path', 'symlink'],
    ['fifo-allowed-path', 'fifo'],
    ['oversize-allowed-path', 'oversize'],
  ])('%s: worker-failed unsafe-allowed-path (%s); the operator file is never read', async (scenario, kind) => {
    const secret = 'operator secret that must never reach evidence';
    await writeFile(path.join(fx.dir, 'operator-secret.txt'), secret, 'utf8');
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    const outcome = await runEngine(fx, scenario, args);
    expect(outcome).toMatchObject({ kind: 'worker-failed', reason: 'unsafe-allowed-path', evidence: { path: 'site.json', kind } });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expectOneConsumedAttempt(approvalId);
    expect(existsSync(fx.bundleDir)).toBe(false);
  });

  it('out-of-scope-write: verified, with the extra file reported as evidence only', async () => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    const outcome = await runEngine(fx, 'out-of-scope-write', args);
    expect(outcome).toMatchObject({ kind: 'verified', outOfScopeChanges: ['other.txt'] });
    expectOneConsumedAttempt(approvalId);
    const bundle = JSON.parse(readFileSync(path.join(fx.bundleDir, 'manifest.json'), 'utf8')) as { candidate: { files: object } };
    expect(Object.keys(bundle.candidate.files)).not.toContain('other.txt');
  });

  it('gitignore-hide: a self-ignoring .gitignore cannot hide out-of-scope files', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const outcome = await runEngine(fx, 'gitignore-hide', args);
    expect(outcome).toMatchObject({ kind: 'verified', outOfScopeChanges: ['.gitignore', 'other.txt'] });
  });

  it('two concurrent runs with one approval produce exactly one worker invocation', async () => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    const outcomes = await Promise.all([runEngine(fx, 'success', args), runEngine(fx, 'success', args)]);
    const kinds = outcomes.map((outcome) => outcome.kind).sort();
    expect(kinds).toEqual(['refused', 'verified']);
    expect(outcomes.find((outcome) => outcome.kind === 'refused')).toMatchObject({ code: 'APPROVAL_CONSUMED', approvalId });
    expectOneConsumedAttempt(approvalId);
  });
});

describe('real-run engine refusals: no spawn, no ledger, no bundle (AGX-R4/R5/R8a/R13)', () => {
  async function expectRefused(outcome: RealRunOutcome, code: string, approvalId?: string, consumed = false): Promise<void> {
    expect(outcome).toMatchObject({ kind: 'refused', code });
    expect(invocations(fx)).toHaveLength(0);
    expect(existsSync(fx.ledgerPath)).toBe(false);
    expect(existsSync(fx.bundleDir)).toBe(false);
    if (approvalId !== undefined) expect(markerExists(fx, approvalId)).toBe(consumed);
  }

  it('APPROVAL_MISSING', async () => {
    await expectRefused(await runEngine(fx, 'success', manifestArgs(fx), { approvalPath: undefined }), 'APPROVAL_MISSING');
  });

  it('APPROVAL_INVALID', async () => {
    await writeFile(fx.approvalPath, 'not an approval', 'utf8');
    await expectRefused(await runEngine(fx, 'success', manifestArgs(fx)), 'APPROVAL_INVALID');
  });

  it('APPROVAL_HASH_MISMATCH: the invocation differs from the approved manifest', async () => {
    const approvalId = await mintApproval(fx, manifestArgs(fx));
    const changed = manifestArgs(fx, { extra: ['--max-turns', '9'] });
    await expectRefused(await runEngine(fx, 'success', changed), 'APPROVAL_HASH_MISMATCH', approvalId);
  });

  it('APPROVAL_EXPIRED', async () => {
    const approvalId = await mintApproval(fx, manifestArgs(fx));
    const later = () => new Date(Date.now() + 2 * 60 * 60_000);
    await expectRefused(await runEngine(fx, 'success', manifestArgs(fx), { clock: later }), 'APPROVAL_EXPIRED', approvalId);
  });

  it('APPROVAL_ENGINE_MISMATCH', async () => {
    const args = manifestArgs(fx);
    const { manifest } = await manifestFromFlags(flagValues(args), [fx.requestPath], 'test');
    const other = mintRunApprovalRecord({ ...manifest, engineVersion: '0.0.0-other' });
    await writeFileExclusive(fx.approvalPath, `${JSON.stringify(other)}\n`);
    await expectRefused(await runEngine(fx, 'success', args), 'APPROVAL_ENGINE_MISMATCH', other.approvalId);
  });

  it('APPROVAL_CONSUMED: the one invocation belongs to the first run', async () => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    expect((await runEngine(fx, 'error-result', args)).kind).toBe('worker-failed');
    const second = await runEngine(fx, 'success', args);
    expect(second).toMatchObject({ kind: 'refused', code: 'APPROVAL_CONSUMED', approvalId });
    expect(invocations(fx)).toHaveLength(1);
  });

  it('AUTH_MODE_MISMATCH: a key present under subscription', async () => {
    const approvalId = await mintApproval(fx, manifestArgs(fx));
    const outcome = await runEngine(fx, 'success', manifestArgs(fx), { env: { ANTHROPIC_API_KEY: 'sk-test' } });
    await expectRefused(outcome, 'AUTH_MODE_MISMATCH', approvalId);
    expect(outcome).toMatchObject({ approvalId });
    expect(JSON.stringify(outcome)).not.toContain('sk-test');
  });

  it('AUTH_MODE_MISMATCH: no key under api-key', async () => {
    const args = manifestArgs(fx, { authMode: 'api-key' });
    const approvalId = await mintApproval(fx, args);
    await expectRefused(await runEngine(fx, 'success', args, { env: {} }), 'AUTH_MODE_MISMATCH', approvalId);
  });

  it('TOOLS_UNCONFINED: an approved but unscoped allowlist', async () => {
    const args = manifestArgs(fx, { allowedTools: ['Edit', 'Read(./**)'] });
    const approvalId = await mintApproval(fx, args);
    await expectRefused(await runEngine(fx, 'success', args), 'TOOLS_UNCONFINED', approvalId);
  });

  it('EVIDENCE_DESTINATION_REFUSED: the bundle directory already exists', async () => {
    const approvalId = await mintApproval(fx, manifestArgs(fx));
    await writeFile(fx.bundleDir, 'planted', 'utf8');
    const outcome = await runEngine(fx, 'success', manifestArgs(fx));
    expect(outcome).toMatchObject({ kind: 'refused', code: 'EVIDENCE_DESTINATION_REFUSED', approvalId });
    expect(invocations(fx)).toHaveLength(0);
    expect(existsSync(fx.ledgerPath)).toBe(false);
    expect(markerExists(fx, approvalId)).toBe(false);
    // The planted path is untouched, never overwritten.
    expect(readFileSync(fx.bundleDir, 'utf8')).toBe('planted');
  });

  it('MANIFEST_INVALID: a profile version without a worker milestone', async () => {
    const args = manifestArgs(fx, { profile: 'config-repair' });
    const approvalId = await mintApproval(fx, args);
    await expectRefused(await runEngine(fx, 'success', args), 'MANIFEST_INVALID', approvalId);
  });
});

describe('real-run engine failures after consumption: exactly one outcome each', () => {
  /** Wraps the fake worker so `afterRun` executes once the worker has finished. */
  function withAfterRun(scenario: string, afterRun: () => Promise<void>): RealRunInput['executorFactory'] {
    return (manifest) => {
      const inner = fakeWorkerFactory(fx, scenario)!(manifest);
      return {
        kind: inner.kind,
        run: async (action, ctx) => {
          const run = await inner.run(action, ctx);
          await afterRun();
          return run;
        },
      };
    };
  }

  it('an executor that rejects is engine-error, metered as unknown spend', async () => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    const executorFactory: RealRunInput['executorFactory'] = () => ({
      kind: 'claude-code',
      run: async () => {
        throw new Error('executor exploded');
      },
    });
    const outcome = await runEngine(fx, 'success', args, { executorFactory });
    expect(outcome).toMatchObject({
      kind: 'worker-failed',
      reason: 'engine-error',
      evidence: { stage: 'worker', message: 'executor exploded', spendLedgerWritten: true },
      spend: { costUsd: null, exitClass: 'engine-error' },
    });
    expect(ledgerEntries(fx)).toEqual([expect.objectContaining({ approvalId, costUsd: null, exitClass: 'engine-error' })]);
    expect(markerExists(fx, approvalId)).toBe(true);
  });

  it('a ledger path that appears during the run is evidence-write-failed, with the spend kept', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const outcome = await runEngine(fx, 'success', args, {
      executorFactory: withAfterRun('success', () => writeFile(fx.ledgerPath, 'planted\n', 'utf8')),
    });
    expect(outcome).toMatchObject({ kind: 'worker-failed', reason: 'evidence-write-failed', spend: { exitClass: 'success' } });
    expect(readFileSync(fx.ledgerPath, 'utf8')).toBe('planted\n');
    expect(existsSync(fx.bundleDir)).toBe(false);
    expect(existsSync(scratchRoot(invocations(fx)[0]!))).toBe(false);
  });

  it('the ledger records the worker-reported duration_ms, not the engine timestamp delta', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const outcome = await runEngine(fx, 'success', args);
    expect(outcome).toMatchObject({ kind: 'verified', spend: { durationMs: 19957 } });
    expect(ledgerEntries(fx)[0]).toMatchObject({ durationMs: 19957 });
  });

  it('a verifier that throws is engine-error, keeping the bounded candidate as evidence', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const original = vi.mocked(offlineCommand.verifyCandidateDocument).getMockImplementation()!;
    vi.mocked(offlineCommand.verifyCandidateDocument).mockRejectedValueOnce(new Error('recorder unavailable'));
    try {
      const outcome = await runEngine(fx, 'success', args);
      expect(outcome).toMatchObject({
        kind: 'worker-failed',
        reason: 'engine-error',
        evidence: { stage: 'verify', message: 'recorder unavailable', candidate: { files: { SITE: 'alpha.test\n' } } },
      });
      expect(existsSync(fx.bundleDir)).toBe(false);
      expect(existsSync(scratchRoot(invocations(fx)[0]!))).toBe(false);
    } finally {
      vi.mocked(offlineCommand.verifyCandidateDocument).mockImplementation(original);
    }
  });

  it('a verifier that throws keeps the out-of-scope paths the worker wrote as evidence', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const original = vi.mocked(offlineCommand.verifyCandidateDocument).getMockImplementation()!;
    vi.mocked(offlineCommand.verifyCandidateDocument).mockRejectedValueOnce(new Error('recorder unavailable'));
    try {
      const outcome = await runEngine(fx, 'out-of-scope-write', args);
      expect(outcome).toMatchObject({
        kind: 'worker-failed',
        reason: 'engine-error',
        evidence: { stage: 'verify', outOfScopeChanges: ['other.txt'] },
      });
      expect(existsSync(scratchRoot(invocations(fx)[0]!))).toBe(false);
    } finally {
      vi.mocked(offlineCommand.verifyCandidateDocument).mockImplementation(original);
    }
  });

  it('a cancel that lands after the worker returns is never verified, and no bundle is written', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const caller = new AbortController();
    const outcome = await runEngine(fx, 'success', args, {
      signal: caller.signal,
      executorFactory: withAfterRun('success', async () => caller.abort()),
    });
    expect(outcome).toMatchObject({
      kind: 'worker-failed',
      reason: 'cancel',
      spend: { exitClass: 'success' },
      evidence: { candidate: { files: { SITE: 'alpha.test\n' } } },
    });
    expect(existsSync(fx.bundleDir)).toBe(false);
    expect(ledgerEntries(fx)).toHaveLength(1);
    expect(existsSync(scratchRoot(invocations(fx)[0]!))).toBe(false);
  });

  it('a cancel that lands during verification is never verified, and no bundle is written', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const caller = new AbortController();
    const actual = vi.mocked(offlineCommand.verifyCandidateDocument).getMockImplementation()!;
    vi.mocked(offlineCommand.verifyCandidateDocument).mockImplementationOnce(async (...a) => {
      const bundle = await actual(...a);
      caller.abort();
      return bundle;
    });
    const outcome = await runEngine(fx, 'success', args, { signal: caller.signal });
    expect(outcome).toMatchObject({ kind: 'worker-failed', reason: 'cancel', evidence: { stage: 'verify', accepted: true } });
    expect(existsSync(fx.bundleDir)).toBe(false);
  });

  it('a bundle path that appears during the run is refused, keeping the candidate and decision', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const outcome = await runEngine(fx, 'success', args, {
      executorFactory: withAfterRun('success', () => mkdir(fx.bundleDir).then(() => undefined)),
    });
    expect(outcome).toMatchObject({
      kind: 'worker-failed',
      reason: 'evidence-destination-refused',
      evidence: { accepted: true, candidate: { files: { SITE: 'alpha.test\n' } } },
    });
    expect(ledgerEntries(fx)).toHaveLength(1);
  });

  it('stdout beyond the engine cap is malformed-output even with a valid envelope', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const outcome = await runEngine(fx, 'stdout-flood', args);
    expect(outcome).toMatchObject({ kind: 'worker-failed', reason: 'malformed-output' });
    const evidence = outcome.kind === 'worker-failed' ? outcome.evidence : undefined;
    expect(evidence !== undefined && 'stderrTail' in evidence ? evidence.stderrTail : '').toMatch(/stdout exceeded/);
  });

  it('a descendant that escapes the process group is killed before runRealRun returns', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    try {
      const outcome = await runEngine(fx, 'descendant-escapes-group', args);
      const pid = invocations(fx)[0]?.descendantPid;
      expect(pid).toBeDefined();
      // Dead or a zombie awaiting reaping: it can no longer run.
      let state: string | undefined;
      try {
        state = /^\d+ \(.*\) (\S)/s.exec(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[1];
      } catch {
        // fully reaped
      }
      expect(state === undefined || state === 'Z').toBe(true);
      // It was killed, so the run is judged normally rather than as worker-not-terminated.
      expect(outcome.kind === 'worker-failed' && outcome.reason === 'worker-not-terminated').toBe(false);
    } finally {
      const pid = invocations(fx)[0]?.descendantPid;
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  });
});

describe('captured-base scratch seed', () => {
  function captureOf(owner: PlantedOwner): NonNullable<RealRunInput['capture']> {
    return {
      profileId: owner.profileId,
      commit: owner.commit,
      overlayFiles: owner.overlayFiles,
      identity: owner.identity,
    };
  }

  it('seeds profile id, pinned commit, and overlay bytes, not baseFiles or the owner tree', async () => {
    const owner = plantOwnerRepo(fx, 'clean');
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    const seen: ScratchSeed[] = [];
    let scratchNames: string[] = [];
    let written: { profileId?: string; commit?: string; overlayFiles?: Record<string, string> } = {};
    const outcome = await runEngine(fx, 'success', args, {
      capture: captureOf(owner),
      seedWorktree: async (seed) => {
        seen.push({ profileId: seed.profileId, commit: seed.commit, files: { ...seed.files } });
        const handle = await seedScratchFromCapture(seed);
        written = { profileId: handle.profileId, commit: handle.commit, overlayFiles: handle.overlayFiles };
        scratchNames = readdirSync(handle.worktreePath).filter((name) => name !== '.git').sort();
        return handle;
      },
    });
    expect(seen).toEqual([
      { profileId: owner.profileId, commit: owner.commit, files: owner.overlayFiles },
    ]);
    expect(written).toEqual({ profileId: owner.profileId, commit: owner.commit, overlayFiles: owner.overlayFiles });
    expect(seen[0]!.files).not.toEqual(getCandidateOfflineProfile('config-repair', '2').baseFiles);
    expect(scratchNames).toEqual(['pkg.json']);
    expect(scratchNames).not.toContain('only-in-owner.txt');
    expect(readFileSync(path.join(owner.repo, 'only-in-owner.txt'), 'utf8')).toBe('owner\n');
    expect(outcome).toMatchObject({ kind: 'verified', approvalId, targetRepositoryHonored: false });
    expect(invocations(fx)).toHaveLength(1);
  });

  it.each(['dirty', 'mixed'] as const)('refuses a %s owner worktree with no worker spawn', async (kind) => {
    const owner = plantOwnerRepo(fx, kind);
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    let seeded = false;
    const outcome = await runEngine(fx, 'success', args, {
      capture: captureOf(owner),
      seedWorktree: async (seed) => {
        seeded = true;
        return seedScratchFromCapture(seed);
      },
    });
    expect(seeded).toBe(false);
    expect(outcome).toMatchObject({
      kind: 'worker-failed',
      reason: 'worktree-refused',
      approvalId,
      targetRepositoryHonored: false,
      evidence: { message: `owner worktree is ${kind}` },
    });
    expect(outcome).not.toHaveProperty('spend');
    expect(invocations(fx)).toHaveLength(0);
    expect(existsSync(fx.ledgerPath)).toBe(false);
    expect(existsSync(fx.bundleDir)).toBe(false);
  });
});
