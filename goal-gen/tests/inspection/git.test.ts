/**
 * Tests for backend/src/inspection/git.ts — the metadata-only git plumbing layer. Covers: correct
 * parsing of each named operation against a real materialized fixture repo; that untrusted,
 * shell-metacharacter-laden pathspec input is passed as a literal arg-array element and never
 * shell-interpreted; and that stdout is bounded (OUTPUT_CHAR_CAP) even for a pathologically large
 * git output, so evidence excerpts built on top of this module can never balloon unbounded.
 */
import { spawnSync } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OUTPUT_CHAR_CAP,
  branchList,
  catFileSize,
  catFileType,
  defaultBranch,
  diffNameStatus,
  lsFiles,
  lsTree,
  logSummary,
  remoteGetUrl,
  revParse,
  statusPorcelain,
  symbolicRef,
} from '../../backend/src/inspection/git';
import { initFixtureRepo } from '../fixtures/repositories/init-fixture';
import type { FixtureRepoHandle } from '../fixtures/repositories/init-fixture';

const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

/** Test-only mutation helper (git.ts deliberately has no commit/write wrapper — see its file-top
 *  comment). Commits `-F <file>` rather than `-m <string>` so an arbitrarily large message never
 *  risks the OS argv size limit (ARG_MAX). */
function commitFileAsMessage(cwd: string, messagePath: string): void {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t.local', 'commit', '-q', '--allow-empty', '-F', messagePath],
    { cwd, env: GIT_ENV, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`test setup commit failed: ${r.stderr}`);
}

describe('inspection/git', () => {
  let repo: FixtureRepoHandle | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('resolves HEAD, default branch, and tracked files for a materialized fixture repo', async () => {
    repo = await initFixtureRepo('python-app');
    expect(revParse(repo.dir, 'HEAD')).toBe(repo.headSha);
    expect(symbolicRef(repo.dir, 'HEAD')).toBe('refs/heads/main');
    expect(defaultBranch(repo.dir)).toBe('main');

    const files = lsFiles(repo.dir);
    expect(files).toContain('pyproject.toml');
    expect(files).toContain('tests/test_main.py');
    expect(files).toContain('src/app/main.py');
  });

  it('lsTree reports path/type/hash/size metadata without ever reading blob content', async () => {
    repo = await initFixtureRepo('node-plugin');
    const entries = lsTree(repo.dir, 'HEAD');
    const pkg = entries.find((e) => e.path === 'package.json');
    expect(pkg).toBeDefined();
    expect(pkg?.type).toBe('blob');
    expect(pkg?.hash).toMatch(/^[0-9a-f]{40,64}$/);
    expect(typeof pkg?.size).toBe('number');
    expect(pkg?.size).toBeGreaterThan(0);

    // cat-file -s / -t agree with the ls-tree-reported size/type — same metadata, different command.
    expect(catFileSize(repo.dir, pkg!.hash)).toBe(pkg!.size);
    expect(catFileType(repo.dir, pkg!.hash)).toBe('blob');
  });

  it('scopes lsFiles/lsTree by pathspec and returns [] for a non-matching pathspec', async () => {
    repo = await initFixtureRepo('multi-package-manager');
    expect(lsFiles(repo.dir, { paths: ['go.mod'] })).toEqual(['go.mod']);
    expect(lsFiles(repo.dir, { paths: ['does-not-exist.xyz'] })).toEqual([]);
    expect(lsTree(repo.dir, 'HEAD', { paths: ['does-not-exist.xyz'] })).toEqual([]);
  });

  it('treats a shell-metacharacter-laden pathspec as a literal arg-array element, never shell-interpreted', async () => {
    repo = await initFixtureRepo('injection-attempt');
    const marker = join(tmpdir(), `goal-gen-git-test-no-exec-${process.pid}-${Date.now()}`);
    const adversarial = `$(touch ${marker})\`touch ${marker}\`;touch ${marker}`;

    expect(() => lsFiles(repo!.dir, { paths: [adversarial] })).not.toThrow();
    expect(lsFiles(repo!.dir, { paths: [adversarial] })).toEqual([]);
    expect(() => lsTree(repo!.dir, 'HEAD', { paths: [adversarial] })).not.toThrow();

    // The marker file must never have been created — proves no shell ever interpreted the pathspec.
    await expect(access(marker)).rejects.toThrow();
  });

  it('round-trips a tracked path whose own NAME contains shell metacharacters, as inert data', async () => {
    repo = await initFixtureRepo('injection-attempt');
    const adversarialPath = 'notes-$(fixture).md';

    expect(lsFiles(repo.dir)).toContain(adversarialPath);
    const entries = lsTree(repo.dir, 'HEAD');
    const entry = entries.find((e) => e.path === adversarialPath);
    expect(entry).toBeDefined();
    expect(entry?.type).toBe('blob');
  });

  it('statusPorcelain is empty right after materialization and reflects an untracked file', async () => {
    repo = await initFixtureRepo('no-tests');
    expect(statusPorcelain(repo.dir)).toEqual([]);
    await writeFile(join(repo.dir, 'untracked.txt'), 'fixture', 'utf8');
    const status = statusPorcelain(repo.dir);
    expect(status).toEqual([{ code: '??', path: 'untracked.txt' }]);
  });

  it('diffNameStatus reports paths and change kind (never content) between two commits', async () => {
    repo = await initFixtureRepo('no-tests');
    const before = revParse(repo.dir, 'HEAD')!;
    await writeFile(join(repo.dir, 'src/index.js'), '// fixture: modified for diff test\n', 'utf8');
    spawnSync('git', ['add', '-A'], { cwd: repo.dir, env: GIT_ENV });
    const msgPath = join(tmpdir(), `goal-gen-git-test-diff-msg-${process.pid}-${Date.now()}.txt`);
    await writeFile(msgPath, 'fixture: modify src/index.js\n', 'utf8');
    commitFileAsMessage(repo.dir, msgPath);
    const after = revParse(repo.dir, 'HEAD')!;

    const entries = diffNameStatus(repo.dir, before, after);
    expect(entries).toEqual([{ status: 'M', path: 'src/index.js' }]);
  });

  it('logSummary never invokes -p and stdout is bounded even for a pathologically large commit message', async () => {
    repo = await initFixtureRepo('no-tests');
    const hugeLen = OUTPUT_CHAR_CAP + 1000;
    const msgPath = join(tmpdir(), `goal-gen-git-test-huge-msg-${process.pid}-${Date.now()}.txt`);
    await writeFile(msgPath, 'a'.repeat(hugeLen), 'utf8'); // single line, no trailing newline: %s returns it whole
    commitFileAsMessage(repo.dir, msgPath);

    const summaries = logSummary(repo.dir, { maxCount: 1 });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.subject.length).toBeLessThanOrEqual(OUTPUT_CHAR_CAP);
    expect(summaries[0]!.subject.length).toBeLessThan(hugeLen); // proves it was actually cut, not coincidentally short
  });

  it('branchList includes the fixture default branch; remoteGetUrl is null with no configured remote', async () => {
    repo = await initFixtureRepo('python-app');
    expect(branchList(repo.dir)).toContain('main');
    expect(remoteGetUrl(repo.dir, 'origin')).toBeNull();
  });

  it('revParse/symbolicRef return null for a non-existent ref rather than throwing', async () => {
    repo = await initFixtureRepo('python-app');
    expect(revParse(repo.dir, 'refs/heads/does-not-exist')).toBeNull();
    expect(symbolicRef(repo.dir, 'refs/heads/does-not-exist')).toBeNull();
  });
});
