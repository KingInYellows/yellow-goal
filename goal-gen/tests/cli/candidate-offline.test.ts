/**
 * Requirement-to-test matrix for `acceptance verify-candidate` / `acceptance reproduce`
 * (VS spec CO-01–CO-10). Candidate documents are FILE-CONTENT only. Recorder is the
 * packed subprocess. Reproduce reruns trusted checks; stored accepted:true is not
 * re-verification.
 */
import { chmodSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../backend/src/cli/index';
import { runCandidateOfflineReproduce, runCandidateOfflineVerify } from '../../backend/src/cli/candidate-offline-command';
import {
  BUNDLE_COMPLETE_MARKER,
  BUNDLE_MANIFEST_NAME,
  persistCandidateBundle,
  readPersistedBundle,
} from '../../backend/src/cli/candidate-offline-bundle';
import {
  configRepairCandidates,
  candidateProfileDigest,
  getCandidateOfflineProfile,
} from '../../backend/src/cli/candidate-offline-profiles';
import { observeFixture, removeObservationRepo } from '../../backend/src/cli/observed-fixture-observer';
import { runObservedFixtureVerify } from '../../backend/src/cli/observed-fixture-command';

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function stdoutText(): string {
  return stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

async function writeCandidate(dir: string, name: string, body: unknown): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, `${JSON.stringify(body)}\n`, 'utf8');
  return filePath;
}

