/**
 * Requirement-to-test matrix for `acceptance capture-source` and captured-base
 * replay (VS spec CS-01–CS-12).
 * Git object reads only. Checkers are installed. Dirty/untracked source is uninspected
 * except as mutation canaries. CI uses disposable owned git fixtures with known
 * commits/blobs — never a live `main` pin, never a network fetch. Real yellow-goal
 * capture is demonstration evidence, not a CI target.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../backend/src/cli/index';
import { runCommittedSourceCapture } from '../../backend/src/cli/committed-source-command';
import {
  assertGitReadArgv,
  snapshotFiles,
  type CapturedBlobWithBytes,
} from '../../backend/src/cli/committed-source-git';
import { ObservedFixtureError } from '../../backend/src/cli/errors';
import {
  CAPTURE_MAX_FILE_BYTES,
  CAPTURE_MAX_FILES,
  getCommittedSourceProfile,
  committedSourceProfileDigest,
} from '../../backend/src/cli/committed-source-profiles';
import { runCandidateOfflineVerify } from '../../backend/src/cli/candidate-offline-command';
import {
  CANDIDATE_MAX_FILE_BYTES,
  configRepairCandidates,
} from '../../backend/src/cli/candidate-offline-profiles';
import { runObservedFixtureVerify } from '../../backend/src/cli/observed-fixture-command';
import { sha256File, sha256Hex } from '../../backend/src/cli/implementation-revision';

/** Synthetic object name for usage-error cases. Not a live yellow-goal commit. */
const UNUSED_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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

