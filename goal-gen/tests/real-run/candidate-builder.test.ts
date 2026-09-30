/**
 * AGX-R17: the candidate is built from the allowed paths only, byte-exact, and an entry that is
 * not a small regular UTF-8 file is refused without being read.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCandidateOfflineProfile, type CandidateOfflineProfile } from '../../backend/src/cli/candidate-offline-profiles';
import { createWorktree, type WorktreeHandle } from '../../backend/src/executors/worktree';
import { buildRealRunCandidate } from '../../backend/src/real-run/candidate-builder';

const profile = getCandidateOfflineProfile('config-repair', '2');
let worktree: WorktreeHandle;
const at = (relative: string): string => path.join(worktree.worktreePath, relative);

beforeEach(async () => {
  worktree = await createWorktree({ seedFiles: profile.baseFiles, prefix: 'goal-gen-candidate-builder-' });
});

afterEach(async () => {
  await worktree.cleanup();
});

describe('buildRealRunCandidate', () => {
  it('reads exactly the allowed paths, byte for byte, including a leading BOM', () => {
    writeFileSync(at('site.json'), '﻿{"host":"alpha.test"}\n');
    writeFileSync(at('keep.txt'), 'changed outside the allowed paths\n');
    const built = buildRealRunCandidate(worktree.worktreePath, profile, worktree.gitDir);
    expect(built).toMatchObject({ ok: true, outOfScopeChanges: ['keep.txt'] });
    if (!built.ok) return;
    expect(Object.keys(built.candidate.files).sort()).toEqual(['SITE', 'site.json']);
    expect(built.candidate.files['site.json']).toBe('﻿{"host":"alpha.test"}\n');
  });

  it('omits a missing allowed path and leaves the judgement to the verifier', () => {
    rmSync(at('SITE'));
    const built = buildRealRunCandidate(worktree.worktreePath, profile, worktree.gitDir);
    expect(built.ok && Object.keys(built.candidate.files)).toEqual(['site.json']);
  });

  it('accepts a file of exactly maxFileBytes and refuses one byte more', () => {
    writeFileSync(at('site.json'), 'x'.repeat(profile.maxFileBytes));
    expect(buildRealRunCandidate(worktree.worktreePath, profile, worktree.gitDir).ok).toBe(true);
    writeFileSync(at('site.json'), 'x'.repeat(profile.maxFileBytes + 1));
    expect(buildRealRunCandidate(worktree.worktreePath, profile, worktree.gitDir)).toMatchObject({
      ok: false,
      reason: 'unsafe-allowed-path',
      evidence: { path: 'site.json', kind: 'oversize' },
    });
  });

  it.each<[string, () => void]>([
    ['directory', () => {
      rmSync(at('site.json'));
      mkdirSync(at('site.json'));
    }],
    ['symlink', () => {
      rmSync(at('site.json'));
      symlinkSync('/etc/hostname', at('site.json'));
    }],
    ['fifo', () => {
      rmSync(at('site.json'));
      expect(spawnSync('mkfifo', [at('site.json')]).status).toBe(0);
    }],
  ])('refuses a %s at an allowed path without reading it', (kind, plant) => {
    plant();
    expect(buildRealRunCandidate(worktree.worktreePath, profile, worktree.gitDir)).toMatchObject({
      ok: false,
      reason: 'unsafe-allowed-path',
      evidence: { path: 'site.json', kind },
    });
  });

  it('refuses a non-UTF-8 allowed file', () => {
    writeFileSync(at('SITE'), Buffer.from([0xff, 0xfe, 0x00]));
    expect(buildRealRunCandidate(worktree.worktreePath, profile, worktree.gitDir)).toMatchObject({
      ok: false,
      reason: 'non-utf8-candidate',
      evidence: { path: 'SITE' },
    });
  });

  it('refuses a nested allowed path whose parent segment is a file', () => {
    const nested: CandidateOfflineProfile = { ...profile, allowedPaths: ['conf/site.json'] };
    writeFileSync(at('conf'), 'not a directory\n');
    expect(buildRealRunCandidate(worktree.worktreePath, nested, worktree.gitDir)).toMatchObject({
      ok: false,
      evidence: { path: 'conf/site.json', kind: 'not-a-directory' },
    });
  });

  it('lists the new name when a worker renames an allowed path', () => {
    expect(spawnSync('git', ['mv', 'site.json', 'other.txt'], { cwd: worktree.worktreePath }).status).toBe(0);
    const built = buildRealRunCandidate(worktree.worktreePath, profile, worktree.gitDir);
    expect(built).toMatchObject({ ok: true, outOfScopeChanges: ['other.txt'] });
  });

  it('names the files inside an ignored directory, not the directory', () => {
    writeFileSync(at('.gitignore'), '*\n');
    mkdirSync(at('foo'));
    writeFileSync(at('foo/bar.txt'), 'hidden\n');
    const built = buildRealRunCandidate(worktree.worktreePath, profile, worktree.gitDir);
    expect(built).toMatchObject({ ok: true });
    if (!built.ok) return;
    expect(built.outOfScopeChanges).toContain('foo/bar.txt');
    expect(built.outOfScopeChanges).not.toContain('foo/');
  });

  it('reports out-of-scope changes as unavailable (null) when git cannot list them', () => {
    const built = buildRealRunCandidate(worktree.worktreePath, profile, path.join(worktree.root, 'no-such-git-dir'));
    expect(built).toMatchObject({ ok: true, outOfScopeChanges: null });
  });
});