describe('candidate-bound offline milestone', () => {
  const examples = configRepairCandidates();

  it('CO-01/CO-02: engine-owned profile has ≥2 checks; two byte-distinct valid candidates both accept', async () => {
    const profile = getCandidateOfflineProfile('config-repair');
    expect(profile.requiredCheckIds).toEqual(['schema-host', 'site-bind']);
    expect(profile.checks).toHaveLength(2);
    expect(examples.alpha.files['site.json']).not.toBe(examples.beta.files['site.json']);
    expect(examples.alpha.files.SITE).not.toBe(examples.beta.files.SITE);
    const dir = await mkdtemp(path.join(tmpdir(), 'co-valid-'));
    try {
      const alphaPath = await writeCandidate(dir, 'alpha.json', examples.alpha);
      const betaPath = await writeCandidate(dir, 'beta.json', examples.beta);
      const alpha = await runCandidateOfflineVerify(['config-repair', alphaPath, '--json']);
      const beta = await runCandidateOfflineVerify(['config-repair', betaPath, '--json']);
      expect(alpha.output.decision.accepted).toBe(true);
      expect(beta.output.decision.accepted).toBe(true);
      expect(alpha.output.outcomes.map((row) => row.status)).toEqual(['passed', 'passed']);
      expect(beta.output.outcomes.map((row) => row.status)).toEqual(['passed', 'passed']);
      expect(alpha.output.identities.candidateTree).not.toBe(beta.output.identities.candidateTree);
      expect(alpha.output.implementationRevision).toMatch(/^goal-gen@0\.2\.0#[0-9a-f]{64}$/);
      expect(alpha.output.implementationRevision).not.toBe('goal-gen@0.2.0');
      expect(alpha.output.implementationRevision).not.toContain(process.execPath);
      expect(alpha.output.runtime).toEqual({ node: process.version });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-03: failing baseline is a valid negative, not acceptance', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-base-'));
    try {
      const candidatePath = await writeCandidate(dir, 'baseline.json', examples.baseline);
      const result = await runCandidateOfflineVerify(['config-repair', candidatePath, '--json']);
      expect(result.output.outcomes.some((row) => row.status === 'failed')).toBe(true);
      expect(result.output.recorder?.record?.status).toBe('failed');
      expect(result.output.decision.accepted).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-03: incorrect candidate fails required checks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-bad-'));
    try {
      const candidatePath = await writeCandidate(dir, 'incorrect.json', examples.incorrect);
      const result = await runCandidateOfflineVerify(['config-repair', candidatePath, '--json']);
      expect(result.output.decision.accepted).toBe(false);
      expect(result.output.outcomes[0]?.status).toBe('failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-03: extra unauthorized file cannot authorize acceptance', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-extra-'));
    try {
      const candidatePath = await writeCandidate(dir, 'extra.json', examples.extraFile);
      const result = await runCandidateOfflineVerify(['config-repair', candidatePath, '--json']);
      expect(result.output.decision.accepted).toBe(false);
      expect(result.output.decision.reasons.some((reason) => reason.startsWith('unauthorized-path:'))).toBe(true);
      expect(result.output.recorder).toBeNull();
      expect(result.output.outcomes).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-03: self-assert accepted:true in candidate data cannot succeed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-self-'));
    try {
      const candidatePath = await writeCandidate(dir, 'self.json', examples.selfAssert);
      const result = await runCandidateOfflineVerify(['config-repair', candidatePath, '--json']);
      expect(result.output.decision.accepted).toBe(false);
      expect(result.output.decision.reasons.some((reason) => reason.includes('_acceptance.json'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-03: candidate-supplied checker path is unauthorized', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-weaken-'));
    try {
      const candidatePath = await writeCandidate(dir, 'weaken.json', examples.weaken);
      const result = await runCandidateOfflineVerify(['config-repair', candidatePath, '--json']);
      expect(result.output.decision.accepted).toBe(false);
      expect(result.output.decision.reasons.some((reason) => reason.includes('schema-host.mjs'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-04: maxFileBytes counts UTF-8 bytes, not UTF-16 code units', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-bytes-'));
    try {
      const profile = getCandidateOfflineProfile('config-repair');
      const candidatePath = await writeCandidate(dir, 'wide.json', {
        schemaVersion: 'yellow-goal/candidate-file-content/v1',
        files: { 'site.json': 'é'.repeat(profile.maxFileBytes) },
      });
      expect(await main(['acceptance', 'verify-candidate', 'config-repair', candidatePath, '--json'])).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(stdoutText()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-04: prototype-pollution path names are usage errors', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-proto-'));
    try {
      const protoPath = path.join(dir, 'proto.json');
      await writeFile(
        protoPath,
        '{"schemaVersion":"yellow-goal/candidate-file-content/v1","files":{"__proto__":"nope\\n"}}\n',
        'utf8',
      );
      expect(await main(['acceptance', 'verify-candidate', 'config-repair', protoPath, '--json'])).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(stdoutText()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-04: traversal and absolute paths are usage errors', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-path-'));
    try {
      const traversal = await writeCandidate(dir, 'traversal.json', {
        schemaVersion: 'yellow-goal/candidate-file-content/v1',
        files: { '../secret': 'nope\n' },
      });
      expect(await main(['acceptance', 'verify-candidate', 'config-repair', traversal, '--json'])).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(stdoutText()).toBe('');
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      const nestedGit = await writeCandidate(dir, 'nested-git.json', {
        schemaVersion: 'yellow-goal/candidate-file-content/v1',
        files: { 'nested/.git/config': 'nope\n' },
      });
      expect(await main(['acceptance', 'verify-candidate', 'config-repair', nestedGit, '--json'])).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(stdoutText()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-05/CO-06: durable bundle survives temp deletion and directory move; reproduce reruns checks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-bundle-'));
    const candidateDir = path.join(dir, 'candidate');
    const bundleDir = path.join(dir, 'bundle');
    const moved = path.join(dir, 'moved-bundle');
    mkdirSync(candidateDir);
    try {
      const candidatePath = await writeCandidate(candidateDir, 'alpha.json', examples.alpha);
      const verified = await runCandidateOfflineVerify([
        'config-repair',
        candidatePath,
        '--json',
        '--bundle-dir',
        bundleDir,
      ]);
      expect(verified.output.decision.accepted).toBe(true);
      expect(readFileSync(path.join(bundleDir, BUNDLE_COMPLETE_MARKER), 'utf8')).toMatch(/candidate-offline-milestone/);
      const firstBase = verified.output.identities.baseRevision;
      await rm(candidateDir, { recursive: true, force: true });
      const { renameSync } = await import('node:fs');
      renameSync(bundleDir, moved);
      const reproduced = await runCandidateOfflineReproduce([moved, '--json']);
      expect(reproduced.output.decision.accepted).toBe(true);
      expect(reproduced.output.identities.baseRevision).toBe(firstBase);
      expect(reproduced.output.outcomes.map((row) => row.status)).toEqual(['passed', 'passed']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-07: missing COMPLETE cannot stale-succeed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-incomplete-'));
    try {
      const candidatePath = await writeCandidate(dir, 'alpha.json', examples.alpha);
      const bundleDir = path.join(dir, 'bundle');
      const verified = await runCandidateOfflineVerify(['config-repair', candidatePath, '--json']);
      persistCandidateBundle(bundleDir, verified.output);
      unlinkSync(path.join(bundleDir, BUNDLE_COMPLETE_MARKER));
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(stdoutText()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-07: COMPLETE must be a regular file with the schema marker bytes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-marker-'));
    try {
      const candidatePath = await writeCandidate(dir, 'alpha.json', examples.alpha);
      const bundleDir = path.join(dir, 'bundle');
      await runCandidateOfflineVerify(['config-repair', candidatePath, '--json', '--bundle-dir', bundleDir]);
      const marker = path.join(bundleDir, BUNDLE_COMPLETE_MARKER);
      unlinkSync(marker);
      mkdirSync(marker);
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(stdoutText()).toBe('');
      await rm(marker, { recursive: true, force: true });
      writeFileSync(marker, 'mutated-marker\n', 'utf8');
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(stdoutText()).toBe('');
      unlinkSync(marker);
      const decoy = path.join(dir, 'decoy-complete');
      writeFileSync(decoy, 'yellow-goal/candidate-offline-milestone/v1\n', 'utf8');
      symlinkSync(decoy, marker);
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(stdoutText()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-07: mutating stored accepted:true is ignored; reproduce reruns checks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-stale-'));
    try {
      const candidatePath = await writeCandidate(dir, 'alpha.json', examples.alpha);
      const bundleDir = path.join(dir, 'bundle');
      await runCandidateOfflineVerify(['config-repair', candidatePath, '--json', '--bundle-dir', bundleDir]);
      const stored = readPersistedBundle(bundleDir);
      stored.decision = { accepted: true, reasons: ['forged'] };
      stored.candidate = examples.incorrect;
      const { unlinkSync } = await import('node:fs');
      unlinkSync(path.join(bundleDir, BUNDLE_COMPLETE_MARKER));
      unlinkSync(path.join(bundleDir, BUNDLE_MANIFEST_NAME));
      persistCandidateBundle(bundleDir, stored);
      const reproduced = await runCandidateOfflineReproduce([bundleDir, '--json']);
      expect(reproduced.output.decision.accepted).toBe(false);
      expect(reproduced.output.decision.reasons).not.toContain('forged');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-07: candidate profile digest covers trusted invocation, awaitReady, and document limits', () => {
    const profile = getCandidateOfflineProfile('config-repair');
    const baseline = candidateProfileDigest(profile);
    const argvShift = {
      ...profile,
      checks: profile.checks.map((check) => ({ ...check, argv: [...check.argv, '--flag'] })),
    };
    expect(candidateProfileDigest(argvShift)).not.toBe(baseline);
    const readyShift = {
      ...profile,
      checks: profile.checks.map((check) => ({ ...check, awaitReady: true })),
    };
    expect(candidateProfileDigest(readyShift)).not.toBe(baseline);
    const execPathShift = {
      ...profile,
      checks: profile.checks.map((check) => ({
        ...check,
        argv: ['/other/install/bin/node', ...check.argv.slice(1)],
      })),
    };
    expect(candidateProfileDigest(execPathShift)).toBe(baseline);
    const filesShift = { ...profile, maxFiles: profile.maxFiles - 1 };
    expect(candidateProfileDigest(filesShift)).not.toBe(baseline);
    const bytesShift = { ...profile, maxFileBytes: profile.maxFileBytes - 1 };
    expect(candidateProfileDigest(bytesShift)).not.toBe(baseline);
    const depthShift = { ...profile, maxDepth: profile.maxDepth - 1 };
    expect(candidateProfileDigest(depthShift)).not.toBe(baseline);
  });

  it('CO-07: profile digest mismatch cannot succeed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-digest-'));
    try {
      const candidatePath = await writeCandidate(dir, 'alpha.json', examples.alpha);
      const bundleDir = path.join(dir, 'bundle');
      await runCandidateOfflineVerify(['config-repair', candidatePath, '--json', '--bundle-dir', bundleDir]);
      const stored = readPersistedBundle(bundleDir);
      stored.profile.digest = '0'.repeat(64);
      const { unlinkSync } = await import('node:fs');
      unlinkSync(path.join(bundleDir, BUNDLE_COMPLETE_MARKER));
      unlinkSync(path.join(bundleDir, BUNDLE_MANIFEST_NAME));
      persistCandidateBundle(bundleDir, stored);
      const reproduced = await runCandidateOfflineReproduce([bundleDir, '--json']);
      expect(reproduced.output.decision.accepted).toBe(false);
      expect(reproduced.output.decision.reasons).toContain('profile-digest-mismatch');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-05: non-empty bundle-dir is refused', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-nonempty-'));
    try {
      writeFileSync(path.join(dir, 'keep.txt'), 'keep\n');
      const candidatePath = await writeCandidate(dir, 'alpha.json', examples.alpha);
      expect(
        await main(['acceptance', 'verify-candidate', 'config-repair', candidatePath, '--json', '--bundle-dir', dir]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CO-09: synthetic git base is reproducible for the same recipe', async () => {
    const profile = getCandidateOfflineProfile('config-repair');
    const first = await observeFixture(profile, { files: examples.alpha.files });
    const second = await observeFixture(profile, { files: examples.alpha.files });
    try {
      expect(first.baseRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(first.baseRevision).toBe(second.baseRevision);
      expect(first.candidateTree).toBe(second.candidateTree);
    } finally {
      await removeObservationRepo(first.cleanupDir);
      await removeObservationRepo(second.cleanupDir);
    }
  });

  it('usage: unknown profile or missing args exits 2', async () => {
    expect(await main(['acceptance', 'verify-candidate'])).toBe(2);
    expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
    expect(stdoutText()).toBe('');
  });

  it('usage: missing candidate file exits 2', async () => {
    expect(await main(['acceptance', 'verify-candidate', 'config-repair', '/no/such/candidate.json', '--json'])).toBe(2);
    expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
    expect(stdoutText()).toBe('');
  });

  it('I/O: unreadable candidate path exits 1 IO_ERROR', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-io-'));
    try {
      const candidatePath = path.join(dir, 'locked.json');
      await writeCandidate(dir, 'locked.json', examples.alpha);
      chmodSync(candidatePath, 0o000);
      expect(await main(['acceptance', 'verify-candidate', 'config-repair', candidatePath, '--json'])).toBe(1);
      expect(JSON.parse(stderrText()).error.code).toBe('IO_ERROR');
      expect(stdoutText()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('layer-3c lifecycle proofs via verify-fixture', () => {
  it('timeout-ignore records SIGKILL', async () => {
    const result = await runObservedFixtureVerify(['timeout-ignore', 'case', '--json']);
    expect(result.output.outcomes[0]?.signal).toBe('SIGKILL');
    expect(result.output.decision.accepted).toBe(false);
  });

  it('timeout-exit-0 omits recorder', async () => {
    const result = await runObservedFixtureVerify(['timeout-probe', 'case', '--json']);
    expect(result.output.recorder).toBeNull();
    expect(result.output.outcomes[0]?.reason).toBe('deadline-exceeded');
  });

  it('noisy output is blocked', async () => {
    const result = await runObservedFixtureVerify(['noisy-output', 'case', '--json']);
    expect(result.output.outcomes[0]?.outputTruncated).toBe(true);
  });

  it('spawn failure is not-run', async () => {
    const result = await runObservedFixtureVerify(['spawn-missing', 'case', '--json']);
    expect(result.output.outcomes[0]?.status).toBe('not-run');
  });

  it('leftover mutation stops later checks', async () => {
    const result = await runObservedFixtureVerify(['leftover-stops-later', 'case', '--json']);
    expect(result.output.outcomes[1]?.status).toBe('not-run');
  });

  it('awaitReady exit before ready is readiness-failed', async () => {
    const result = await runObservedFixtureVerify(['ready-exit', 'case', '--json']);
    expect(result.output.outcomes[0]?.reason).toBe('readiness-failed');
    expect(result.output.decision.accepted).toBe(false);
  });
});