function stderrText(): string {
  return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

function stdoutText(): string {
  return stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

function extraFieldManifest(): string {
  return `${JSON.stringify(
    {
      name: 'goal-gen',
      version: '0.2.0',
      bin: { 'goal-gen': 'bin/goal-gen.mjs' },
      description: 'captured-base extra-field alternative',
    },
    null,
    2,
  )}\n`;
}

function mismatchedManifest(): string {
  return `${JSON.stringify(
    {
      name: 'goal-gen',
      version: '9.9.9',
      bin: { 'goal-gen': 'bin/goal-gen.mjs' },
    },
    null,
    2,
  )}\n`;
}

function fileContentCandidate(files: Record<string, string>): string {
  return `${JSON.stringify({
    schemaVersion: 'yellow-goal/candidate-file-content/v1',
    files,
  })}\n`;
}

function gitIsolated(dir: string, args: string[]): void {
  const home = path.join(dir, '.home');
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, '.gitconfig'),
    '[user]\n\tname = capture-test\n\temail = capture-test@invalid\n[commit]\n\tgpgsign = false\n',
    'utf8',
  );
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'capture-test',
      GIT_AUTHOR_EMAIL: 'capture-test@invalid',
      GIT_COMMITTER_NAME: 'capture-test',
      GIT_COMMITTER_EMAIL: 'capture-test@invalid',
      PATH: process.env.PATH,
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function gitOut(dir: string, args: string[]): string {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function applyFiles(dir: string, files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
    if (relative.endsWith('.mjs')) chmodSync(full, 0o755);
  }
}

function commitAll(dir: string, message: string): string {
  gitIsolated(dir, ['add', '-A']);
  gitIsolated(dir, ['commit', '-q', '-m', message]);
  const commit = gitOut(dir, ['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`fixture commit is not a full object ID: ${commit}`);
  return commit;
}

async function fixtureRepo(files: Record<string, string>): Promise<{ dir: string; commit: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cs-repo-'));
  gitIsolated(dir, ['init', '-q']);
  applyFiles(dir, files);
  return { dir, commit: commitAll(dir, 'fixture') };
}

type KnownBlob = {
  path: string;
  mode: string;
  type: 'blob';
  gitSha: string;
  sha256: string;
  byteLength: number;
};

function knownBlobs(dir: string, commit: string, files: Record<string, string>): KnownBlob[] {
  return Object.entries(files).map(([relative, contents]) => {
    const line = gitOut(dir, ['ls-tree', '--full-tree', commit, '--', relative]);
    const match = /^(?<mode>[0-7]{6}) blob (?<sha>[0-9a-f]{40})\t(?<path>.+)$/.exec(line);
    if (match === null || match.groups === undefined) {
      throw new Error(`expected blob ls-tree for ${relative}: ${line}`);
    }
    const { mode, sha, path: listed } = match.groups;
    if (mode === undefined || sha === undefined || listed !== relative) {
      throw new Error(`ls-tree mismatch for ${relative}: ${line}`);
    }
    const sizeText = gitOut(dir, ['cat-file', '-s', sha]);
    const byteLength = Number.parseInt(sizeText, 10);
    return {
      path: relative,
      mode,
      type: 'blob',
      gitSha: sha,
      sha256: sha256Hex(contents),
      byteLength,
    };
  });
}

function gitFileHash(dir: string, gitPathName: string): string {
  const gitDir = gitOut(dir, ['rev-parse', '--absolute-git-dir']);
  const rel = spawnSync('git', ['--git-dir', gitDir, 'rev-parse', '--git-path', gitPathName], {
    encoding: 'utf8',
  }).stdout.trim();
  return sha256File(path.resolve(gitDir, rel));
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = path.join(root, name);
    const stat = lstatSync(full);
    if (stat.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function objectStoreFingerprint(dir: string): string {
  const gitDir = gitOut(dir, ['rev-parse', '--absolute-git-dir']);
  const objects = path.join(gitDir, 'objects');
  const rows = walkFiles(objects)
    .map((full) => `${path.relative(objects, full)}:${lstatSync(full).size}:${sha256File(full)}`)
    .sort();
  return sha256Hex(rows.join('\n'));
}

async function partialClone(src: string): Promise<string> {
  gitIsolated(src, ['config', 'uploadpack.allowFilter', 'true']);
  const dest = await mkdtemp(path.join(tmpdir(), 'cs-partial-'));
  gitIsolated(dest, ['init', '-q']);
  gitIsolated(dest, ['remote', 'add', 'origin', src]);
  gitIsolated(dest, ['fetch', '--filter=blob:none', 'origin']);
  return dest;
}

const coherentFiles = {
  'goal-gen/package.json': `${JSON.stringify({
    name: 'goal-gen',
    version: '0.2.0',
    bin: { 'goal-gen': 'bin/goal-gen.mjs' },
  }, null, 2)}\n`,
  'goal-gen/package-lock.json': `${JSON.stringify({
    name: 'goal-gen',
    version: '0.2.0',
    lockfileVersion: 3,
    packages: { '': { name: 'goal-gen', version: '0.2.0' } },
  }, null, 2)}\n`,
  'goal-gen/bin/goal-gen.mjs': '#!/usr/bin/env node\nexport {};\n',
};

describe('committed-source capture', () => {
  it('CS-01: engine-owned profile has ≥2 checks and a fixed allowlist', () => {
    const profile = getCommittedSourceProfile('package-manifest-lockfile');
    expect(profile.requiredCheckIds).toEqual(['manifest-lock-agreement', 'packaging-entry']);
    expect(profile.checks).toHaveLength(2);
    expect(profile.allowedPaths).toEqual([
      'goal-gen/package.json',
      'goal-gen/package-lock.json',
      'goal-gen/bin/goal-gen.mjs',
    ]);
    expect(committedSourceProfileDigest(profile)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('CS-02/CS-03: capture an owned fixture at a pinned commit, not live HEAD', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    try {
      const expected = knownBlobs(dir, commit, coherentFiles);
      applyFiles(dir, {
        ...coherentFiles,
        'goal-gen/package-lock.json': `${JSON.stringify({
          name: 'goal-gen',
          version: '9.9.9',
          lockfileVersion: 3,
          packages: { '': { name: 'goal-gen', version: '9.9.9' } },
        }, null, 2)}\n`,
      });
      const later = commitAll(dir, 'later-incoherent');
      expect(later).not.toBe(commit);
      expect(gitOut(dir, ['rev-parse', 'HEAD'])).toBe(later);

      const result = await runCommittedSourceCapture([
        'package-manifest-lockfile',
        dir,
        commit,
        '--json',
      ]);
      expect(result.output.schemaVersion).toBe('yellow-goal/committed-source-capture/v1');
      expect(result.output.source.requestedRev).toBe(commit);
      expect(result.output.source.commit).toBe(commit);
      expect(result.output.source.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(result.output.source.commit).not.toBe(later);
      expect(result.output.source.captured).toEqual(expected);
      expect(result.output.source.missing).toEqual([]);
      expect(result.output.outcomes.map((row) => row.status)).toEqual(['passed', 'passed']);
      expect(result.output.outcomes.map((row) => row.id)).toEqual([
        'manifest-lock-agreement',
        'packaging-entry',
      ]);
      expect(result.output.decision.accepted).toBe(true);
      expect(result.output.recorder).toBeNull();
      expect(result.output.exclusions).toEqual(['dirty', 'staged', 'untracked', 'ignored']);
      expect(result.output.sourceIntegrity.mutated).toBe(false);
      expect(result.output.implementationRevision).toMatch(/^goal-gen@0\.2\.0#[0-9a-f]{64}$/);
      expect(gitOut(dir, ['rev-parse', 'HEAD'])).toBe(later);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CS-05: untracked canary and HEAD/index bytes survive a fixture capture', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const canaryPath = path.join(dir, `.capture-canary-${process.pid}`);
    try {
      await writeFile(canaryPath, `canary-${Date.now()}\n`, 'utf8');
      const headBefore = gitFileHash(dir, 'HEAD');
      const indexBefore = gitFileHash(dir, 'index');
      const headShaBefore = gitOut(dir, ['rev-parse', 'HEAD']);
      const result = await runCommittedSourceCapture([
        'package-manifest-lockfile',
        dir,
        commit,
        '--json',
      ]);
      expect(result.output.decision.accepted).toBe(true);
      expect(result.output.source.commit).toBe(commit);
      expect(result.output.sourceIntegrity.mutated).toBe(false);
      const { readFileSync } = await import('node:fs');
      expect(readFileSync(canaryPath, 'utf8')).toMatch(/^canary-/);
      expect(gitOut(dir, ['rev-parse', 'HEAD'])).toBe(headShaBefore);
      expect(gitFileHash(dir, 'HEAD')).toBe(headBefore);
      expect(gitFileHash(dir, 'index')).toBe(indexBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CS-04: incoherent lockfile is an honest negative', async () => {
    const { dir, commit } = await fixtureRepo({
      ...coherentFiles,
      'goal-gen/package-lock.json': `${JSON.stringify({
        name: 'goal-gen',
        version: '9.9.9',
        lockfileVersion: 3,
        packages: { '': { name: 'goal-gen', version: '9.9.9' } },
      }, null, 2)}\n`,
    });
    try {
      const result = await runCommittedSourceCapture(['package-manifest-lockfile', dir, commit, '--json']);
      expect(result.output.decision.accepted).toBe(false);
      expect(result.output.outcomes.find((row) => row.id === 'manifest-lock-agreement')?.status).toBe('failed');
      expect(result.output.outcomes.find((row) => row.id === 'packaging-entry')?.status).toBe('passed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CS-05: dirty tracked file in a fixture repo survives capture', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const dirty = path.join(dir, 'goal-gen/package.json');
    try {
      writeFileSync(dirty, `${coherentFiles['goal-gen/package.json']}\n// dirty\n`, 'utf8');
      const result = await runCommittedSourceCapture(['package-manifest-lockfile', dir, commit, '--json']);
      expect(result.output.decision.accepted).toBe(true);
      const { readFileSync } = await import('node:fs');
      expect(readFileSync(dirty, 'utf8')).toContain('// dirty');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CS-06: git helper refuses write verbs', () => {
    expect(() => assertGitReadArgv(['checkout', 'HEAD'])).toThrow(/refuses verb: checkout/);
    expect(() => assertGitReadArgv(['update-index', '--add'])).toThrow(/refuses verb: update-index/);
    expect(() => assertGitReadArgv(['-c', 'core.hooksPath=/dev/null', 'ls-tree', 'HEAD'])).not.toThrow();
  });

  it('CS-08: existing acceptance verbs still work', async () => {
    const examples = configRepairCandidates();
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-preserve-'));
    try {
      const candidatePath = path.join(dir, 'alpha.json');
      await writeFile(candidatePath, `${JSON.stringify(examples.alpha)}\n`, 'utf8');
      const candidate = await runCandidateOfflineVerify(['config-repair', candidatePath, '--json']);
      expect(candidate.output.decision.accepted).toBe(true);
      const observed = await runObservedFixtureVerify(['status-probe', 'correct', '--json']);
      expect(observed.output.decision.accepted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('usage: unknown profile or URL repo exits 2', async () => {
    expect(await main(['acceptance', 'capture-source'])).toBe(2);
    expect(JSON.parse(stderrText().trim().split('\n').at(-1)!).error.code).toBe('USAGE_ERROR');
    stderrSpy.mockClear();
    expect(await main(['acceptance', 'capture-source', 'nope', '/tmp', UNUSED_COMMIT, '--json'])).toBe(2);
    expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
    stderrSpy.mockClear();
    expect(
      await main(['acceptance', 'capture-source', 'package-manifest-lockfile', 'https://example.invalid/repo.git', UNUSED_COMMIT]),
    ).toBe(2);
    expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
  });

  it('fails closed on missing local objects without writing the source object store or contacting origin', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    let partial: string | undefined;
    try {
      partial = await partialClone(dir);
      const before = objectStoreFingerprint(partial);
      await expect(
        runCommittedSourceCapture(['package-manifest-lockfile', partial, commit, '--json']),
      ).rejects.toSatisfy((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        return err instanceof ObservedFixtureError
          && err.code === 'GIT_READ_FAILED'
          && !/Failed to connect/i.test(message);
      });
      expect(objectStoreFingerprint(partial)).toBe(before);
      gitIsolated(partial, ['remote', 'set-url', 'origin', 'http://127.0.0.1:1/does-not-exist.git']);
      // Git 2.43 reports "lazy fetching disabled"; 2.55 reports "could not get object info".
      // Fail-closed is GIT_READ_FAILED without contacting origin, not one stderr phrase.
      await expect(
        runCommittedSourceCapture(['package-manifest-lockfile', partial, commit, '--json']),
      ).rejects.toSatisfy((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        return err instanceof ObservedFixtureError
          && err.code === 'GIT_READ_FAILED'
          && !/Failed to connect/i.test(message);
      });
      expect(objectStoreFingerprint(partial)).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
      if (partial !== undefined) await rm(partial, { recursive: true, force: true });
    }
  });

  it('reads the pinned commit tree, not refs/replace/', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    try {
      const expected = knownBlobs(dir, commit, coherentFiles);
      applyFiles(dir, {
        ...coherentFiles,
        'goal-gen/package.json': `${JSON.stringify({
          name: 'goal-gen',
          version: '9.9.9',
          bin: { 'goal-gen': 'bin/goal-gen.mjs' },
        }, null, 2)}\n`,
      });
      const replacement = commitAll(dir, 'replacement');
      gitIsolated(dir, ['replace', commit, replacement]);
      const result = await runCommittedSourceCapture(['package-manifest-lockfile', dir, commit, '--json']);
      expect(result.output.source.commit).toBe(commit);
      expect(result.output.source.captured).toEqual(expected);
      expect(result.output.decision.accepted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects --bundle-dir inside the source worktree or git directory', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const nested = path.join(dir, 'evidence');
    const gitNested = path.join(dir, '.git', 'evidence');
    try {
      expect(await main([
        'acceptance',
        'capture-source',
        'package-manifest-lockfile',
        dir,
        commit,
        '--bundle-dir',
        nested,
        '--json',
      ])).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(nested, 'manifest.json'))).toBe(false);
      stderrSpy.mockClear();
      expect(await main([
        'acceptance',
        'capture-source',
        'package-manifest-lockfile',
        dir,
        commit,
        '--bundle-dir',
        gitNested,
        '--json',
      ])).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(gitNested, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(gitNested, 'COMPLETE'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hashes and materializes original blob bytes rather than UTF-8 U+FFFD', async () => {
    const invalid = Buffer.from([0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]);
    expect(invalid.toString('utf8')).toContain('\uFFFD');
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-repo-'));
    try {
      gitIsolated(dir, ['init', '-q']);
      applyFiles(dir, {
        'goal-gen/package-lock.json': coherentFiles['goal-gen/package-lock.json'],
        'goal-gen/bin/goal-gen.mjs': coherentFiles['goal-gen/bin/goal-gen.mjs'],
      });
      mkdirSync(path.join(dir, 'goal-gen'), { recursive: true });
      writeFileSync(path.join(dir, 'goal-gen/package.json'), invalid);
      const commit = commitAll(dir, 'invalid-utf8');
      const result = await runCommittedSourceCapture(['package-manifest-lockfile', dir, commit, '--json']);
      const captured = result.output.source.captured.find((row) => row.path === 'goal-gen/package.json');
      expect(captured?.byteLength).toBe(invalid.length);
      expect(captured?.sha256).toBe(sha256Hex(invalid));
      expect(captured?.sha256).not.toBe(sha256Hex(invalid.toString('utf8')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('snapshotFiles keeps original Buffer bytes', () => {
    const contents = Buffer.from([0xff, 0xfe, 0x00]);
    const blob: CapturedBlobWithBytes = {
      path: 'goal-gen/package.json',
      mode: '100644',
      type: 'blob',
      gitSha: 'a'.repeat(40),
      sha256: sha256Hex(contents),
      byteLength: contents.length,
      contents,
    };
    expect(snapshotFiles([blob])['goal-gen/package.json']).toEqual(contents);
    expect(Buffer.isBuffer(snapshotFiles([blob])['goal-gen/package.json'])).toBe(true);
  });

  it('keeps the revision whitelist; leading dash and NUL stay rejected', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    try {
      gitIsolated(dir, ['branch', 'feat/ok', commit]);
      const named = await runCommittedSourceCapture(['package-manifest-lockfile', dir, 'feat/ok', '--json']);
      expect(named.output.source.commit).toBe(commit);
      expect(await main([
        'acceptance',
        'capture-source',
        'package-manifest-lockfile',
        dir,
        '-evil',
        '--json',
      ])).toBe(2);
      expect(JSON.parse(stderrText()).error.message).toMatch(/unsafe revision/);
      stderrSpy.mockClear();
      expect(await main([
        'acceptance',
        'capture-source',
        'package-manifest-lockfile',
        dir,
        'release/v1.0+meta',
        '--json',
      ])).toBe(2);
      expect(JSON.parse(stderrText()).error.message).toMatch(/unsafe revision/);
      stderrSpy.mockClear();
      expect(await main([
        'acceptance',
        'capture-source',
        'package-manifest-lockfile',
        dir,
        'v1.0@meta',
        '--json',
      ])).toBe(2);
      expect(JSON.parse(stderrText()).error.message).toMatch(/unsafe revision/);
      stderrSpy.mockClear();
      expect(await main([
        'acceptance',
        'capture-source',
        'package-manifest-lockfile',
        dir,
        'abc\0def',
        '--json',
      ])).toBe(2);
      expect(JSON.parse(stderrText()).error.message).toMatch(/unsafe revision/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CS-06: --no-replace-objects remains a read-only git option', () => {
    expect(() =>
      assertGitReadArgv(['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', 'ls-tree', 'HEAD']),
    ).not.toThrow();
  });

  it('CS-10: capture --bundle-dir persists selected bytes; moved reproduce reruns checks', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const expected = knownBlobs(dir, commit, coherentFiles);
    const bundleDir = await mkdtemp(path.join(tmpdir(), 'cs-persist-'));
    try {
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          bundleDir,
        ]),
      ).toBe(0);
      const captured = JSON.parse(stdoutText()) as {
        source: { selected: { path: string; mode: string; sha256: string; byteLength: number }[]; captured: KnownBlob[] };
        decision: { accepted: boolean };
      };
      expect(captured.decision.accepted).toBe(true);
      expect(readFileSync(path.join(bundleDir, 'COMPLETE'), 'utf8')).toBe('yellow-goal/committed-source-capture/v1\n');
      for (const row of expected) {
        const blobPath = path.join(bundleDir, 'blobs', row.path);
        const bytes = readFileSync(blobPath);
        expect(bytes.length).toBe(row.byteLength);
        expect(sha256Hex(bytes)).toBe(row.sha256);
        const selected = captured.source.selected.find((item) => item.path === row.path);
        expect(selected).toMatchObject({
          path: row.path,
          mode: row.mode,
          sha256: row.sha256,
          byteLength: row.byteLength,
        });
        expect(captured.source.captured.find((item) => item.path === row.path)?.gitSha).toBe(row.gitSha);
      }
      const moved = `${bundleDir}-moved`;
      renameSync(bundleDir, moved);
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', moved, '--json'])).toBe(0);
      const reproduced = JSON.parse(stdoutText()) as {
        schemaVersion: string;
        decision: { accepted: boolean };
        outcomes: { id: string; status: string }[];
        source: { overlay: null };
      };
      expect(reproduced.schemaVersion).toBe('yellow-goal/committed-source-capture/v1');
      expect(reproduced.decision.accepted).toBe(true);
      expect(reproduced.outcomes.map((row) => row.status)).toEqual(['passed', 'passed']);
      expect(reproduced.source.overlay).toBeNull();
      await rm(moved, { recursive: true, force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
      await rm(`${bundleDir}-moved`, { recursive: true, force: true });
    }
  });

  it('CS-11: FILE-CONTENT overlay extra-field alternative and metadata reject', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const expected = knownBlobs(dir, commit, coherentFiles);
    const bundleDir = await mkdtemp(path.join(tmpdir(), 'cs-overlay-base-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-overlay-work-'));
    try {
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          bundleDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      const rejectPath = path.join(work, 'reject.json');
      await writeFile(
        extraPath,
        fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }),
        'utf8',
      );
      await writeFile(
        rejectPath,
        fileContentCandidate({ 'goal-gen/package.json': mismatchedManifest() }),
        'utf8',
      );
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          bundleDir,
          '--json',
        ]),
      ).toBe(0);
      const extra = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean };
        outcomes: { id: string; status: string }[];
        source: {
          captured: KnownBlob[];
          selected: { path: string; sha256: string; mode: string }[];
          overlay: { files: Record<string, string> };
        };
      };
      expect(extra.decision.accepted).toBe(true);
      expect(extra.outcomes.map((row) => row.status)).toEqual(['passed', 'passed']);
      expect(extra.source.overlay.files['goal-gen/package.json']).toBe(extraFieldManifest());
      expect(extra.source.captured.find((row) => row.path === 'goal-gen/package.json')?.gitSha).toBe(
        expected.find((row) => row.path === 'goal-gen/package.json')?.gitSha,
      );
      expect(extra.source.selected.find((row) => row.path === 'goal-gen/package.json')?.sha256).toBe(
        sha256Hex(extraFieldManifest()),
      );
      expect(extra.source.selected.find((row) => row.path === 'goal-gen/package.json')?.mode).toBe('100644');
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          rejectPath,
          '--from-capture',
          bundleDir,
          '--json',
        ]),
      ).toBe(0);
      const rejected = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean };
        outcomes: { id: string; status: string }[];
      };
      expect(rejected.decision.accepted).toBe(false);
      expect(rejected.outcomes.find((row) => row.id === 'manifest-lock-agreement')?.status).toBe('failed');
      expect(rejected.outcomes.find((row) => row.id === 'packaging-entry')?.status).toBe('passed');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('CS-12: unauthorized extra files and mutated bindings cannot authorize; source unmodified', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const canaryPath = path.join(dir, `.capture-canary-${process.pid}`);
    const bundleDir = await mkdtemp(path.join(tmpdir(), 'cs-trust-base-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-trust-work-'));
    try {
      await writeFile(canaryPath, `canary-${Date.now()}\n`, 'utf8');
      const headBefore = gitFileHash(dir, 'HEAD');
      const indexBefore = gitFileHash(dir, 'index');
      const headShaBefore = gitOut(dir, ['rev-parse', 'HEAD']);
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          bundleDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(
        extraPath,
        fileContentCandidate({
          'goal-gen/package.json': coherentFiles['goal-gen/package.json'],
          'goal-gen/extra.txt': 'unauthorized\n',
        }),
        'utf8',
      );
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          bundleDir,
          '--json',
        ]),
      ).toBe(0);
      const unauthorized = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
        outcomes: unknown[];
      };
      expect(unauthorized.decision.accepted).toBe(false);
      expect(unauthorized.decision.reasons).toEqual(['unauthorized-path:goal-gen/extra.txt']);
      expect(unauthorized.outcomes).toEqual([]);
      const manifestPath = path.join(bundleDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        bindings: { id: string; command: string; cwd: string }[];
        decision: { accepted: boolean; reasons: string[] };
      };
      manifest.bindings = [{ id: 'manifest-lock-agreement', command: 'forged-binding', cwd: '.' }];
      manifest.decision = { accepted: false, reasons: ['forged'] };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(0);
      const reproduced = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
        outcomes: { id: string; status: string; command: string }[];
        bindings: { command: string }[];
      };
      expect(reproduced.decision.accepted).toBe(true);
      expect(reproduced.decision.reasons).not.toContain('forged');
      expect(reproduced.outcomes.map((row) => row.status)).toEqual(['passed', 'passed']);
      expect(reproduced.outcomes.every((row) => !row.command.includes('forged'))).toBe(true);
      expect(reproduced.bindings.every((row) => row.command !== 'forged-binding')).toBe(true);
      expect(readFileSync(canaryPath, 'utf8')).toMatch(/^canary-/);
      expect(gitOut(dir, ['rev-parse', 'HEAD'])).toBe(headShaBefore);
      expect(gitFileHash(dir, 'HEAD')).toBe(headBefore);
      expect(gitFileHash(dir, 'index')).toBe(indexBefore);
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'config-repair',
          extraPath,
          '--from-capture',
          bundleDir,
          '--json',
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      unlinkSync(path.join(bundleDir, 'blobs', 'goal-gen/package.json'));
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects tampered extra source.selected paths before snapshot', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const bundleDir = await mkdtemp(path.join(tmpdir(), 'cs-extra-selected-'));
    try {
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          bundleDir,
        ]),
      ).toBe(0);
      const extra = Buffer.from('tampered extra\n');
      const manifestPath = path.join(bundleDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        source: { selected: { path: string; mode: string; sha256: string; byteLength: number }[] };
      };
      manifest.source.selected.push({
        path: 'goal-gen/notes.md',
        mode: '100644',
        sha256: sha256Hex(extra),
        byteLength: extra.length,
      });
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      writeFileSync(path.join(bundleDir, 'blobs/goal-gen/notes.md'), extra);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/notes\.md/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate source.selected paths before reading blobs', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const bundleDir = await mkdtemp(path.join(tmpdir(), 'cs-dup-selected-'));
    try {
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          bundleDir,
        ]),
      ).toBe(0);
      const manifestPath = path.join(bundleDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        source: { selected: { path: string; mode: string; sha256: string; byteLength: number }[] };
      };
      const first = manifest.source.selected[0];
      expect(first).toBeDefined();
      expect(manifest.source.selected.length + 1).toBeLessThanOrEqual(CAPTURE_MAX_FILES);
      manifest.source.selected.push({ ...first! });
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/duplicate selected blob path/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
    }
  });

  it('rejects source.selected longer than maxFiles before reading blobs', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const bundleDir = await mkdtemp(path.join(tmpdir(), 'cs-maxfiles-selected-'));
    try {
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          bundleDir,
        ]),
      ).toBe(0);
      const manifestPath = path.join(bundleDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        source: { selected: { path: string; mode: string; sha256: string; byteLength: number }[] };
      };
      const first = manifest.source.selected[0];
      expect(first).toBeDefined();
      manifest.source.selected = Array.from({ length: CAPTURE_MAX_FILES + 1 }, () => ({ ...first! }));
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/maxFiles/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
    }
  });

  it('rejects --bundle-dir when the path segment starts with .. but is not parent traversal', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const dotDotBundle = path.join(dir, '..bundle');
    const dotDotCacheChild = path.join(dir, '..cache', 'nested-bundle');
    const canaryPath = path.join(dir, `.capture-canary-${process.pid}`);
    try {
      mkdirSync(path.join(dir, '..cache'), { recursive: true });
      mkdirSync(dotDotBundle, { recursive: true });
      await writeFile(canaryPath, `canary-${Date.now()}\n`, 'utf8');
      const headBefore = gitFileHash(dir, 'HEAD');
      const indexBefore = gitFileHash(dir, 'index');

      for (const bundleDir of [dotDotBundle, dotDotCacheChild]) {
        stderrSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'capture-source',
            'package-manifest-lockfile',
            dir,
            commit,
            '--json',
            '--bundle-dir',
            bundleDir,
          ]),
        ).toBe(2);
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
      }

      expect(readdirSync(dotDotBundle)).toEqual([]);
      expect(readdirSync(path.join(dir, '..cache'))).toEqual([]);
      expect(readFileSync(canaryPath, 'utf8')).toMatch(/^canary-/);
      expect(gitFileHash(dir, 'HEAD')).toBe(headBefore);
      expect(gitFileHash(dir, 'index')).toBe(indexBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects --bundle-dir via a symlink ancestor into the source worktree', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const outside = await mkdtemp(path.join(tmpdir(), 'cs-symlink-out-'));
    const canaryPath = path.join(dir, `.capture-canary-${process.pid}`);
    try {
      await writeFile(canaryPath, `canary-${Date.now()}\n`, 'utf8');
      const headBefore = gitFileHash(dir, 'HEAD');
      const indexBefore = gitFileHash(dir, 'index');
      const link = path.join(outside, 'into-source');
      symlinkSync(dir, link);
      const nested = path.join(link, 'nested-bundle');
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          nested,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(dir, 'nested-bundle'))).toBe(false);
      expect(existsSync(nested)).toBe(false);
      expect(readFileSync(canaryPath, 'utf8')).toMatch(/^canary-/);
      expect(gitFileHash(dir, 'HEAD')).toBe(headBefore);
      expect(gitFileHash(dir, 'index')).toBe(indexBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('clamps --from-capture candidate files to 3c maxFileBytes', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const bundleDir = await mkdtemp(path.join(tmpdir(), 'cs-overlay-size-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-overlay-size-work-'));
    try {
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          bundleDir,
        ]),
      ).toBe(0);
      const largePkg = `${JSON.stringify(
        {
          name: 'goal-gen',
          version: '0.2.0',
          bin: { 'goal-gen': 'bin/goal-gen.mjs' },
          description: 'x'.repeat(20 * 1024),
        },
        null,
        2,
      )}\n`;
      expect(Buffer.byteLength(largePkg, 'utf8')).toBeGreaterThan(CANDIDATE_MAX_FILE_BYTES);
      expect(Buffer.byteLength(largePkg, 'utf8')).toBeLessThan(CAPTURE_MAX_FILE_BYTES);
      const candPath = path.join(work, 'large.json');
      await writeFile(candPath, fileContentCandidate({ 'goal-gen/package.json': largePkg }), 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          candPath,
          '--from-capture',
          bundleDir,
          '--json',
        ]),
      ).toBe(2);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(JSON.parse(stderrText()).error.message).toMatch(/maxFileBytes/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('treats COMPLETE without the trailing newline as incomplete', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const bundleDir = await mkdtemp(path.join(tmpdir(), 'cs-complete-trunc-'));
    try {
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          bundleDir,
        ]),
      ).toBe(0);
      const marker = path.join(bundleDir, 'COMPLETE');
      writeFileSync(marker, 'yellow-goal/committed-source-capture/v1');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
    }
  });

  it('rejects persisted blobs over maxFileBytes before allocating contents', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const bundleDir = await mkdtemp(path.join(tmpdir(), 'cs-blob-cap-'));
    try {
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          bundleDir,
        ]),
      ).toBe(0);
      const huge = Buffer.alloc(CAPTURE_MAX_FILE_BYTES + 1, 0x61);
      const blobPath = path.join(bundleDir, 'blobs/goal-gen/package.json');
      writeFileSync(blobPath, huge);
      const manifestPath = path.join(bundleDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        source: { selected: { path: string; sha256: string; byteLength: number }[] };
      };
      const selected = manifest.source.selected.find((row) => row.path === 'goal-gen/package.json');
      expect(selected).toBeDefined();
      selected!.byteLength = huge.length;
      selected!.sha256 = sha256Hex(huge);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(JSON.parse(stderrText()).error.message).toMatch(/maxFileBytes/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
    }
  });
});
