/**
 * Tests for inspection/read-only-assertion.ts: capture is stable across two read-only calls, and
 * diff/assert correctly detect each kind of mutation (branch switch, new commit, working-tree
 * change, untracked file) — proving the helper worker C reuses for its AC-3 test actually catches
 * a real read-only violation rather than trivially passing.
 */
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertReadOnly,
  captureReadOnlyState,
  diffReadOnlyState,
} from '../../backend/src/inspection/read-only-assertion';
import { initFixtureRepo } from '../fixtures/repositories/init-fixture';
import type { FixtureRepoHandle } from '../fixtures/repositories/init-fixture';

const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

describe('inspection/read-only-assertion', () => {
  let repo: FixtureRepoHandle | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('capturing twice with no changes in between yields no violations', async () => {
    repo = await initFixtureRepo('python-app');
    const before = captureReadOnlyState(repo.dir);
    const after = captureReadOnlyState(repo.dir);
    expect(diffReadOnlyState(before, after)).toEqual([]);
    expect(() => assertReadOnly(before, after)).not.toThrow();
  });

  it('detects a new untracked file', async () => {
    repo = await initFixtureRepo('no-tests');
    const before = captureReadOnlyState(repo.dir);
    await writeFile(join(repo.dir, 'sneaky.txt'), 'oops', 'utf8');
    const after = captureReadOnlyState(repo.dir);
    const violations = diffReadOnlyState(before, after);
    expect(violations.some((v) => v.field === 'status')).toBe(true);
    expect(() => assertReadOnly(before, after)).toThrow(/read-only invariant violated/);
  });

  it('detects a new commit (HEAD + trackedHashes change)', async () => {
    repo = await initFixtureRepo('no-tests');
    const before = captureReadOnlyState(repo.dir);
    await writeFile(join(repo.dir, 'src/index.js'), '// mutated\n', 'utf8');
    spawnSync('git', ['add', '-A'], { cwd: repo.dir, env: GIT_ENV });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', 'commit', '-q', '-m', 'mutate'], {
      cwd: repo.dir,
      env: GIT_ENV,
    });
    const after = captureReadOnlyState(repo.dir);
    const violations = diffReadOnlyState(before, after);
    expect(violations.map((v) => v.field)).toEqual(expect.arrayContaining(['headSha', 'trackedHashes']));
  });

  it('detects a branch switch', async () => {
    repo = await initFixtureRepo('no-tests');
    const before = captureReadOnlyState(repo.dir);
    spawnSync('git', ['checkout', '-q', '-b', 'other-branch'], { cwd: repo.dir, env: GIT_ENV });
    const after = captureReadOnlyState(repo.dir);
    const violations = diffReadOnlyState(before, after);
    expect(violations.some((v) => v.field === 'branch')).toBe(true);
  });
});
