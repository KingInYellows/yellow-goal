/**
 * Requirement-to-test matrix for `acceptance capture-source` (VS spec CS-01–CS-09).
 * Git object reads only. Checkers are installed. Dirty/untracked source is uninspected
 * except as mutation canaries. CI uses disposable owned git fixtures with known
 * commits/blobs — never a live `main` pin, never a network fetch. Real yellow-goal
 * capture is demonstration evidence, not a CI target.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../backend/src/cli/index';
import { runCommittedSourceCapture } from '../../backend/src/cli/committed-source-command';
import { assertGitReadArgv } from '../../backend/src/cli/committed-source-git';
import {
  getCommittedSourceProfile,
  committedSourceProfileDigest,
} from '../../backend/src/cli/committed-source-profiles';
import { runCandidateOfflineVerify } from '../../backend/src/cli/candidate-offline-command';
import { configRepairCandidates } from '../../backend/src/cli/candidate-offline-profiles';
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
});
