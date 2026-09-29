/**
 * AGX-R7: `config-repair` profile versions. The v1 digest is pinned as a literal captured from
 * `main` before the v2 profile landed — bundles are made in tmpdirs, so there is no golden bundle,
 * and this constant is the proof that v1 stays byte-identical and existing VS bundles reproduce.
 * Never update the constant to make this test pass: a change here means v1 drifted.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLE_MANIFEST_NAME } from '../../backend/src/cli/candidate-offline-bundle';
import { runCandidateOfflineReproduce, runCandidateOfflineVerify } from '../../backend/src/cli/candidate-offline-command';
import {
  candidateProfileDigest,
  configRepairCandidates,
  getCandidateOfflineProfile,
} from '../../backend/src/cli/candidate-offline-profiles';

/** `candidateProfileDigest(config-repair v1)` on main @ 1aa34ce (2026-09-29). */
const CONFIG_REPAIR_V1_DIGEST = '01544cd5473cf372a265988f070d59927ce45ca3e214bda651dffb06f0bc843c';

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

describe('config-repair profile versions (AGX-R7)', () => {
  it('v1 digest is pinned', () => {
    const v1 = getCandidateOfflineProfile('config-repair');
    expect(v1.version).toBe('1');
    expect(candidateProfileDigest(v1)).toBe(CONFIG_REPAIR_V1_DIGEST);
  });

  it('lookup is keyed by id and version; the default version is 1', () => {
    expect(getCandidateOfflineProfile('config-repair', '1')).toEqual(getCandidateOfflineProfile('config-repair'));
    const v2 = getCandidateOfflineProfile('config-repair', '2');
    expect(v2.version).toBe('2');
    expect(v2.milestoneText).toMatch(/site\.json/);
    expect(() => getCandidateOfflineProfile('config-repair', '9')).toThrow(/unknown candidate-offline profile version: config-repair@9/);
    expect(() => getCandidateOfflineProfile('nope', '1')).toThrow(/unknown candidate-offline profile: nope/);
  });

  it('a v1 bundle records the pinned digest and reproduces accepted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-v1-bundle-'));
    try {
      const candidatePath = path.join(dir, 'alpha.json');
      await writeFile(candidatePath, `${JSON.stringify(configRepairCandidates().alpha)}\n`, 'utf8');
      const bundleDir = path.join(dir, 'bundle');
      const verified = await runCandidateOfflineVerify(['config-repair', candidatePath, '--json', '--bundle-dir', bundleDir]);
      expect(verified.output.profile).toEqual({ id: 'config-repair', version: '1', digest: CONFIG_REPAIR_V1_DIGEST });
      const reproduced = await runCandidateOfflineReproduce([bundleDir, '--json']);
      expect(reproduced.output.decision.accepted).toBe(true);
      expect(reproduced.output.profile.version).toBe('1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reproduce resolves the recorded version, not the default', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-v2-bundle-'));
    try {
      const candidatePath = path.join(dir, 'alpha.json');
      await writeFile(candidatePath, `${JSON.stringify(configRepairCandidates().alpha)}\n`, 'utf8');
      const bundleDir = path.join(dir, 'bundle');
      const verified = await runCandidateOfflineVerify([
        'config-repair',
        candidatePath,
        '--profile-version',
        '2',
        '--json',
        '--bundle-dir',
        bundleDir,
      ]);
      const v2Digest = candidateProfileDigest(getCandidateOfflineProfile('config-repair', '2'));
      expect(verified.output.profile).toEqual({ id: 'config-repair', version: '2', digest: v2Digest });
      const reproduced = await runCandidateOfflineReproduce([bundleDir, '--json']);
      expect(reproduced.output.decision.accepted).toBe(true);
      expect(reproduced.output.profile).toEqual({ id: 'config-repair', version: '2', digest: v2Digest });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('v2 digest covers the milestone text and differs from v1', () => {
    const v2 = getCandidateOfflineProfile('config-repair', '2');
    const v2Digest = candidateProfileDigest(v2);
    expect(v2Digest).not.toBe(CONFIG_REPAIR_V1_DIGEST);
    expect(candidateProfileDigest({ ...v2, milestoneText: `${v2.milestoneText} ` })).not.toBe(v2Digest);
  });

  it('verify-candidate rejects an unknown profile version as a usage error', async () => {
    await expect(
      runCandidateOfflineVerify(['config-repair', '/nonexistent.json', '--profile-version', '9', '--json']),
    ).rejects.toThrow(/unknown candidate-offline profile: config-repair@9 \(profiles: config-repair@1\|config-repair@2\)/);
    await expect(runCandidateOfflineVerify(['config-repair', '/nonexistent.json', '--profile-version'])).rejects.toThrow(
      /--profile-version requires a version/,
    );
  });

  it('reproduce refuses a bundle whose profile has no version', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'co-noversion-'));
    try {
      const candidatePath = path.join(dir, 'alpha.json');
      await writeFile(candidatePath, `${JSON.stringify(configRepairCandidates().alpha)}\n`, 'utf8');
      const bundleDir = path.join(dir, 'bundle');
      await runCandidateOfflineVerify(['config-repair', candidatePath, '--json', '--bundle-dir', bundleDir]);
      const manifestPath = path.join(bundleDir, BUNDLE_MANIFEST_NAME);
      const stored = JSON.parse(readFileSync(manifestPath, 'utf8')) as { profile: Record<string, unknown> };
      delete stored.profile.version;
      writeFileSync(manifestPath, `${JSON.stringify(stored)}\n`, 'utf8');
      await expect(runCandidateOfflineReproduce([bundleDir, '--json'])).rejects.toThrow(/bundle profile has no version/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
