/**
 * Requirement-to-test matrix for `acceptance capture-source` and captured-base
 * replay (VS spec CS-01–CS-14).
 * Git object reads only. Checkers are installed. Dirty/untracked source is uninspected
 * except as mutation canaries. CI uses disposable owned git fixtures with known
 * commits/blobs — never a live `main` pin, never a network fetch. Real yellow-goal
 * capture is demonstration evidence, not a CI target.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../backend/src/cli/index';
import { runCommittedSourceCapture } from '../../backend/src/cli/committed-source-command';
import {
  CAPTURE_MANIFEST_MAX_BYTES,
  libcPathFromProcMaps,
  openOrMkdirHeldPersistChild,
  persistCommittedSourceBundle,
  persistRenameNoReplaceChild,
  readPersistedCommittedSourceBundle,
  resolveProcessLibcPath,
  rollbackCreatedPersistDirectories,
} from '../../backend/src/cli/committed-source-bundle';
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
import * as committedSourceProfiles from '../../backend/src/cli/committed-source-profiles';
import { runCandidateOfflineVerify } from '../../backend/src/cli/candidate-offline-command';
import {
  CANDIDATE_MAX_FILE_BYTES,
  CANDIDATE_MAX_FILES,
  configRepairCandidates,
} from '../../backend/src/cli/candidate-offline-profiles';
import { runObservedFixtureVerify } from '../../backend/src/cli/observed-fixture-command';
import { gitBlobSha1, sha256File, sha256Hex } from '../../backend/src/cli/implementation-revision';

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

function copyCaptureTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const stat = lstatSync(from);
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true });
    } else {
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from));
    }
  }
}

function startHeldDestMoveIntoSourceWorker(
  dest: string,
  stolen: string,
): { worker: Worker; readyWait: Promise<void>; flipped: () => boolean; err: () => unknown } {
  let flipped = false;
  let workerErr: unknown;
  const worker = new Worker(
    `
    import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, renameSync } from 'node:fs';
    import { parentPort, workerData } from 'node:worker_threads';
    const { dest, stolen } = workerData;
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0);
    let heldFd;
    try {
      heldFd = openSync(dest, flags);
    } catch (err) {
      parentPort.postMessage(String(err));
      throw err;
    }
    parentPort.postMessage('ready');
    const destHasPersistChild = () => {
      try {
        for (const name of readdirSync(dest)) {
          if (name === 'blobs' || name === 'manifest.json' || name === 'COMPLETE' || name === 'COMPLETE.tmp') {
            return true;
          }
        }
      } catch { /* dest may already be stolen */ }
      return existsSync(dest + '/blobs') || existsSync(dest + '/COMPLETE') || existsSync(dest + '/COMPLETE.tmp');
    };
    try {
      for (;;) {
        if (destHasPersistChild()) {
          try {
            renameSync(dest, stolen);
            mkdirSync(dest);
            parentPort.postMessage('flipped');
          } catch (err) {
            parentPort.postMessage(String(err));
          }
          break;
        }
      }
    } finally {
      try { closeSync(heldFd); } catch { /* already closed */ }
    }
    `,
    { eval: true, workerData: { dest, stolen } },
  );
  let resolveReady!: () => void;
  const readyWait = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  worker.on('message', (msg: string) => {
    if (msg === 'ready') {
      resolveReady();
      return;
    }
    if (msg === 'flipped') {
      flipped = true;
      return;
    }
    workerErr = msg;
    resolveReady();
  });
  worker.once('error', (err) => {
    workerErr = err;
    resolveReady();
  });
  return {
    worker,
    readyWait,
    flipped: () => flipped,
    err: () => workerErr,
  };
}

function startHeldDestEmptySwapWorker(
  dest: string,
  aside: string,
): { worker: Worker; readyWait: Promise<void>; flipped: () => boolean; err: () => unknown } {
  let flipped = false;
  let workerErr: unknown;
  const worker = new Worker(
    `
    import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, renameSync } from 'node:fs';
    import { parentPort, workerData } from 'node:worker_threads';
    const { dest, aside } = workerData;
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0);
    let heldFd;
    try {
      heldFd = openSync(dest, flags);
    } catch (err) {
      parentPort.postMessage(String(err));
      throw err;
    }
    const held = fstatSync(heldFd);
    parentPort.postMessage('ready');
    const destHasPersistChild = () => {
      try {
        for (const name of readdirSync(dest)) {
          if (name === 'blobs' || name === 'manifest.json' || name === 'COMPLETE' || name === 'COMPLETE.tmp') {
            return true;
          }
        }
      } catch { /* dest may already be aside */ }
      return existsSync(dest + '/blobs') || existsSync(dest + '/COMPLETE') || existsSync(dest + '/COMPLETE.tmp');
    };
    try {
      for (;;) {
        let extraDestFd = false;
        try {
          for (const fd of readdirSync('/proc/self/fd')) {
            if (fd === String(heldFd)) continue;
            const n = Number(fd);
            if (!Number.isInteger(n)) continue;
            let st;
            try { st = fstatSync(n); } catch { continue; }
            if (st.isDirectory() && st.dev === held.dev && st.ino === held.ino) {
              extraDestFd = true;
              break;
            }
          }
        } catch { /* proc may flicker */ }
        if (extraDestFd || destHasPersistChild()) {
          try {
            renameSync(dest, aside);
            mkdirSync(dest);
            parentPort.postMessage('flipped');
          } catch (err) {
            parentPort.postMessage(String(err));
          }
          break;
        }
      }
    } finally {
      try { closeSync(heldFd); } catch { /* already closed */ }
    }
    `,
    { eval: true, workerData: { dest, aside } },
  );
  let resolveReady!: () => void;
  const readyWait = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  worker.on('message', (msg: string) => {
    if (msg === 'ready') {
      resolveReady();
      return;
    }
    if (msg === 'flipped') {
      flipped = true;
      return;
    }
    workerErr = msg;
    resolveReady();
  });
  worker.once('error', (err) => {
    workerErr = err;
    resolveReady();
  });
  return {
    worker,
    readyWait,
    flipped: () => flipped,
    err: () => workerErr,
  };
}

function startHeldDestChildrenStealWorker(
  dest: string,
  stolenManifest: string,
  stolenBlobs: string,
): { worker: Worker; readyWait: Promise<void>; flipped: () => boolean; err: () => unknown } {
  let flipped = false;
  let workerErr: unknown;
  const worker = new Worker(
    `
    import { closeSync, constants, existsSync, openSync, readdirSync, renameSync } from 'node:fs';
    import { parentPort, workerData } from 'node:worker_threads';
    const { dest, stolenManifest, stolenBlobs } = workerData;
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0);
    const deadline = Date.now() + 5000;
    let heldFd;
    try {
      heldFd = openSync(dest, flags);
    } catch (err) {
      parentPort.postMessage(String(err));
      throw err;
    }
    parentPort.postMessage('ready');
    const destHasWrittenChildren = () => {
      try {
        const names = new Set(readdirSync(dest));
        return names.has('COMPLETE') || (names.has('manifest.json') && names.has('blobs'));
      } catch {
        return false;
      }
    };
    try {
      // Dest-dir pathname is not reopened after children exist. Steal dest
      // children once persist has written them (COMPLETE or destFd children),
      // with a bounded wait so this cannot hang on a missing dest-dir open.
      let stole = false;
      while (Date.now() < deadline) {
        if (!destHasWrittenChildren()) continue;
        try {
          if (existsSync(dest + '/manifest.json')) {
            renameSync(dest + '/manifest.json', stolenManifest);
          }
          if (existsSync(dest + '/blobs')) {
            renameSync(dest + '/blobs', stolenBlobs);
          }
          stole = true;
          parentPort.postMessage('flipped');
        } catch (err) {
          parentPort.postMessage(String(err));
        }
        break;
      }
      if (!stole) {
        parentPort.postMessage('timeout waiting for dest children');
      }
    } finally {
      try { closeSync(heldFd); } catch { /* already closed */ }
    }
    `,
    { eval: true, workerData: { dest, stolenManifest, stolenBlobs } },
  );
  let resolveReady!: () => void;
  const readyWait = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  worker.on('message', (msg: string) => {
    if (msg === 'ready') {
      resolveReady();
      return;
    }
    if (msg === 'flipped') {
      flipped = true;
      return;
    }
    workerErr = msg;
    resolveReady();
  });
  worker.once('error', (err) => {
    workerErr = err;
    resolveReady();
  });
  return {
    worker,
    readyWait,
    flipped: () => flipped,
    err: () => workerErr,
  };
}

function startStashMidMoveIntoSourceWorker(
  stash: string,
  stolen: string,
): { worker: Worker; readyWait: Promise<void>; flipped: () => boolean; err: () => unknown } {
  let flipped = false;
  let workerErr: unknown;
  const worker = new Worker(
    `
    import { existsSync, renameSync } from 'node:fs';
    import { parentPort, workerData } from 'node:worker_threads';
    const { stash, stolen } = workerData;
    const deadline = Date.now() + 5000;
    parentPort.postMessage('ready');
    const mid = stash + '/mid';
    let stole = false;
    while (Date.now() < deadline) {
      if (!existsSync(mid)) continue;
      try {
        renameSync(stash, stolen);
        stole = true;
        parentPort.postMessage('flipped');
      } catch (err) {
        parentPort.postMessage(String(err));
      }
      break;
    }
    if (!stole) {
      parentPort.postMessage('timeout waiting for stash/mid');
    }
    `,
    { eval: true, workerData: { stash, stolen } },
  );
  let resolveReady!: () => void;
  const readyWait = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  worker.on('message', (msg: string) => {
    if (msg === 'ready') {
      resolveReady();
      return;
    }
    if (msg === 'flipped') {
      flipped = true;
      return;
    }
    workerErr = msg;
    resolveReady();
  });
  worker.once('error', (err) => {
    workerErr = err;
    resolveReady();
  });
  return {
    worker,
    readyWait,
    flipped: () => flipped,
    err: () => workerErr,
  };
}

function fixtureIdentity(dir: string): {
  repoPath: string;
  gitDir: string;
  commonGitDir: string;
  worktree: string;
} {
  const gitDir = gitOut(dir, ['rev-parse', '--absolute-git-dir']);
  const commonReported = gitOut(dir, ['rev-parse', '--git-common-dir']);
  return {
    repoPath: gitOut(dir, ['rev-parse', '--show-toplevel']),
    gitDir,
    commonGitDir: path.isAbsolute(commonReported) ? commonReported : path.resolve(dir, commonReported),
    worktree: gitOut(dir, ['rev-parse', '--show-toplevel']),
  };
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

  it('refuses capture --bundle-dir inside a checkout when repo is that checkout .git directory', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const evidence = path.join(dir, 'evidence');
    try {
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          path.join(dir, '.git'),
          commit,
          '--json',
          '--bundle-dir',
          evidence,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(evidence, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(evidence, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(evidence, 'blobs'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects --bundle-dir inside a linked worktree common git directory', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const linked = path.join(tmpdir(), `cs-linked-wt-${process.pid}-${Date.now()}`);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-linked-cap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-linked-work-'));
    try {
      gitIsolated(dir, ['worktree', 'add', '--detach', linked]);
      const gitDir = gitOut(linked, ['rev-parse', '--absolute-git-dir']);
      const commonRaw = gitOut(linked, ['rev-parse', '--git-common-dir']);
      const commonDir = path.isAbsolute(commonRaw)
        ? path.resolve(commonRaw)
        : path.resolve(linked, commonRaw);
      expect(gitDir).toMatch(/[\\/]\.git[\\/]worktrees[\\/]/);
      expect(path.resolve(commonDir)).toBe(path.resolve(dir, '.git'));
      const evidence = path.join(dir, '.git', 'evidence');
      expect(path.relative(gitDir, evidence).startsWith('..')).toBe(true);

      const gitFilesBefore = walkFiles(path.join(dir, '.git')).sort();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          linked,
          commit,
          '--json',
          '--bundle-dir',
          evidence,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(evidence, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(evidence, 'COMPLETE'))).toBe(false);
      expect(walkFiles(path.join(dir, '.git')).sort()).toEqual(gitFilesBefore);

      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          linked,
          commit,
          '--json',
          '--bundle-dir',
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          evidence,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(evidence, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(evidence, 'COMPLETE'))).toBe(false);
      expect(walkFiles(path.join(dir, '.git')).sort()).toEqual(gitFilesBefore);
    } finally {
      spawnSync('git', ['-C', dir, 'worktree', 'remove', '--force', linked], { encoding: 'utf8' });
      await rm(linked, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
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

  it('applies recorded 100644/100755 to checker snapshot filesystem modes before checks', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-snap-mode-cap-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-snap-mode-overlay-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-snap-mode-work-'));
    const probeDir = await mkdtemp(path.join(tmpdir(), 'cs-snap-mode-probe-'));
    const probeFile = path.join(probeDir, 'modes.json');
    const probeScript = path.join(probeDir, 'record-snapshot-mode.mjs');
    const installed = getCommittedSourceProfile('package-manifest-lockfile');
    const packaging = installed.checks.find((check) => check.id === 'packaging-entry');
    if (packaging === undefined) throw new Error('expected packaging-entry check');
    writeFileSync(
      probeScript,
      `${[
        "import { lstatSync, writeFileSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        "import path from 'node:path';",
        `const probe = ${JSON.stringify(probeFile)};`,
        `const orig = ${JSON.stringify(packaging.argv)};`,
        "const execPath = path.join(process.cwd(), 'goal-gen/bin/goal-gen.mjs');",
        "const pkgPath = path.join(process.cwd(), 'goal-gen/package.json');",
        'writeFileSync(probe, JSON.stringify({',
        '  exec: lstatSync(execPath).mode & 0o777,',
        '  pkg: lstatSync(pkgPath).mode & 0o777,',
        '}));',
        'const result = spawnSync(orig[0], orig.slice(1), { cwd: process.cwd(), env: process.env });',
        'process.exit(result.status === null ? 1 : result.status);',
        '',
      ].join('\n')}`,
    );
    const spy = vi.spyOn(committedSourceProfiles, 'getCommittedSourceProfile');
    spy.mockImplementation((_id) => ({
      ...installed,
      checks: installed.checks.map((check) =>
        check.id === 'packaging-entry'
          ? { ...check, argv: [process.execPath, probeScript] }
          : check,
      ),
    }));
    const readProbedModes = (): { exec: number; pkg: number } =>
      JSON.parse(readFileSync(probeFile, 'utf8')) as { exec: number; pkg: number };
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
          captureDir,
        ]),
      ).toBe(0);
      const captured = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean };
        source: { selected: { path: string; mode: string }[] };
      };
      expect(captured.decision.accepted).toBe(true);
      expect(captured.source.selected.find((row) => row.path === 'goal-gen/bin/goal-gen.mjs')?.mode).toBe(
        '100755',
      );
      expect(captured.source.selected.find((row) => row.path === 'goal-gen/package.json')?.mode).toBe(
        '100644',
      );
      expect(readProbedModes()).toEqual({ exec: 0o755, pkg: 0o644 });

      unlinkSync(probeFile);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', captureDir, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(readProbedModes()).toEqual({ exec: 0o755, pkg: 0o644 });

      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      unlinkSync(probeFile);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(readProbedModes()).toEqual({ exec: 0o755, pkg: 0o644 });
    } finally {
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(probeDir, { recursive: true, force: true });
    }
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

  it('CS-13: unauthorized overlay bundle replay stays rejected after relocation', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const bundleDir = await mkdtemp(path.join(tmpdir(), 'cs-unauth-overlay-base-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-unauth-overlay-work-'));
    const rejectBundleDir = await mkdtemp(path.join(tmpdir(), 'cs-unauth-overlay-reject-'));
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
          '--bundle-dir',
          rejectBundleDir,
        ]),
      ).toBe(0);
      const rejected = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
        outcomes: unknown[];
        source: { overlay: { files: Record<string, string> } | null };
      };
      expect(rejected.decision.accepted).toBe(false);
      expect(rejected.decision.reasons).toEqual(['unauthorized-path:goal-gen/extra.txt']);
      expect(rejected.outcomes).toEqual([]);
      expect(rejected.source.overlay?.files['goal-gen/extra.txt']).toBe('unauthorized\n');
      const manifestPath = path.join(rejectBundleDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        decision: { accepted: boolean; reasons: string[] };
      };
      manifest.decision = { accepted: true, reasons: ['forged-acceptance'] };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', rejectBundleDir, '--json'])).toBe(0);
      const reproduced = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
        outcomes: unknown[];
      };
      expect(reproduced.decision.accepted).toBe(false);
      expect(reproduced.decision.reasons).toEqual(['unauthorized-path:goal-gen/extra.txt']);
      expect(reproduced.outcomes).toEqual([]);
      const moved = `${rejectBundleDir}-moved`;
      renameSync(rejectBundleDir, moved);
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', moved, '--json'])).toBe(0);
      const relocated = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
        outcomes: unknown[];
      };
      expect(relocated.decision.accepted).toBe(false);
      expect(relocated.decision.reasons).toEqual(['unauthorized-path:goal-gen/extra.txt']);
      expect(relocated.outcomes).toEqual([]);
      await rm(moved, { recursive: true, force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(rejectBundleDir, { recursive: true, force: true });
      await rm(`${rejectBundleDir}-moved`, { recursive: true, force: true });
    }
  });

  it('keeps prior overlay keys when unauthorized persist records extra.txt', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-unauth-omit-cap-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-unauth-omit-overlay-'));
    const unauthDest = await mkdtemp(path.join(tmpdir(), 'cs-unauth-omit-unauth-'));
    const plainUnauth = await mkdtemp(path.join(tmpdir(), 'cs-unauth-omit-plain-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-unauth-omit-work-'));
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
          captureDir,
        ]),
      ).toBe(0);
      const commentedBin = `${coherentFiles['goal-gen/bin/goal-gen.mjs']}// overlay comment\n`;
      const overlayPath = path.join(work, 'overlay.json');
      await writeFile(
        overlayPath,
        fileContentCandidate({
          'goal-gen/package.json': extraFieldManifest(),
          'goal-gen/bin/goal-gen.mjs': commentedBin,
        }),
        'utf8',
      );
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          overlayPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      const extraOnly = path.join(work, 'extra-only.json');
      await writeFile(extraOnly, fileContentCandidate({ 'goal-gen/extra.txt': 'unauthorized\n' }), 'utf8');
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraOnly,
          '--from-capture',
          overlayDest,
          '--json',
          '--bundle-dir',
          unauthDest,
        ]),
      ).toBe(0);
      const persisted = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
        source: {
          overlay: { files: Record<string, string> } | null;
          selected: { path: string; sha256: string }[];
        };
      };
      expect(persisted.decision.accepted).toBe(false);
      expect(persisted.decision.reasons).toEqual(['unauthorized-path:goal-gen/extra.txt']);
      expect(Object.keys(persisted.source.overlay?.files ?? {}).sort()).toEqual([
        'goal-gen/bin/goal-gen.mjs',
        'goal-gen/extra.txt',
        'goal-gen/package.json',
      ]);
      expect(persisted.source.overlay?.files['goal-gen/extra.txt']).toBe('unauthorized\n');
      expect(persisted.source.overlay?.files['goal-gen/bin/goal-gen.mjs']).toBe(commentedBin);
      expect(persisted.source.overlay?.files['goal-gen/package.json']).toBe(extraFieldManifest());
      const selectedPkg = persisted.source.selected.find((row) => row.path === 'goal-gen/package.json');
      expect(selectedPkg?.sha256).toBe(sha256Hex(extraFieldManifest()));
      expect(existsSync(path.join(unauthDest, 'COMPLETE'))).toBe(true);

      const unauthMoved = `${unauthDest}-moved`;
      renameSync(unauthDest, unauthMoved);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', unauthMoved, '--json'])).toBe(0);
      const relocated = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
      };
      expect(relocated.decision.accepted).toBe(false);
      expect(relocated.decision.reasons).toEqual(['unauthorized-path:goal-gen/extra.txt']);

      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraOnly,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          plainUnauth,
        ]),
      ).toBe(0);
      const plain = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
        source: { overlay: { files: Record<string, string> } | null };
      };
      expect(plain.decision.accepted).toBe(false);
      expect(plain.decision.reasons).toEqual(['unauthorized-path:goal-gen/extra.txt']);
      expect(Object.keys(plain.source.overlay?.files ?? {})).toEqual(['goal-gen/extra.txt']);
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', plainUnauth, '--json'])).toBe(0);
      const plainRepro = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
      };
      expect(plainRepro.decision.accepted).toBe(false);
      expect(plainRepro.decision.reasons).toEqual(['unauthorized-path:goal-gen/extra.txt']);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(unauthDest, { recursive: true, force: true });
      await rm(`${unauthDest}-moved`, { recursive: true, force: true });
      await rm(plainUnauth, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('replays hash-validated blobs, not untrusted overlay text', async () => {
    const incoherentLock = `${JSON.stringify({
      name: 'goal-gen',
      version: '9.9.9',
      lockfileVersion: 3,
      packages: { '': { name: 'goal-gen', version: '9.9.9' } },
    }, null, 2)}\n`;
    const { dir, commit } = await fixtureRepo({
      ...coherentFiles,
      'goal-gen/package-lock.json': incoherentLock,
    });
    const bundleDir = await mkdtemp(path.join(tmpdir(), 'cs-overlay-hash-'));
    const overlayOut = await mkdtemp(path.join(tmpdir(), 'cs-overlay-persist-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-overlay-hash-work-'));
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
      const matchingPkg = `${JSON.stringify({
        name: 'goal-gen',
        version: '9.9.9',
        bin: { 'goal-gen': 'bin/goal-gen.mjs' },
      }, null, 2)}\n`;
      const manifestPath = path.join(bundleDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        source: { overlay: { schemaVersion: string; files: Record<string, string> } | null };
        decision: { accepted: boolean };
      };
      expect(manifest.decision.accepted).toBe(false);
      manifest.source.overlay = {
        schemaVersion: 'yellow-goal/candidate-file-content/v1',
        files: { 'goal-gen/package.json': matchingPkg },
      };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(0);
      const forged = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean };
        outcomes: { id: string; status: string }[];
      };
      expect(forged.decision.accepted).toBe(false);
      expect(forged.outcomes.find((row) => row.id === 'manifest-lock-agreement')?.status).toBe('failed');

      const { dir: coherentDir, commit: coherentCommit } = await fixtureRepo(coherentFiles);
      try {
        expect(
          await main([
            'acceptance',
            'capture-source',
            'package-manifest-lockfile',
            coherentDir,
            coherentCommit,
            '--json',
            '--bundle-dir',
            overlayOut,
          ]),
        ).toBe(0);
        const extraPath = path.join(work, 'extra.json');
        await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
        const persistDir = await mkdtemp(path.join(tmpdir(), 'cs-overlay-ok-'));
        stdoutSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            overlayOut,
            '--json',
            '--bundle-dir',
            persistDir,
          ]),
        ).toBe(0);
        expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
        stdoutSpy.mockClear();
        expect(await main(['acceptance', 'reproduce', persistDir, '--json'])).toBe(0);
        const replayed = JSON.parse(stdoutText()) as {
          decision: { accepted: boolean };
          source: { selected: { path: string; sha256: string }[] };
        };
        expect(replayed.decision.accepted).toBe(true);
        expect(replayed.source.selected.find((row) => row.path === 'goal-gen/package.json')?.sha256).toBe(
          sha256Hex(extraFieldManifest()),
        );
        const persistManifestPath = path.join(persistDir, 'manifest.json');
        const persistManifest = JSON.parse(readFileSync(persistManifestPath, 'utf8')) as {
          source: { overlay: { files: Record<string, string> } };
        };
        persistManifest.source.overlay.files['goal-gen/package.json'] = mismatchedManifest();
        writeFileSync(persistManifestPath, `${JSON.stringify(persistManifest, null, 2)}\n`, 'utf8');
        stdoutSpy.mockClear();
        expect(await main(['acceptance', 'reproduce', persistDir, '--json'])).toBe(0);
        const afterTamper = JSON.parse(stdoutText()) as {
          decision: { accepted: boolean };
          outcomes: { id: string; status: string }[];
        };
        expect(afterTamper.decision.accepted).toBe(true);
        expect(afterTamper.outcomes.map((row) => row.status)).toEqual(['passed', 'passed']);
        await rm(persistDir, { recursive: true, force: true });
      } finally {
        await rm(coherentDir, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
      await rm(overlayOut, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects oversized overlay values and unbounded manifest.json before snapshot', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const bundleDir = await mkdtemp(path.join(tmpdir(), 'cs-overlay-size-meta-'));
    const hugeManifestDir = await mkdtemp(path.join(tmpdir(), 'cs-manifest-cap-'));
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
        source: { overlay: { schemaVersion: string; files: Record<string, string> } | null };
      };
      manifest.source.overlay = {
        schemaVersion: 'yellow-goal/candidate-file-content/v1',
        files: { 'goal-gen/package.json': 'x'.repeat(CANDIDATE_MAX_FILE_BYTES + 1) },
      };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/maxFileBytes/);

      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          hugeManifestDir,
        ]),
      ).toBe(0);
      const hugePath = path.join(hugeManifestDir, 'manifest.json');
      const huge = JSON.parse(readFileSync(hugePath, 'utf8')) as { padding?: string };
      huge.padding = 'p'.repeat(CAPTURE_MANIFEST_MAX_BYTES + 1);
      writeFileSync(hugePath, `${JSON.stringify(huge)}\n`, 'utf8');
      expect(lstatSync(hugePath).size).toBeGreaterThan(CAPTURE_MANIFEST_MAX_BYTES);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', hugeManifestDir, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(JSON.parse(stderrText()).error.message).toMatch(/manifest\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
      await rm(hugeManifestDir, { recursive: true, force: true });
    }
  });

  it('rejects unauthorized overlay keys with oversize or non-string values as BUNDLE_INVALID', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const oversize = await mkdtemp(path.join(tmpdir(), 'cs-unauth-overlay-oversize-'));
    const objectVal = await mkdtemp(path.join(tmpdir(), 'cs-unauth-overlay-object-'));
    const numberVal = await mkdtemp(path.join(tmpdir(), 'cs-unauth-overlay-number-'));
    try {
      for (const bundleDir of [oversize, objectVal, numberVal]) {
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
      }

      const persistUnauthorizedOverlay = (bundleDir: string, value: unknown): void => {
        const manifestPath = path.join(bundleDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          source: { overlay: { schemaVersion: string; files: Record<string, unknown> } | null };
        };
        manifest.source.overlay = {
          schemaVersion: 'yellow-goal/candidate-file-content/v1',
          files: { 'goal-gen/extra.txt': value },
        };
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      };

      persistUnauthorizedOverlay(oversize, 'x'.repeat(CANDIDATE_MAX_FILE_BYTES + 1));
      persistUnauthorizedOverlay(objectVal, { nested: true });
      persistUnauthorizedOverlay(numberVal, 16);

      for (const [bundleDir, message] of [
        [oversize, /maxFileBytes/],
        [objectVal, /not a string/],
        [numberVal, /not a string/],
      ] as const) {
        stdoutSpy.mockClear();
        stderrSpy.mockClear();
        expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
        expect(stdoutText()).toBe('');
        const err = JSON.parse(stderrText()) as { error: { code: string; message: string } };
        expect(err.error.code).toBe('BUNDLE_INVALID');
        expect(err.error.message).toMatch(message);
        expect(err.error.message).not.toMatch(/unauthorized-path/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(oversize, { recursive: true, force: true });
      await rm(objectVal, { recursive: true, force: true });
      await rm(numberVal, { recursive: true, force: true });
    }
  });

  it('rejects stored overlay path traversal, over-depth, and over-maxFiles as BUNDLE_INVALID', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const clean = await mkdtemp(path.join(tmpdir(), 'cs-overlay-path-clean-'));
    const unsafe = await mkdtemp(path.join(tmpdir(), 'cs-overlay-path-unsafe-'));
    const depth = await mkdtemp(path.join(tmpdir(), 'cs-overlay-path-depth-'));
    const count = await mkdtemp(path.join(tmpdir(), 'cs-overlay-path-count-'));
    const destUnsafe = await mkdtemp(path.join(tmpdir(), 'cs-overlay-path-dest-unsafe-'));
    const destDepth = await mkdtemp(path.join(tmpdir(), 'cs-overlay-path-dest-depth-'));
    const destCount = await mkdtemp(path.join(tmpdir(), 'cs-overlay-path-dest-count-'));
    const cliDest = await mkdtemp(path.join(tmpdir(), 'cs-overlay-path-cli-dest-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-overlay-path-work-'));
    try {
      for (const bundleDir of [clean, unsafe, depth, count]) {
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
      }

      const plantOverlay = (bundleDir: string, files: Record<string, string>): void => {
        const manifestPath = path.join(bundleDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          source: { overlay: { schemaVersion: string; files: Record<string, string> } | null };
        };
        manifest.source.overlay = {
          schemaVersion: 'yellow-goal/candidate-file-content/v1',
          files,
        };
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      };

      plantOverlay(unsafe, { '../x': 'traversed\n' });
      plantOverlay(depth, { 'a/b/c/d/e': 'over-depth\n' });
      const overCount: Record<string, string> = {};
      for (let i = 0; i < CANDIDATE_MAX_FILES + 1; i += 1) {
        overCount[`goal-gen/extra-${i}.txt`] = `n=${i}\n`;
      }
      plantOverlay(count, overCount);

      for (const [bundleDir, message] of [
        [unsafe, /unsafe|overlay path/],
        [depth, /unsafe|overlay path|maxDepth|depth/],
        [count, /maxFiles/],
      ] as const) {
        stdoutSpy.mockClear();
        stderrSpy.mockClear();
        expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
        expect(stdoutText()).toBe('');
        const err = JSON.parse(stderrText()) as { error: { code: string; message: string } };
        expect(err.error.code).toBe('BUNDLE_INVALID');
        expect(err.error.message).toMatch(message);
        expect(err.error.message).not.toMatch(/unauthorized-path/);
      }

      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      for (const [fromCapture, dest] of [
        [unsafe, destUnsafe],
        [depth, destDepth],
        [count, destCount],
      ] as const) {
        stdoutSpy.mockClear();
        stderrSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            fromCapture,
            '--json',
            '--bundle-dir',
            dest,
          ]),
        ).toBe(1);
        expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
        expect(JSON.parse(stderrText()).error.message).not.toMatch(/unauthorized-path/);
        expect(existsSync(path.join(dest, 'COMPLETE'))).toBe(false);
      }

      const unsafeCandidate = path.join(work, 'unsafe.json');
      await writeFile(unsafeCandidate, fileContentCandidate({ '../x': 'traversed\n' }), 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          unsafeCandidate,
          '--from-capture',
          clean,
          '--json',
          '--bundle-dir',
          cliDest,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(JSON.parse(stderrText()).error.message).toMatch(/unsafe candidate path: \.\.\/x/);
      expect(existsSync(path.join(cliDest, 'COMPLETE'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(clean, { recursive: true, force: true });
      await rm(unsafe, { recursive: true, force: true });
      await rm(depth, { recursive: true, force: true });
      await rm(count, { recursive: true, force: true });
      await rm(destUnsafe, { recursive: true, force: true });
      await rm(destDepth, { recursive: true, force: true });
      await rm(destCount, { recursive: true, force: true });
      await rm(cliDest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects --from-capture when stored overlay values cannot authorize selected bytes', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-overlay-auth-cap-'));
    const oversize = await mkdtemp(path.join(tmpdir(), 'cs-overlay-auth-oversize-'));
    const objectVal = await mkdtemp(path.join(tmpdir(), 'cs-overlay-auth-object-'));
    const numberVal = await mkdtemp(path.join(tmpdir(), 'cs-overlay-auth-number-'));
    const overlayNull = await mkdtemp(path.join(tmpdir(), 'cs-overlay-auth-null-'));
    const destOversize = await mkdtemp(path.join(tmpdir(), 'cs-overlay-auth-dest-oversize-'));
    const destObject = await mkdtemp(path.join(tmpdir(), 'cs-overlay-auth-dest-object-'));
    const destNumber = await mkdtemp(path.join(tmpdir(), 'cs-overlay-auth-dest-number-'));
    const destNull = await mkdtemp(path.join(tmpdir(), 'cs-overlay-auth-dest-null-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-overlay-auth-work-'));
    try {
      for (const bundleDir of [captureDir, overlayNull]) {
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
      }
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      for (const persistDir of [oversize, objectVal, numberVal]) {
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            captureDir,
            '--json',
            '--bundle-dir',
            persistDir,
          ]),
        ).toBe(0);
      }

      const extra = Buffer.from(extraFieldManifest());
      const tamperOverlayBundle = (bundleDir: string, overlayValue: unknown): void => {
        writeFileSync(path.join(bundleDir, 'blobs', 'goal-gen', 'package.json'), extra);
        const manifestPath = path.join(bundleDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          source: {
            overlay: { schemaVersion: string; files: Record<string, unknown> } | null;
            selected: { path: string; sha256: string; byteLength: number }[];
          };
        };
        expect(manifest.source.overlay).not.toBeNull();
        const selected = manifest.source.selected.find((row) => row.path === 'goal-gen/package.json');
        expect(selected).toBeDefined();
        selected!.sha256 = sha256Hex(extra);
        selected!.byteLength = extra.length;
        manifest.source.overlay = {
          schemaVersion: 'yellow-goal/candidate-file-content/v1',
          files: { 'goal-gen/package.json': overlayValue },
        };
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      };

      tamperOverlayBundle(oversize, 'x'.repeat(CANDIDATE_MAX_FILE_BYTES + 1));
      tamperOverlayBundle(objectVal, { nested: true });
      tamperOverlayBundle(numberVal, 16);

      writeFileSync(path.join(overlayNull, 'blobs', 'goal-gen', 'package.json'), extra);
      const nullManifestPath = path.join(overlayNull, 'manifest.json');
      const nullManifest = JSON.parse(readFileSync(nullManifestPath, 'utf8')) as {
        source: {
          overlay: null;
          selected: { path: string; sha256: string; byteLength: number }[];
        };
      };
      expect(nullManifest.source.overlay).toBeNull();
      const nullSelected = nullManifest.source.selected.find((row) => row.path === 'goal-gen/package.json');
      expect(nullSelected).toBeDefined();
      nullSelected!.sha256 = sha256Hex(extra);
      nullSelected!.byteLength = extra.length;
      writeFileSync(nullManifestPath, `${JSON.stringify(nullManifest, null, 2)}\n`, 'utf8');

      const emptyPath = path.join(work, 'empty.json');
      await writeFile(emptyPath, fileContentCandidate({}), 'utf8');

      for (const [bundleDir, dest, message] of [
        [oversize, destOversize, /maxFileBytes/],
        [objectVal, destObject, /not a string/],
        [numberVal, destNumber, /not a string/],
      ] as const) {
        stdoutSpy.mockClear();
        stderrSpy.mockClear();
        expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
        expect(stdoutText()).toBe('');
        expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
        expect(JSON.parse(stderrText()).error.message).toMatch(message);

        stdoutSpy.mockClear();
        stderrSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            emptyPath,
            '--from-capture',
            bundleDir,
            '--json',
            '--bundle-dir',
            dest,
          ]),
        ).toBe(1);
        expect(stdoutText()).toBe('');
        const err = JSON.parse(stderrText()) as { error: { code: string; message: string } };
        expect(err.error.code).toBe('BUNDLE_INVALID');
        expect(err.error.message).toMatch(message);
        expect(existsSync(path.join(dest, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(dest, 'COMPLETE'))).toBe(false);
      }

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          emptyPath,
          '--from-capture',
          overlayNull,
          '--json',
          '--bundle-dir',
          destNull,
        ]),
      ).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/captured identity/);
      expect(existsSync(path.join(destNull, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(destNull, 'COMPLETE'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(oversize, { recursive: true, force: true });
      await rm(objectVal, { recursive: true, force: true });
      await rm(numberVal, { recursive: true, force: true });
      await rm(overlayNull, { recursive: true, force: true });
      await rm(destOversize, { recursive: true, force: true });
      await rm(destObject, { recursive: true, force: true });
      await rm(destNumber, { recursive: true, force: true });
      await rm(destNull, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('keeps prior overlay paths when a chained candidate omits them', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-chain-cap-'));
    const twoPath = await mkdtemp(path.join(tmpdir(), 'cs-chain-two-'));
    const omitDest = await mkdtemp(path.join(tmpdir(), 'cs-chain-omit-'));
    const emptyFromOverlay = await mkdtemp(path.join(tmpdir(), 'cs-chain-empty-overlay-'));
    const emptyFromCapture = await mkdtemp(path.join(tmpdir(), 'cs-chain-empty-cap-'));
    const restateDest = await mkdtemp(path.join(tmpdir(), 'cs-chain-restate-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-chain-work-'));
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
          captureDir,
        ]),
      ).toBe(0);
      const commentedBin = `${coherentFiles['goal-gen/bin/goal-gen.mjs']}// overlay comment\n`;
      const twoPathCandidate = path.join(work, 'two.json');
      await writeFile(
        twoPathCandidate,
        fileContentCandidate({
          'goal-gen/package.json': extraFieldManifest(),
          'goal-gen/bin/goal-gen.mjs': commentedBin,
        }),
        'utf8',
      );
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          twoPathCandidate,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          twoPath,
        ]),
      ).toBe(0);
      const twoMoved = `${twoPath}-moved`;
      renameSync(twoPath, twoMoved);
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', twoMoved, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      const omitCandidate = path.join(work, 'omit.json');
      await writeFile(
        omitCandidate,
        fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }),
        'utf8',
      );
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          omitCandidate,
          '--from-capture',
          twoMoved,
          '--json',
          '--bundle-dir',
          omitDest,
        ]),
      ).toBe(0);
      const omitted = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean };
        source: {
          overlay: { files: Record<string, string> } | null;
          selected: { path: string; sha256: string }[];
          captured: { path: string; sha256: string }[];
        };
      };
      expect(omitted.decision.accepted).toBe(true);
      expect(Object.keys(omitted.source.overlay?.files ?? {}).sort()).toEqual([
        'goal-gen/bin/goal-gen.mjs',
        'goal-gen/package.json',
      ]);
      expect(omitted.source.overlay?.files['goal-gen/bin/goal-gen.mjs']).toBe(commentedBin);
      const selectedBin = omitted.source.selected.find((row) => row.path === 'goal-gen/bin/goal-gen.mjs');
      const capturedBin = omitted.source.captured.find((row) => row.path === 'goal-gen/bin/goal-gen.mjs');
      expect(selectedBin?.sha256).toBe(sha256Hex(commentedBin));
      expect(capturedBin?.sha256).not.toBe(selectedBin?.sha256);
      const omitMoved = `${omitDest}-moved`;
      renameSync(omitDest, omitMoved);
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', omitMoved, '--json'])).toBe(0);
      const omitReproduced = JSON.parse(stdoutText()) as { decision: { accepted: boolean } };
      expect(omitReproduced.decision.accepted).toBe(true);

      const emptyPath = path.join(work, 'empty.json');
      await writeFile(emptyPath, fileContentCandidate({}), 'utf8');
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          emptyPath,
          '--from-capture',
          twoMoved,
          '--json',
          '--bundle-dir',
          emptyFromOverlay,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', emptyFromOverlay, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          emptyPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          emptyFromCapture,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', emptyFromCapture, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          twoPathCandidate,
          '--from-capture',
          twoMoved,
          '--json',
          '--bundle-dir',
          restateDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', restateDest, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(twoPath, { recursive: true, force: true });
      await rm(`${twoPath}-moved`, { recursive: true, force: true });
      await rm(omitDest, { recursive: true, force: true });
      await rm(`${omitDest}-moved`, { recursive: true, force: true });
      await rm(emptyFromOverlay, { recursive: true, force: true });
      await rm(emptyFromCapture, { recursive: true, force: true });
      await rm(restateDest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects overlay --bundle-dir inside the source worktree or git directory', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-overlay-src-cap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-overlay-src-work-'));
    const nested = path.join(dir, 'evidence');
    const gitNested = path.join(dir, '.git', 'evidence');
    const canaryPath = path.join(dir, `.capture-canary-${process.pid}`);
    try {
      await writeFile(canaryPath, `canary-${Date.now()}\n`, 'utf8');
      const headBefore = gitFileHash(dir, 'HEAD');
      const indexBefore = gitFileHash(dir, 'index');
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      for (const bundleDir of [nested, gitNested]) {
        stderrSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            captureDir,
            '--json',
            '--bundle-dir',
            bundleDir,
          ]),
        ).toBe(2);
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
      }
      expect(readFileSync(canaryPath, 'utf8')).toMatch(/^canary-/);
      expect(gitFileHash(dir, 'HEAD')).toBe(headBefore);
      expect(gitFileHash(dir, 'index')).toBe(indexBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects overlay --bundle-dir when retained source.identity is missing or invalid', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-no-ident-cap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-no-ident-work-'));
    const nested = path.join(dir, 'evidence');
    const gitNested = path.join(dir, '.git', 'evidence');
    const canaryPath = path.join(dir, `.capture-canary-${process.pid}`);
    try {
      await writeFile(canaryPath, `canary-${Date.now()}\n`, 'utf8');
      const headBefore = gitFileHash(dir, 'HEAD');
      const indexBefore = gitFileHash(dir, 'index');
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      const captureManifestPath = path.join(captureDir, 'manifest.json');
      const captureManifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
        source: { identity?: unknown };
      };
      const variants: unknown[] = [undefined, { repoPath: dir, gitDir: '', commonGitDir: path.join(dir, '.git'), worktree: dir }];
      for (const identity of variants) {
        if (identity === undefined) {
          delete captureManifest.source.identity;
        } else {
          captureManifest.source.identity = identity;
        }
        writeFileSync(captureManifestPath, `${JSON.stringify(captureManifest, null, 2)}\n`, 'utf8');
        for (const bundleDir of [nested, gitNested]) {
          stderrSpy.mockClear();
          stdoutSpy.mockClear();
          expect(
            await main([
              'acceptance',
              'verify-candidate',
              'package-manifest-lockfile',
              extraPath,
              '--from-capture',
              captureDir,
              '--json',
              '--bundle-dir',
              bundleDir,
            ]),
          ).toBe(1);
          expect(stdoutText()).toBe('');
          expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
          expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
          expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
        }
      }
      expect(readFileSync(canaryPath, 'utf8')).toMatch(/^canary-/);
      expect(gitFileHash(dir, 'HEAD')).toBe(headBefore);
      expect(gitFileHash(dir, 'index')).toBe(indexBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects overlay --bundle-dir when retained source.identity paths are relative', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-rel-ident-cap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-rel-ident-work-'));
    const relHome = await mkdtemp(path.join(tmpdir(), 'cs-rel-ident-home-'));
    const relCwd = path.join(relHome, 'rel-cwd');
    mkdirSync(relCwd, { recursive: true });
    const nested = path.join(dir, 'evidence');
    const gitNested = path.join(dir, '.git', 'evidence');
    const previousCwd = process.cwd();
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      const captureManifestPath = path.join(captureDir, 'manifest.json');
      const captureManifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
        source: { identity?: unknown };
      };
      captureManifest.source.identity = {
        repoPath: 'rel-ident',
        gitDir: 'rel-ident/.git',
        commonGitDir: 'rel-ident/.git',
        worktree: 'rel-ident',
      };
      writeFileSync(captureManifestPath, `${JSON.stringify(captureManifest, null, 2)}\n`, 'utf8');
      process.chdir(relCwd);
      for (const bundleDir of [nested, gitNested]) {
        stderrSpy.mockClear();
        stdoutSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            captureDir,
            '--json',
            '--bundle-dir',
            bundleDir,
          ]),
        ).toBe(1);
        expect(stdoutText()).toBe('');
        expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
        expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
      }
    } finally {
      process.chdir(previousCwd);
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(relHome, { recursive: true, force: true });
    }
  });

  it('rejects overlay --bundle-dir when retained identity is replaced with missing absolute roots', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-fake-ident-cap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-fake-ident-work-'));
    const unrelatedDest = await mkdtemp(path.join(tmpdir(), 'cs-fake-ident-unrelated-'));
    const nested = path.join(dir, 'evidence');
    const gitNested = path.join(dir, '.git', 'evidence');
    const fakeRoot = path.join(tmpdir(), `cs-fake-ident-missing-${process.pid}`);
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');

      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          nested,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(nested, 'COMPLETE'))).toBe(false);

      const captureManifestPath = path.join(captureDir, 'manifest.json');
      const captureManifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
        source: { identity: { repoPath: string; gitDir: string; commonGitDir: string; worktree: string | null } };
      };
      captureManifest.source.identity = {
        repoPath: path.join(fakeRoot, 'repo'),
        gitDir: path.join(fakeRoot, 'git'),
        commonGitDir: path.join(fakeRoot, 'common'),
        worktree: path.join(fakeRoot, 'wt'),
      };
      writeFileSync(captureManifestPath, `${JSON.stringify(captureManifest, null, 2)}\n`, 'utf8');
      expect(existsSync(fakeRoot)).toBe(false);

      for (const bundleDir of [nested, gitNested]) {
        stderrSpy.mockClear();
        stdoutSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            captureDir,
            '--json',
            '--bundle-dir',
            bundleDir,
          ]),
        ).toBe(2);
        expect(stdoutText()).toBe('');
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
      }

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          unrelatedDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(unrelatedDest, 'COMPLETE'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(unrelatedDest, { recursive: true, force: true });
    }
  });

  it('rejects overlay --bundle-dir when identity and sourceIntegrity canaries are both retargeted', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-canary-miss-cap-'));
    const identityOnly = await mkdtemp(path.join(tmpdir(), 'cs-canary-miss-ident-'));
    const combo = await mkdtemp(path.join(tmpdir(), 'cs-canary-miss-combo-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-canary-miss-work-'));
    const unrelatedDest = await mkdtemp(path.join(tmpdir(), 'cs-canary-miss-unrelated-'));
    const nested = path.join(dir, 'evidence');
    const gitNested = path.join(dir, '.git', 'evidence');
    const fakeRoot = path.join(tmpdir(), `cs-canary-miss-missing-${process.pid}`);
    try {
      for (const bundleDir of [captureDir, identityOnly, combo]) {
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
      }
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');

      const forgeIdentity = (
        bundleDir: string,
        suffix: string,
        retargetCanaries: boolean,
      ): void => {
        const captureManifestPath = path.join(bundleDir, 'manifest.json');
        const captureManifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
          source: { identity: { repoPath: string; gitDir: string; commonGitDir: string; worktree: string | null } };
          sourceIntegrity: { headSha256: string; indexSha256: string };
        };
        captureManifest.source.identity = {
          repoPath: path.join(fakeRoot, suffix, 'repo'),
          gitDir: path.join(fakeRoot, suffix, 'git'),
          commonGitDir: path.join(fakeRoot, suffix, 'common'),
          worktree: path.join(fakeRoot, suffix, 'wt'),
        };
        if (retargetCanaries) {
          captureManifest.sourceIntegrity.headSha256 = 'e'.repeat(64);
          captureManifest.sourceIntegrity.indexSha256 = 'f'.repeat(64);
        }
        writeFileSync(captureManifestPath, `${JSON.stringify(captureManifest, null, 2)}\n`, 'utf8');
      };

      forgeIdentity(identityOnly, 'identity-only', false);
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          identityOnly,
          '--json',
          '--bundle-dir',
          nested,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(nested, 'COMPLETE'))).toBe(false);

      forgeIdentity(combo, 'combo', true);
      expect(existsSync(fakeRoot)).toBe(false);
      for (const bundleDir of [nested, gitNested]) {
        stderrSpy.mockClear();
        stdoutSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            combo,
            '--json',
            '--bundle-dir',
            bundleDir,
          ]),
        ).toBe(2);
        expect(stdoutText()).toBe('');
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
      }

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          combo,
          '--json',
          '--bundle-dir',
          unrelatedDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(unrelatedDest, 'COMPLETE'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(identityOnly, { recursive: true, force: true });
      await rm(combo, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(unrelatedDest, { recursive: true, force: true });
    }
  });

  it('rejects overlay --bundle-dir after overlay-all plus forged identity and canaries', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-overlay-all-cap-'));
    const overlayAll = await mkdtemp(path.join(tmpdir(), 'cs-overlay-all-dest-'));
    const identityOnly = await mkdtemp(path.join(tmpdir(), 'cs-overlay-all-ident-'));
    const combo = await mkdtemp(path.join(tmpdir(), 'cs-overlay-all-combo-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-overlay-all-work-'));
    const unrelatedDest = await mkdtemp(path.join(tmpdir(), 'cs-overlay-all-unrelated-'));
    const nested = path.join(dir, 'evidence');
    const gitNested = path.join(dir, '.git', 'evidence');
    const fakeRoot = path.join(tmpdir(), `cs-overlay-all-missing-${process.pid}`);
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
          captureDir,
        ]),
      ).toBe(0);
      const overlayLock = `${JSON.stringify(
        {
          name: 'goal-gen',
          version: '0.2.0',
          lockfileVersion: 3,
          packages: { '': { name: 'goal-gen', version: '0.2.0' } },
          extra: true,
        },
        null,
        2,
      )}\n`;
      const commentedBin = `${coherentFiles['goal-gen/bin/goal-gen.mjs']}// overlay comment\n`;
      const overlayAllPath = path.join(work, 'all.json');
      await writeFile(
        overlayAllPath,
        fileContentCandidate({
          'goal-gen/package.json': extraFieldManifest(),
          'goal-gen/package-lock.json': overlayLock,
          'goal-gen/bin/goal-gen.mjs': commentedBin,
        }),
        'utf8',
      );
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          overlayAllPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayAll,
        ]),
      ).toBe(0);
      const overlayed = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean };
        source: { overlay: { files: Record<string, string> } | null };
      };
      expect(overlayed.decision.accepted).toBe(true);
      expect(Object.keys(overlayed.source.overlay?.files ?? {}).sort()).toEqual([
        'goal-gen/bin/goal-gen.mjs',
        'goal-gen/package-lock.json',
        'goal-gen/package.json',
      ]);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');

      const copyBundle = (from: string, to: string): void => {
        mkdirSync(to, { recursive: true });
        for (const name of readdirSync(from, { recursive: true, encoding: 'utf8' })) {
          const src = path.join(from, name);
          const dest = path.join(to, name);
          const stat = lstatSync(src);
          if (stat.isDirectory()) {
            mkdirSync(dest, { recursive: true });
          } else {
            mkdirSync(path.dirname(dest), { recursive: true });
            writeFileSync(dest, readFileSync(src));
          }
        }
      };
      copyBundle(overlayAll, identityOnly);
      copyBundle(overlayAll, combo);

      const forgeIdentity = (bundleDir: string, suffix: string, retargetCanaries: boolean): void => {
        const captureManifestPath = path.join(bundleDir, 'manifest.json');
        const captureManifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
          source: { identity: { repoPath: string; gitDir: string; commonGitDir: string; worktree: string | null } };
          sourceIntegrity: { headSha256: string; indexSha256: string };
        };
        captureManifest.source.identity = {
          repoPath: path.join(fakeRoot, suffix, 'repo'),
          gitDir: path.join(fakeRoot, suffix, 'git'),
          commonGitDir: path.join(fakeRoot, suffix, 'common'),
          worktree: path.join(fakeRoot, suffix, 'wt'),
        };
        if (retargetCanaries) {
          captureManifest.sourceIntegrity.headSha256 = 'e'.repeat(64);
          captureManifest.sourceIntegrity.indexSha256 = 'f'.repeat(64);
        }
        writeFileSync(captureManifestPath, `${JSON.stringify(captureManifest, null, 2)}\n`, 'utf8');
      };

      forgeIdentity(identityOnly, 'identity-only', false);
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          identityOnly,
          '--json',
          '--bundle-dir',
          nested,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(nested, 'COMPLETE'))).toBe(false);

      forgeIdentity(captureDir, 'plain-combo', true);
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          nested,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(nested, 'COMPLETE'))).toBe(false);

      forgeIdentity(combo, 'combo', true);
      expect(existsSync(fakeRoot)).toBe(false);
      for (const bundleDir of [nested, gitNested]) {
        stderrSpy.mockClear();
        stdoutSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            combo,
            '--json',
            '--bundle-dir',
            bundleDir,
          ]),
        ).toBe(2);
        expect(stdoutText()).toBe('');
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
      }

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          combo,
          '--json',
          '--bundle-dir',
          unrelatedDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(unrelatedDest, 'COMPLETE'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayAll, { recursive: true, force: true });
      await rm(identityOnly, { recursive: true, force: true });
      await rm(combo, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(unrelatedDest, { recursive: true, force: true });
    }
  });

  it('rejects overlay --bundle-dir after rewritten object IDs plus forged identity and canaries', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-unauth-ids-cap-'));
    const overlayAll = await mkdtemp(path.join(tmpdir(), 'cs-unauth-ids-overlay-'));
    const combo = await mkdtemp(path.join(tmpdir(), 'cs-unauth-ids-combo-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-unauth-ids-work-'));
    const unrelatedDest = await mkdtemp(path.join(tmpdir(), 'cs-unauth-ids-unrelated-'));
    const nested = path.join(dir, 'evidence');
    const gitNested = path.join(dir, '.git', 'evidence');
    const fakeRoot = path.join(tmpdir(), `cs-unauth-ids-missing-${process.pid}`);
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
          captureDir,
        ]),
      ).toBe(0);
      const overlayLock = `${JSON.stringify(
        {
          name: 'goal-gen',
          version: '0.2.0',
          lockfileVersion: 3,
          packages: { '': { name: 'goal-gen', version: '0.2.0' } },
          extra: true,
        },
        null,
        2,
      )}\n`;
      const commentedBin = `${coherentFiles['goal-gen/bin/goal-gen.mjs']}// overlay comment\n`;
      const overlayAllPath = path.join(work, 'all.json');
      await writeFile(
        overlayAllPath,
        fileContentCandidate({
          'goal-gen/package.json': extraFieldManifest(),
          'goal-gen/package-lock.json': overlayLock,
          'goal-gen/bin/goal-gen.mjs': commentedBin,
        }),
        'utf8',
      );
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          overlayAllPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayAll,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');

      mkdirSync(combo, { recursive: true });
      for (const name of readdirSync(overlayAll, { recursive: true, encoding: 'utf8' })) {
        const src = path.join(overlayAll, name);
        const dest = path.join(combo, name);
        const stat = lstatSync(src);
        if (stat.isDirectory()) {
          mkdirSync(dest, { recursive: true });
        } else {
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, readFileSync(src));
        }
      }

      const captureManifestPath = path.join(combo, 'manifest.json');
      const captureManifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
        source: {
          commit: string;
          captured: Array<{ path: string; gitSha: string }>;
          identity: { repoPath: string; gitDir: string; commonGitDir: string; worktree: string | null };
        };
        sourceIntegrity: { headSha256: string; indexSha256: string };
      };
      captureManifest.source.identity = {
        repoPath: path.join(fakeRoot, 'combo', 'repo'),
        gitDir: path.join(fakeRoot, 'combo', 'git'),
        commonGitDir: path.join(fakeRoot, 'combo', 'common'),
        worktree: path.join(fakeRoot, 'combo', 'wt'),
      };
      captureManifest.sourceIntegrity.headSha256 = 'e'.repeat(64);
      captureManifest.sourceIntegrity.indexSha256 = 'f'.repeat(64);
      captureManifest.source.commit = 'a'.repeat(40);
      const rewritten = {
        'goal-gen/package.json': 'b'.repeat(40),
        'goal-gen/package-lock.json': 'c'.repeat(40),
        'goal-gen/bin/goal-gen.mjs': 'd'.repeat(40),
      } as const;
      for (const row of captureManifest.source.captured) {
        const next = rewritten[row.path as keyof typeof rewritten];
        if (next !== undefined) row.gitSha = next;
      }
      writeFileSync(captureManifestPath, `${JSON.stringify(captureManifest, null, 2)}\n`, 'utf8');
      expect(existsSync(fakeRoot)).toBe(false);
      const hasObject = (sha: string): boolean =>
        spawnSync('git', ['-C', dir, 'cat-file', '-e', sha], { encoding: 'utf8' }).status === 0;
      expect(hasObject(commit)).toBe(true);
      expect(hasObject('a'.repeat(40))).toBe(false);
      expect(hasObject('b'.repeat(40))).toBe(false);

      for (const bundleDir of [nested, gitNested]) {
        stderrSpy.mockClear();
        stdoutSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            combo,
            '--json',
            '--bundle-dir',
            bundleDir,
          ]),
        ).toBe(2);
        expect(stdoutText()).toBe('');
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
      }

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          combo,
          '--json',
          '--bundle-dir',
          unrelatedDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(unrelatedDest, 'COMPLETE'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayAll, { recursive: true, force: true });
      await rm(combo, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(unrelatedDest, { recursive: true, force: true });
    }
  });

  it('rejects overlay --bundle-dir after rewritten object IDs plus partial identity repoPath', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-partial-id-cap-'));
    const overlayAll = await mkdtemp(path.join(tmpdir(), 'cs-partial-id-overlay-'));
    const combo = await mkdtemp(path.join(tmpdir(), 'cs-partial-id-combo-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-partial-id-work-'));
    const unrelatedDest = await mkdtemp(path.join(tmpdir(), 'cs-partial-id-unrelated-'));
    const nested = path.join(dir, 'evidence');
    const gitNested = path.join(dir, '.git', 'evidence');
    const fakeRoot = path.join(tmpdir(), `cs-partial-id-missing-${process.pid}`);
    const existingUnrelated = tmpdir();
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
          captureDir,
        ]),
      ).toBe(0);
      const overlayLock = `${JSON.stringify(
        {
          name: 'goal-gen',
          version: '0.2.0',
          lockfileVersion: 3,
          packages: { '': { name: 'goal-gen', version: '0.2.0' } },
          extra: true,
        },
        null,
        2,
      )}\n`;
      const commentedBin = `${coherentFiles['goal-gen/bin/goal-gen.mjs']}// overlay comment\n`;
      const overlayAllPath = path.join(work, 'all.json');
      await writeFile(
        overlayAllPath,
        fileContentCandidate({
          'goal-gen/package.json': extraFieldManifest(),
          'goal-gen/package-lock.json': overlayLock,
          'goal-gen/bin/goal-gen.mjs': commentedBin,
        }),
        'utf8',
      );
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          overlayAllPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayAll,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');

      mkdirSync(combo, { recursive: true });
      for (const name of readdirSync(overlayAll, { recursive: true, encoding: 'utf8' })) {
        const src = path.join(overlayAll, name);
        const dest = path.join(combo, name);
        const stat = lstatSync(src);
        if (stat.isDirectory()) {
          mkdirSync(dest, { recursive: true });
        } else {
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, readFileSync(src));
        }
      }

      const captureManifestPath = path.join(combo, 'manifest.json');
      const captureManifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
        source: {
          commit: string;
          captured: Array<{ path: string; gitSha: string }>;
          identity: { repoPath: string; gitDir: string; commonGitDir: string; worktree: string | null };
        };
        sourceIntegrity: { headSha256: string; indexSha256: string };
      };
      captureManifest.source.identity = {
        repoPath: existingUnrelated,
        gitDir: path.join(fakeRoot, 'combo', 'git'),
        commonGitDir: path.join(fakeRoot, 'combo', 'common'),
        worktree: path.join(fakeRoot, 'combo', 'wt'),
      };
      captureManifest.sourceIntegrity.headSha256 = 'e'.repeat(64);
      captureManifest.sourceIntegrity.indexSha256 = 'f'.repeat(64);
      captureManifest.source.commit = 'a'.repeat(40);
      const rewritten = {
        'goal-gen/package.json': 'b'.repeat(40),
        'goal-gen/package-lock.json': 'c'.repeat(40),
        'goal-gen/bin/goal-gen.mjs': 'd'.repeat(40),
      } as const;
      for (const row of captureManifest.source.captured) {
        const next = rewritten[row.path as keyof typeof rewritten];
        if (next !== undefined) row.gitSha = next;
      }
      writeFileSync(captureManifestPath, `${JSON.stringify(captureManifest, null, 2)}\n`, 'utf8');
      expect(existsSync(existingUnrelated)).toBe(true);
      expect(existsSync(fakeRoot)).toBe(false);
      const hasObject = (sha: string): boolean =>
        spawnSync('git', ['-C', dir, 'cat-file', '-e', sha], { encoding: 'utf8' }).status === 0;
      expect(hasObject(commit)).toBe(true);
      expect(hasObject('a'.repeat(40))).toBe(false);

      for (const bundleDir of [nested, gitNested]) {
        stderrSpy.mockClear();
        stdoutSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            combo,
            '--json',
            '--bundle-dir',
            bundleDir,
          ]),
        ).toBe(2);
        expect(stdoutText()).toBe('');
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
      }

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          combo,
          '--json',
          '--bundle-dir',
          unrelatedDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(unrelatedDest, 'COMPLETE'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayAll, { recursive: true, force: true });
      await rm(combo, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(unrelatedDest, { recursive: true, force: true });
    }
  });

  it('rejects overlay --bundle-dir after overlay-all plus a coherent replacement identity', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const otherFiles = {
      'goal-gen/package.json': extraFieldManifest(),
      'goal-gen/package-lock.json': `${JSON.stringify(
        {
          name: 'other',
          version: '9.9.9',
          lockfileVersion: 3,
          packages: { '': { name: 'other', version: '9.9.9' } },
        },
        null,
        2,
      )}\n`,
      'goal-gen/bin/goal-gen.mjs': '#!/usr/bin/env node\nexport const other = true;\n',
    };
    const other = await fixtureRepo(otherFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-coherent-rep-cap-'));
    const overlayAll = await mkdtemp(path.join(tmpdir(), 'cs-coherent-rep-overlay-'));
    const combo = await mkdtemp(path.join(tmpdir(), 'cs-coherent-rep-combo-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-coherent-rep-work-'));
    const unrelatedDest = await mkdtemp(path.join(tmpdir(), 'cs-coherent-rep-unrelated-'));
    const nested = path.join(dir, 'evidence');
    const gitNested = path.join(dir, '.git', 'evidence');
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
          captureDir,
        ]),
      ).toBe(0);
      const overlayLock = `${JSON.stringify(
        {
          name: 'goal-gen',
          version: '0.2.0',
          lockfileVersion: 3,
          packages: { '': { name: 'goal-gen', version: '0.2.0' } },
          extra: true,
        },
        null,
        2,
      )}\n`;
      const commentedBin = `${coherentFiles['goal-gen/bin/goal-gen.mjs']}// overlay comment\n`;
      const overlayAllPath = path.join(work, 'all.json');
      await writeFile(
        overlayAllPath,
        fileContentCandidate({
          'goal-gen/package.json': extraFieldManifest(),
          'goal-gen/package-lock.json': overlayLock,
          'goal-gen/bin/goal-gen.mjs': commentedBin,
        }),
        'utf8',
      );
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          overlayAllPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayAll,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      copyCaptureTree(overlayAll, combo);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');

      const otherIdentity = fixtureIdentity(other.dir);
      const otherBlobs = knownBlobs(other.dir, other.commit, otherFiles);
      const captureManifestPath = path.join(combo, 'manifest.json');
      const captureManifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
        source: {
          commit: string;
          captured: Array<{ path: string; gitSha: string }>;
          identity: { repoPath: string; gitDir: string; commonGitDir: string; worktree: string | null };
        };
        sourceIntegrity: { headSha256: string; indexSha256: string };
      };
      captureManifest.source.identity = otherIdentity;
      captureManifest.source.commit = other.commit;
      captureManifest.sourceIntegrity.headSha256 = gitFileHash(other.dir, 'HEAD');
      captureManifest.sourceIntegrity.indexSha256 = gitFileHash(other.dir, 'index');
      const rewritten = Object.fromEntries(otherBlobs.map((row) => [row.path, row.gitSha]));
      for (const row of captureManifest.source.captured) {
        const next = rewritten[row.path];
        if (next !== undefined) row.gitSha = next;
      }
      writeFileSync(captureManifestPath, `${JSON.stringify(captureManifest, null, 2)}\n`, 'utf8');
      expect(existsSync(otherIdentity.gitDir)).toBe(true);
      const hasObject = (sha: string): boolean =>
        spawnSync('git', ['-C', dir, 'cat-file', '-e', sha], { encoding: 'utf8' }).status === 0;
      expect(hasObject(commit)).toBe(true);
      expect(hasObject(other.commit)).toBe(false);

      for (const bundleDir of [nested, gitNested]) {
        stderrSpy.mockClear();
        stdoutSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            combo,
            '--json',
            '--bundle-dir',
            bundleDir,
          ]),
        ).toBe(2);
        expect(stdoutText()).toBe('');
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
      }

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          combo,
          '--json',
          '--bundle-dir',
          unrelatedDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(unrelatedDest, 'COMPLETE'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(other.dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayAll, { recursive: true, force: true });
      await rm(combo, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(unrelatedDest, { recursive: true, force: true });
    }
  });

  it('rejects overlay --bundle-dir after overlaying two paths plus a coherent replacement identity sharing one blob', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const otherFiles = {
      'goal-gen/package.json': coherentFiles['goal-gen/package.json'],
      'goal-gen/package-lock.json': `${JSON.stringify(
        {
          name: 'other',
          version: '9.9.9',
          lockfileVersion: 3,
          packages: { '': { name: 'other', version: '9.9.9' } },
        },
        null,
        2,
      )}\n`,
      'goal-gen/bin/goal-gen.mjs': '#!/usr/bin/env node\nexport const other = true;\n',
    };
    const other = await fixtureRepo(otherFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-partial-unov-cap-'));
    const overlayTwo = await mkdtemp(path.join(tmpdir(), 'cs-partial-unov-two-'));
    const overlayAll = await mkdtemp(path.join(tmpdir(), 'cs-partial-unov-all-'));
    const comboTwo = await mkdtemp(path.join(tmpdir(), 'cs-partial-unov-combo-two-'));
    const comboAll = await mkdtemp(path.join(tmpdir(), 'cs-partial-unov-combo-all-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-partial-unov-work-'));
    const unrelatedDest = await mkdtemp(path.join(tmpdir(), 'cs-partial-unov-unrelated-'));
    const nested = path.join(dir, 'evidence');
    const gitNested = path.join(dir, '.git', 'evidence');
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
          captureDir,
        ]),
      ).toBe(0);
      const overlayLock = `${JSON.stringify(
        {
          name: 'goal-gen',
          version: '0.2.0',
          lockfileVersion: 3,
          packages: { '': { name: 'goal-gen', version: '0.2.0' } },
          extra: true,
        },
        null,
        2,
      )}\n`;
      const commentedBin = `${coherentFiles['goal-gen/bin/goal-gen.mjs']}// overlay comment\n`;
      const overlayTwoPath = path.join(work, 'two.json');
      await writeFile(
        overlayTwoPath,
        fileContentCandidate({
          'goal-gen/package-lock.json': overlayLock,
          'goal-gen/bin/goal-gen.mjs': commentedBin,
        }),
        'utf8',
      );
      const overlayAllPath = path.join(work, 'all.json');
      await writeFile(
        overlayAllPath,
        fileContentCandidate({
          'goal-gen/package.json': extraFieldManifest(),
          'goal-gen/package-lock.json': overlayLock,
          'goal-gen/bin/goal-gen.mjs': commentedBin,
        }),
        'utf8',
      );
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          overlayTwoPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayTwo,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          overlayAllPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayAll,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      const retargetIdentity = (combo: string): void => {
        copyCaptureTree(combo === comboTwo ? overlayTwo : overlayAll, combo);
        const otherIdentity = fixtureIdentity(other.dir);
        const otherBlobs = knownBlobs(other.dir, other.commit, otherFiles);
        const captureManifestPath = path.join(combo, 'manifest.json');
        const captureManifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
          source: {
            commit: string;
            captured: Array<{ path: string; gitSha: string }>;
            identity: { repoPath: string; gitDir: string; commonGitDir: string; worktree: string | null };
          };
          sourceIntegrity: { headSha256: string; indexSha256: string };
        };
        captureManifest.source.identity = otherIdentity;
        captureManifest.source.commit = other.commit;
        captureManifest.sourceIntegrity.headSha256 = gitFileHash(other.dir, 'HEAD');
        captureManifest.sourceIntegrity.indexSha256 = gitFileHash(other.dir, 'index');
        const rewritten = Object.fromEntries(otherBlobs.map((row) => [row.path, row.gitSha]));
        for (const row of captureManifest.source.captured) {
          const next = rewritten[row.path];
          if (next !== undefined) row.gitSha = next;
        }
        writeFileSync(captureManifestPath, `${JSON.stringify(captureManifest, null, 2)}\n`, 'utf8');
      };
      retargetIdentity(comboTwo);
      retargetIdentity(comboAll);
      expect(existsSync(fixtureIdentity(other.dir).gitDir)).toBe(true);
      const hasObject = (repo: string, sha: string): boolean =>
        spawnSync('git', ['-C', repo, 'cat-file', '-e', sha], { encoding: 'utf8' }).status === 0;
      const pkgSha = knownBlobs(dir, commit, coherentFiles).find((row) => row.path === 'goal-gen/package.json')?.gitSha;
      const lockSha = knownBlobs(dir, commit, coherentFiles).find((row) => row.path === 'goal-gen/package-lock.json')?.gitSha;
      expect(pkgSha).toMatch(/^[0-9a-f]{40}$/);
      expect(lockSha).toMatch(/^[0-9a-f]{40}$/);
      expect(hasObject(other.dir, pkgSha!)).toBe(true);
      expect(hasObject(other.dir, lockSha!)).toBe(false);
      expect(hasObject(dir, other.commit)).toBe(false);

      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      for (const fromCapture of [comboTwo, comboAll]) {
        for (const bundleDir of [nested, gitNested]) {
          stderrSpy.mockClear();
          stdoutSpy.mockClear();
          expect(
            await main([
              'acceptance',
              'verify-candidate',
              'package-manifest-lockfile',
              extraPath,
              '--from-capture',
              fromCapture,
              '--json',
              '--bundle-dir',
              bundleDir,
            ]),
          ).toBe(2);
          expect(stdoutText()).toBe('');
          expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
          expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
          expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
        }
      }

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          comboTwo,
          '--json',
          '--bundle-dir',
          unrelatedDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(unrelatedDest, 'COMPLETE'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(other.dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayTwo, { recursive: true, force: true });
      await rm(overlayAll, { recursive: true, force: true });
      await rm(comboTwo, { recursive: true, force: true });
      await rm(comboAll, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(unrelatedDest, { recursive: true, force: true });
    }
  });

  it('rejects overlay --bundle-dir after overlaying the remaining path plus a coherent replacement identity sharing two blobs', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const otherFiles = {
      'goal-gen/package.json': coherentFiles['goal-gen/package.json'],
      'goal-gen/package-lock.json': coherentFiles['goal-gen/package-lock.json'],
      'goal-gen/bin/goal-gen.mjs': '#!/usr/bin/env node\nexport const other = true;\n',
    };
    const other = await fixtureRepo(otherFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-two-unov-cap-'));
    const overlayBin = await mkdtemp(path.join(tmpdir(), 'cs-two-unov-bin-'));
    const overlayAll = await mkdtemp(path.join(tmpdir(), 'cs-two-unov-all-'));
    const comboBin = await mkdtemp(path.join(tmpdir(), 'cs-two-unov-combo-bin-'));
    const comboAll = await mkdtemp(path.join(tmpdir(), 'cs-two-unov-combo-all-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-two-unov-work-'));
    const unrelatedDest = await mkdtemp(path.join(tmpdir(), 'cs-two-unov-unrelated-'));
    const nested = path.join(dir, 'evidence');
    const gitNested = path.join(dir, '.git', 'evidence');
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
          captureDir,
        ]),
      ).toBe(0);
      const overlayLock = `${JSON.stringify(
        {
          name: 'goal-gen',
          version: '0.2.0',
          lockfileVersion: 3,
          packages: { '': { name: 'goal-gen', version: '0.2.0' } },
          extra: true,
        },
        null,
        2,
      )}\n`;
      const commentedBin = `${coherentFiles['goal-gen/bin/goal-gen.mjs']}// overlay comment\n`;
      const overlayBinPath = path.join(work, 'bin.json');
      await writeFile(
        overlayBinPath,
        fileContentCandidate({
          'goal-gen/bin/goal-gen.mjs': commentedBin,
        }),
        'utf8',
      );
      const overlayAllPath = path.join(work, 'all.json');
      await writeFile(
        overlayAllPath,
        fileContentCandidate({
          'goal-gen/package.json': extraFieldManifest(),
          'goal-gen/package-lock.json': overlayLock,
          'goal-gen/bin/goal-gen.mjs': commentedBin,
        }),
        'utf8',
      );
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          overlayBinPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayBin,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          overlayAllPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayAll,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      const retargetIdentity = (combo: string, source: string): void => {
        copyCaptureTree(source, combo);
        const otherIdentity = fixtureIdentity(other.dir);
        const otherBlobs = knownBlobs(other.dir, other.commit, otherFiles);
        const captureManifestPath = path.join(combo, 'manifest.json');
        const captureManifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
          source: {
            commit: string;
            captured: Array<{ path: string; gitSha: string }>;
            identity: { repoPath: string; gitDir: string; commonGitDir: string; worktree: string | null };
          };
          sourceIntegrity: { headSha256: string; indexSha256: string };
        };
        captureManifest.source.identity = otherIdentity;
        captureManifest.source.commit = other.commit;
        captureManifest.sourceIntegrity.headSha256 = gitFileHash(other.dir, 'HEAD');
        captureManifest.sourceIntegrity.indexSha256 = gitFileHash(other.dir, 'index');
        const rewritten = Object.fromEntries(otherBlobs.map((row) => [row.path, row.gitSha]));
        for (const row of captureManifest.source.captured) {
          const next = rewritten[row.path];
          if (next !== undefined) row.gitSha = next;
        }
        writeFileSync(captureManifestPath, `${JSON.stringify(captureManifest, null, 2)}\n`, 'utf8');
      };
      retargetIdentity(comboBin, overlayBin);
      retargetIdentity(comboAll, overlayAll);
      expect(existsSync(fixtureIdentity(other.dir).gitDir)).toBe(true);
      const hasObject = (repo: string, sha: string): boolean =>
        spawnSync('git', ['-C', repo, 'cat-file', '-e', sha], { encoding: 'utf8' }).status === 0;
      const origBlobs = knownBlobs(dir, commit, coherentFiles);
      const pkgSha = origBlobs.find((row) => row.path === 'goal-gen/package.json')?.gitSha;
      const lockSha = origBlobs.find((row) => row.path === 'goal-gen/package-lock.json')?.gitSha;
      expect(pkgSha).toMatch(/^[0-9a-f]{40}$/);
      expect(lockSha).toMatch(/^[0-9a-f]{40}$/);
      expect(hasObject(other.dir, pkgSha!)).toBe(true);
      expect(hasObject(other.dir, lockSha!)).toBe(true);
      expect(hasObject(dir, other.commit)).toBe(false);

      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      for (const fromCapture of [comboBin, comboAll]) {
        for (const bundleDir of [nested, gitNested]) {
          stderrSpy.mockClear();
          stdoutSpy.mockClear();
          expect(
            await main([
              'acceptance',
              'verify-candidate',
              'package-manifest-lockfile',
              extraPath,
              '--from-capture',
              fromCapture,
              '--json',
              '--bundle-dir',
              bundleDir,
            ]),
          ).toBe(2);
          expect(stdoutText()).toBe('');
          expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
          expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
          expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
        }
      }

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          comboBin,
          '--json',
          '--bundle-dir',
          unrelatedDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(unrelatedDest, 'COMPLETE'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(other.dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayBin, { recursive: true, force: true });
      await rm(overlayAll, { recursive: true, force: true });
      await rm(comboBin, { recursive: true, force: true });
      await rm(comboAll, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(unrelatedDest, { recursive: true, force: true });
    }
  });

  it('rejects overlay persist when a symlink ancestor is retargeted into the source before write', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-persist-toctou-cap-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'cs-persist-toctou-out-'));
    const aliasParent = await mkdtemp(path.join(tmpdir(), 'cs-persist-toctou-alias-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-persist-toctou-work-'));
    const alias = path.join(aliasParent, 'alias');
    const dest = path.join(alias, 'evidence');
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
          captureDir,
        ]),
      ).toBe(0);
      symlinkSync(outside, alias);
      mkdirSync(dest, { recursive: true });
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      const retarget = (): void => {
        try {
          unlinkSync(alias);
          symlinkSync(dir, alias);
        } catch {
          // already retargeted
        }
      };
      const watcher = watch(tmpdir(), (_event, filename) => {
        if (typeof filename === 'string' && filename.startsWith('committed-source-')) retarget();
      });
      const poll = setInterval(() => {
        try {
          for (const name of readdirSync(tmpdir())) {
            if (name.startsWith('committed-source-')) retarget();
          }
        } catch {
          // tmpdir listing can race
        }
      }, 1);
      try {
        stderrSpy.mockClear();
        stdoutSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            captureDir,
            '--json',
            '--bundle-dir',
            dest,
          ]),
        ).toBe(2);
        expect(stdoutText()).toBe('');
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(existsSync(path.join(dir, 'evidence', 'COMPLETE'))).toBe(false);
        expect(existsSync(path.join(outside, 'evidence', 'COMPLETE'))).toBe(false);
      } finally {
        watcher.close();
        clearInterval(poll);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      await rm(aliasParent, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects capture persist when a symlink ancestor is retargeted into the source before write', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const outside = await mkdtemp(path.join(tmpdir(), 'cs-cap-persist-toctou-out-'));
    const aliasParent = await mkdtemp(path.join(tmpdir(), 'cs-cap-persist-toctou-alias-'));
    const alias = path.join(aliasParent, 'alias');
    const dest = path.join(alias, 'evidence');
    try {
      symlinkSync(outside, alias);
      mkdirSync(dest, { recursive: true });
      const retarget = (): void => {
        try {
          unlinkSync(alias);
          symlinkSync(dir, alias);
        } catch {
          // already retargeted
        }
      };
      const watcher = watch(tmpdir(), (_event, filename) => {
        if (typeof filename === 'string' && filename.startsWith('committed-source-')) retarget();
      });
      const poll = setInterval(() => {
        try {
          for (const name of readdirSync(tmpdir())) {
            if (name.startsWith('committed-source-')) retarget();
          }
        } catch {
          // tmpdir listing can race
        }
      }, 1);
      try {
        stderrSpy.mockClear();
        stdoutSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'capture-source',
            'package-manifest-lockfile',
            dir,
            commit,
            '--json',
            '--bundle-dir',
            dest,
          ]),
        ).toBe(2);
        expect(stdoutText()).toBe('');
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(existsSync(path.join(dir, 'evidence', 'COMPLETE'))).toBe(false);
        expect(existsSync(path.join(outside, 'evidence', 'COMPLETE'))).toBe(false);
      } finally {
        watcher.close();
        clearInterval(poll);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      await rm(aliasParent, { recursive: true, force: true });
    }
  });

  it('rejects overlay persist when dest ancestor is replaced after dest readdir', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-readdir-toctou-cap-'));
    const ancestorParent = await mkdtemp(path.join(tmpdir(), 'cs-readdir-toctou-anc-'));
    const ancestor = path.join(ancestorParent, 'real-anc');
    mkdirSync(ancestor);
    const dest = path.join(ancestor, 'evidence');
    mkdirSync(dest);
    const moved = path.join(ancestorParent, 'real-anc.moved');
    const honest = await mkdtemp(path.join(tmpdir(), 'cs-readdir-toctou-honest-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-readdir-toctou-work-'));
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      let snapshotSeen = false;
      let flipped = false;
      const destTouched = (): boolean => {
        try {
          const names = readdirSync(dest);
          return names.some(
            (name) => name === 'blobs' || name === 'manifest.json' || name === 'COMPLETE' || name === 'COMPLETE.tmp',
          );
        } catch {
          return false;
        }
      };
      const retarget = (): void => {
        if (!snapshotSeen || flipped) return;
        if (!destTouched()) return;
        try {
          renameSync(ancestor, moved);
          symlinkSync(dir, ancestor);
          flipped = true;
        } catch {
          // already retargeted
        }
      };
      const snapWatch = watch(tmpdir(), (_event, filename) => {
        if (typeof filename === 'string' && filename.startsWith('committed-source-')) snapshotSeen = true;
      });
      const destWatch = watch(dest, (_event, filename) => {
        if (
          typeof filename === 'string' &&
          (filename === 'blobs' ||
            filename === 'manifest.json' ||
            filename === 'COMPLETE' ||
            filename === 'COMPLETE.tmp')
        ) {
          retarget();
        }
      });
      const poll = setInterval(() => {
        try {
          for (const name of readdirSync(tmpdir())) {
            if (name.startsWith('committed-source-')) snapshotSeen = true;
          }
          retarget();
        } catch {
          // tmpdir listing can race
        }
      }, 1);
      try {
        stderrSpy.mockClear();
        stdoutSpy.mockClear();
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          dest,
        ]);
        expect(existsSync(path.join(dir, 'evidence', 'COMPLETE'))).toBe(false);
        expect(existsSync(path.join(dir, 'evidence', 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(dir, 'COMPLETE'))).toBe(false);
        expect(existsSync(path.join(dir, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(dir, 'blobs'))).toBe(false);
        expect(existsSync(path.join(dir, '.git', 'evidence', 'COMPLETE'))).toBe(false);
      } finally {
        destWatch.close();
        snapWatch.close();
        clearInterval(poll);
      }

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          honest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(honest, 'COMPLETE'))).toBe(true);
      expect(existsSync(path.join(dir, 'evidence', 'COMPLETE'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(ancestorParent, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(honest, { recursive: true, force: true });
    }
  });

  it('does not leave an empty dest directory in the source when missing dest ancestor is swapped', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-mkdir-follow-cap-'));
    const honest = await mkdtemp(path.join(tmpdir(), 'cs-mkdir-follow-honest-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-mkdir-follow-work-'));
    const extraPath = path.join(work, 'extra.json');
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
          captureDir,
        ]),
      ).toBe(0);
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');

      const runMissing = async (symlinkTarget: string, leftover: string): Promise<void> => {
        const ancestorParent = await mkdtemp(path.join(tmpdir(), 'cs-mkdir-follow-anc-'));
        const ancestor = path.join(ancestorParent, 'real-anc');
        mkdirSync(ancestor);
        const dest = path.join(ancestor, 'evidence');
        const moved = path.join(ancestorParent, 'real-anc.moved');
        let snapshotSeen = false;
        let flipped = false;
        const retarget = (): void => {
          if (!snapshotSeen || flipped) return;
          if (existsSync(dest)) return;
          try {
            renameSync(ancestor, moved);
            symlinkSync(symlinkTarget, ancestor);
            flipped = true;
          } catch {
            // already retargeted
          }
        };
        const snapWatch = watch(tmpdir(), (_event, filename) => {
          if (typeof filename === 'string' && filename.startsWith('committed-source-')) snapshotSeen = true;
        });
        const ancWatch = watch(ancestor, () => {
          retarget();
        });
        const poll = setInterval(() => {
          try {
            for (const name of readdirSync(tmpdir())) {
              if (name.startsWith('committed-source-')) snapshotSeen = true;
            }
            retarget();
          } catch {
            // tmpdir listing can race
          }
        }, 1);
        try {
          stderrSpy.mockClear();
          stdoutSpy.mockClear();
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            captureDir,
            '--json',
            '--bundle-dir',
            dest,
          ]);
          expect(existsSync(leftover)).toBe(false);
          expect(existsSync(path.join(leftover, 'COMPLETE'))).toBe(false);
        } finally {
          ancWatch.close();
          snapWatch.close();
          clearInterval(poll);
          await rm(ancestorParent, { recursive: true, force: true });
        }
      };

      await runMissing(dir, path.join(dir, 'evidence'));
      await runMissing(path.join(dir, '.git'), path.join(dir, '.git', 'evidence'));

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          honest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(honest, 'COMPLETE'))).toBe(true);
      expect(existsSync(path.join(dir, 'evidence'))).toBe(false);
      expect(existsSync(path.join(dir, '.git', 'evidence'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(honest, { recursive: true, force: true });
    }
  });

  it('creates missing dest parent directories via parent handles for capture and overlay', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureWork = await mkdtemp(path.join(tmpdir(), 'cs-miss-parent-cap-'));
    const overlayWork = await mkdtemp(path.join(tmpdir(), 'cs-miss-parent-ov-'));
    const honest = await mkdtemp(path.join(tmpdir(), 'cs-miss-parent-honest-'));
    try {
      const captureDest = path.join(captureWork, 'new', 'evidence');
      expect(existsSync(path.join(captureWork, 'new'))).toBe(false);
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          captureDest,
        ]),
      ).toBe(0);
      expect(existsSync(path.join(captureDest, 'COMPLETE'))).toBe(true);

      const extraPath = path.join(overlayWork, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      const overlayDest = path.join(overlayWork, 'new', 'evidence');
      expect(existsSync(path.join(overlayWork, 'new'))).toBe(false);
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDest,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(true);

      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDest,
          '--json',
          '--bundle-dir',
          honest,
        ]),
      ).toBe(0);
      expect(existsSync(path.join(honest, 'COMPLETE'))).toBe(true);

      const inside = path.join(dir, 'new', 'evidence');
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          inside,
        ]),
      ).toBe(2);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(inside, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(dir, 'evidence'))).toBe(false);
      expect(existsSync(path.join(dir, '.git', 'evidence'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureWork, { recursive: true, force: true });
      await rm(overlayWork, { recursive: true, force: true });
      await rm(honest, { recursive: true, force: true });
    }
  });

  it('rolls back created dest intermediates when stash is moved into source after mid appears', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const destWork = await mkdtemp(path.join(tmpdir(), 'cs-mkdir-inter-dest-'));
    const overlayWork = await mkdtemp(path.join(tmpdir(), 'cs-mkdir-inter-ovl-'));
    const honestCaptureWork = await mkdtemp(path.join(tmpdir(), 'cs-mkdir-inter-honest-cap-'));
    const honestOverlayWork = await mkdtemp(path.join(tmpdir(), 'cs-mkdir-inter-honest-ovl-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-mkdir-inter-work-'));
    const stash = path.join(destWork, 'stash');
    const dest = path.join(stash, 'mid', 'a', 'b', 'leaf');
    const stolen = path.join(dir, 'stolen-stash');
    const overlayStash = path.join(overlayWork, 'stash');
    const overlayDest = path.join(overlayStash, 'mid', 'a', 'b', 'leaf');
    const overlayStolen = path.join(dir, 'stolen-overlay-stash');
    const leftoverUnder = (root: string): string[] =>
      [
        path.join(root, 'mid'),
        path.join(root, 'mid', 'a'),
        path.join(root, 'mid', 'a', 'b'),
        path.join(root, 'mid', 'a', 'b', 'leaf'),
      ].filter((p) => existsSync(p));
    mkdirSync(stash);
    mkdirSync(overlayStash);
    let captureWorker: Worker | undefined;
    let overlayWorker: Worker | undefined;
    try {
      const captureSwap = startStashMidMoveIntoSourceWorker(stash, stolen);
      captureWorker = captureSwap.worker;
      await captureSwap.readyWait;
      expect(captureSwap.err()).toBeUndefined();
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const captureCode = await main([
        'acceptance',
        'capture-source',
        'package-manifest-lockfile',
        dir,
        commit,
        '--json',
        '--bundle-dir',
        dest,
      ]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(captureSwap.err()).toBeUndefined();
      expect(captureSwap.flipped()).toBe(true);
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(captureCode).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(dest, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(stolen, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(stolen, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(stolen, 'blobs'))).toBe(false);
      expect(leftoverUnder(stolen)).toEqual([]);
      expect(leftoverUnder(dir)).toEqual([]);

      const honestCapture = path.join(honestCaptureWork, 'new', 'evidence');
      expect(existsSync(path.join(honestCaptureWork, 'new'))).toBe(false);
      stdoutSpy.mockClear();
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
          honestCapture,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(honestCapture, 'COMPLETE'))).toBe(true);

      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      const overlaySwap = startStashMidMoveIntoSourceWorker(overlayStash, overlayStolen);
      overlayWorker = overlaySwap.worker;
      await overlaySwap.readyWait;
      expect(overlaySwap.err()).toBeUndefined();
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const overlayCode = await main([
        'acceptance',
        'verify-candidate',
        'package-manifest-lockfile',
        extraPath,
        '--from-capture',
        honestCapture,
        '--json',
        '--bundle-dir',
        overlayDest,
      ]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(overlaySwap.err()).toBeUndefined();
      expect(overlaySwap.flipped()).toBe(true);
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(overlayCode).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(overlayStolen, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(overlayStolen, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(overlayStolen, 'blobs'))).toBe(false);
      expect(leftoverUnder(overlayStolen)).toEqual([]);

      const honestOverlay = path.join(honestOverlayWork, 'new', 'evidence');
      expect(existsSync(path.join(honestOverlayWork, 'new'))).toBe(false);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          honestCapture,
          '--json',
          '--bundle-dir',
          honestOverlay,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(honestOverlay, 'COMPLETE'))).toBe(true);
    } finally {
      captureWorker?.terminate();
      overlayWorker?.terminate();
      await rm(dir, { recursive: true, force: true });
      await rm(destWork, { recursive: true, force: true });
      await rm(overlayWork, { recursive: true, force: true });
      await rm(honestCaptureWork, { recursive: true, force: true });
      await rm(honestOverlayWork, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(stolen, { recursive: true, force: true });
      await rm(overlayStolen, { recursive: true, force: true });
    }
  });

  it('holds the created dest child inode before the final name is visible', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'cs-mkdir-open-hold-'));
    const parent = path.join(work, 'parent');
    const stolen = path.join(work, 'stolen');
    mkdirSync(parent);
    const flags =
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0);
    const parentFd = openSync(parent, flags);
    try {
      const opened = openOrMkdirHeldPersistChild(parentFd, 'mid', parent);
      expect(opened.created).toBe(true);
      const held = fstatSync(opened.fd);
      const child = path.join(parent, 'mid');
      expect(lstatSync(child).ino).toBe(held.ino);
      expect(lstatSync(child).dev).toBe(held.dev);
      expect(readdirSync(parent).filter((name) => name.startsWith('persist-mkdir-'))).toEqual([]);
      renameSync(child, stolen);
      mkdirSync(child);
      const replacement = lstatSync(child);
      expect(replacement.ino).not.toBe(held.ino);
      rollbackCreatedPersistDirectories([opened.fd]);
      expect(existsSync(stolen)).toBe(false);
      expect(existsSync(child)).toBe(true);
      expect(lstatSync(child).ino).toBe(replacement.ino);
      expect(lstatSync(child).dev).toBe(replacement.dev);
      try {
        closeSync(opened.fd);
      } catch {
        // already closed
      }

      mkdirSync(path.join(parent, 'stash'));
      const existing = openOrMkdirHeldPersistChild(parentFd, 'stash', parent);
      expect(existing.created).toBe(false);
      const stashStat = lstatSync(path.join(parent, 'stash'));
      expect(fstatSync(existing.fd).ino).toBe(stashStat.ino);
      rollbackCreatedPersistDirectories([]);
      expect(existsSync(path.join(parent, 'stash'))).toBe(true);
      expect(lstatSync(path.join(parent, 'stash')).ino).toBe(stashStat.ino);
      try {
        closeSync(existing.fd);
      } catch {
        // already closed
      }
    } finally {
      try {
        closeSync(parentFd);
      } catch {
        // already closed
      }
      await rm(work, { recursive: true, force: true });
    }
  });

  it('does not replace a concurrent empty dest child at the final name', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'cs-rename-noreplace-'));
    const parent = path.join(work, 'parent');
    mkdirSync(parent);
    const flags =
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0);
    const parentFd = openSync(parent, flags);
    let tmpFd: number | undefined;
    let concurrentFd: number | undefined;
    let openedFd: number | undefined;
    try {
      const tmpName = 'persist-mkdir-noreplace-tmp';
      const tmpPath = path.join(parent, tmpName);
      const childPath = path.join(parent, 'mid');
      mkdirSync(tmpPath);
      tmpFd = openSync(tmpPath, flags);
      const tmpHeld = fstatSync(tmpFd);
      mkdirSync(childPath);
      concurrentFd = openSync(childPath, flags);
      const concurrent = fstatSync(concurrentFd);
      expect(concurrent.ino).not.toBe(tmpHeld.ino);
      let thrown: NodeJS.ErrnoException | undefined;
      try {
        persistRenameNoReplaceChild(parentFd, tmpName, 'mid', parent);
      } catch (err) {
        thrown = err as NodeJS.ErrnoException;
      }
      expect(thrown?.code).toBe('EEXIST');
      expect(fstatSync(concurrentFd).nlink).toBe(concurrent.nlink);
      expect(fstatSync(concurrentFd).ino).toBe(concurrent.ino);
      expect(lstatSync(childPath).ino).toBe(concurrent.ino);
      expect(lstatSync(childPath).dev).toBe(concurrent.dev);
      expect(existsSync(tmpPath)).toBe(true);
      expect(fstatSync(tmpFd).ino).toBe(tmpHeld.ino);
      expect(fstatSync(tmpFd).nlink).toBe(tmpHeld.nlink);
      rmdirSync(tmpPath);
      const opened = openOrMkdirHeldPersistChild(parentFd, 'mid', parent);
      openedFd = opened.fd;
      expect(opened.created).toBe(false);
      expect(fstatSync(opened.fd).ino).toBe(concurrent.ino);
      rollbackCreatedPersistDirectories([]);
      expect(existsSync(childPath)).toBe(true);
      expect(lstatSync(childPath).ino).toBe(concurrent.ino);
    } finally {
      for (const fd of [openedFd, concurrentFd, tmpFd, parentFd]) {
        if (fd === undefined) continue;
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      }
      await rm(work, { recursive: true, force: true });
    }
  });

  it('resolves process libc from /proc/self/maps without glibc sonames', () => {
    const alpine = [
      '7f0000000000-7f0000001000 r--p 00000000 00:00 0 [vvar]',
      '7f8a2c3b0000-7f8a2c3d8000 r-xp 00000000 00:13 1 /lib/libc.musl-x86_64.so.1',
      '7f8a2c3d8000-7f8a2c3dc000 r--p 00028000 00:13 1 /lib/libc.musl-x86_64.so.1',
    ].join('\n');
    expect(libcPathFromProcMaps(alpine)).toBe('/lib/libc.musl-x86_64.so.1');
    expect(libcPathFromProcMaps('7f00-7f01 r-xp 00000000 00:00 0 /lib/ld-musl-x86_64.so.1')).toBe(
      '/lib/ld-musl-x86_64.so.1',
    );
    expect(libcPathFromProcMaps('7f00-7f01 r-xp 00000000 00:00 0 /usr/lib/libcap.so.2')).toBeUndefined();
    const glibc = '7ffff7c2a000-7ffff7ddf000 r-xp 00025000 08:01 1234 /usr/lib/x86_64-linux-gnu/libc.so.6';
    expect(libcPathFromProcMaps(glibc)).toBe('/usr/lib/x86_64-linux-gnu/libc.so.6');
    const live = resolveProcessLibcPath();
    expect(live).toBeDefined();
    expect(existsSync(live!)).toBe(true);
    expect(path.basename(live!).startsWith('libc')).toBe(true);
  });

  it('rolls back the held created dest inode when its pathname is replaced', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'cs-pathname-rollback-'));
    const created = path.join(work, 'created');
    const stolen = path.join(work, 'stolen');
    mkdirSync(created);
    const flags =
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0);
    const fd = openSync(created, flags);
    try {
      const held = fstatSync(fd);
      renameSync(created, stolen);
      mkdirSync(created);
      const replacement = lstatSync(created);
      expect(replacement.ino).not.toBe(held.ino);
      rollbackCreatedPersistDirectories([fd]);
      expect(existsSync(stolen)).toBe(false);
      expect(existsSync(created)).toBe(true);
      expect(lstatSync(created).ino).toBe(replacement.ino);
      expect(lstatSync(created).dev).toBe(replacement.dev);
    } finally {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      await rm(work, { recursive: true, force: true });
    }
  });

  it('does not follow dest/blobs symlink into the captured source during persist', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const pkgPath = path.join(dir, 'goal-gen', 'package.json');
    const originalPkg = readFileSync(pkgPath, 'utf8');
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-blobs-sym-cap-'));
    const dest = await mkdtemp(path.join(tmpdir(), 'cs-blobs-sym-dest-'));
    const honest = await mkdtemp(path.join(tmpdir(), 'cs-blobs-sym-honest-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-blobs-sym-work-'));
    const overlayCap = await mkdtemp(path.join(tmpdir(), 'cs-blobs-sym-ovcap-'));
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayCap,
        ]),
      ).toBe(0);
      const overlayed = readPersistedCommittedSourceBundle(overlayCap);
      try {
        persistCommittedSourceBundle(dest, overlayed, overlayed.blobs, () => {
          symlinkSync(dir, path.join(dest, 'blobs'));
        });
      } catch {
        // dest-child symlink may fail closed
      }
      expect(readFileSync(pkgPath, 'utf8')).toBe(originalPkg);
      expect(readFileSync(pkgPath, 'utf8').includes('captured-base extra-field alternative')).toBe(false);

      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          honest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(honest, 'COMPLETE'))).toBe(true);
      const honestBlobs = lstatSync(path.join(honest, 'blobs'));
      expect(honestBlobs.isDirectory()).toBe(true);
      expect(honestBlobs.isSymbolicLink()).toBe(false);
      expect(readFileSync(pkgPath, 'utf8')).toBe(originalPkg);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
      await rm(honest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(overlayCap, { recursive: true, force: true });
    }
  });

  it('refuses capture and overlay --bundle-dir inside a checkout whose directory name ends in whitespace', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'cs-ws-top-'));
    const dir = path.join(parent, 'ws-src ');
    mkdirSync(dir);
    gitIsolated(dir, ['init', '-q']);
    applyFiles(dir, coherentFiles);
    const commit = commitAll(dir, 'fixture');
    const captureDest = path.join(dir, 'evidence');
    mkdirSync(captureDest, { recursive: true });
    const overlayDest = path.join(dir, 'overlay-evidence');
    mkdirSync(overlayDest, { recursive: true });
    const honest = await mkdtemp(path.join(tmpdir(), 'cs-ws-honest-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-ws-work-'));
    try {
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          captureDest,
        ]),
      ).toBe(2);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(captureDest, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(dir, 'evidence', 'COMPLETE'))).toBe(false);

      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          honest,
        ]),
      ).toBe(0);
      expect(existsSync(path.join(honest, 'COMPLETE'))).toBe(true);

      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          honest,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(2);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(honest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('refuses capture and overlay --bundle-dir inside a checkout whose directory name ends in CR', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'cs-cr-top-'));
    const dir = path.join(parent, 'cr-src\r');
    mkdirSync(dir);
    gitIsolated(dir, ['init', '-q']);
    applyFiles(dir, coherentFiles);
    const commit = commitAll(dir, 'fixture');
    const captureDest = path.join(dir, 'evidence');
    mkdirSync(captureDest, { recursive: true });
    const overlayDest = path.join(dir, 'overlay-evidence');
    mkdirSync(overlayDest, { recursive: true });
    const honest = await mkdtemp(path.join(tmpdir(), 'cs-cr-honest-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-cr-work-'));
    try {
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          captureDest,
        ]),
      ).toBe(2);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(captureDest, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(dir, 'evidence', 'COMPLETE'))).toBe(false);

      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          honest,
        ]),
      ).toBe(0);
      expect(existsSync(path.join(honest, 'COMPLETE'))).toBe(true);

      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          honest,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(2);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(honest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects gone-source overlay persist when selected and captured modes are unsupported', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-mode-cap-'));
    const digestDest = await mkdtemp(path.join(tmpdir(), 'cs-mode-digest-'));
    const unauthDest = await mkdtemp(path.join(tmpdir(), 'cs-mode-unauth-'));
    const honestDest = await mkdtemp(path.join(tmpdir(), 'cs-mode-honest-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-mode-work-'));
    const digestCombo = await mkdtemp(path.join(tmpdir(), 'cs-mode-digest-combo-'));
    const unauthCombo = await mkdtemp(path.join(tmpdir(), 'cs-mode-unauth-combo-'));
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
          captureDir,
        ]),
      ).toBe(0);
      copyCaptureTree(captureDir, digestCombo);
      copyCaptureTree(captureDir, unauthCombo);
      const plantModes = (bundleDir: string, digest?: string): void => {
        const manifestPath = path.join(bundleDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          profile: { digest: string };
          source: {
            selected: Array<{ path: string; mode: string }>;
            captured: Array<{ path: string; mode: string }>;
          };
        };
        if (digest !== undefined) manifest.profile.digest = digest;
        for (const row of manifest.source.selected) row.mode = '100600';
        for (const row of manifest.source.captured) row.mode = '100600';
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      };
      plantModes(digestCombo, '0'.repeat(64));
      plantModes(unauthCombo);
      await rm(dir, { recursive: true, force: true });

      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      const unauthPath = path.join(work, 'unauth.json');
      await writeFile(unauthPath, fileContentCandidate({ 'goal-gen/extra.txt': 'nope\n' }), 'utf8');

      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          digestCombo,
          '--json',
          '--bundle-dir',
          digestDest,
        ]),
      ).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/unsupported captured blob mode: 100600/);
      expect(existsSync(path.join(digestDest, 'COMPLETE'))).toBe(false);

      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          unauthPath,
          '--from-capture',
          unauthCombo,
          '--json',
          '--bundle-dir',
          unauthDest,
        ]),
      ).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/unsupported captured blob mode: 100600/);
      expect(existsSync(path.join(unauthDest, 'COMPLETE'))).toBe(false);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          honestDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(honestDest, 'COMPLETE'))).toBe(true);
    } finally {
      await rm(captureDir, { recursive: true, force: true });
      await rm(digestDest, { recursive: true, force: true });
      await rm(unauthDest, { recursive: true, force: true });
      await rm(honestDest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(digestCombo, { recursive: true, force: true });
      await rm(unauthCombo, { recursive: true, force: true });
    }
  });

  it('allows overlay --bundle-dir inside an unrelated bare repo that shares only HEAD canary bytes', async () => {
    const workA = await fixtureRepo(coherentFiles);
    const workB = await fixtureRepo({
      'goal-gen/package.json': extraFieldManifest(),
      'goal-gen/package-lock.json': `${JSON.stringify(
        {
          name: 'bare-b',
          version: '0.0.1',
          lockfileVersion: 3,
          packages: { '': { name: 'bare-b', version: '0.0.1' } },
        },
        null,
        2,
      )}\n`,
      'goal-gen/bin/goal-gen.mjs': '#!/usr/bin/env node\nexport const bareB = true;\n',
    });
    const parentA = await mkdtemp(path.join(tmpdir(), 'cs-bare-a-'));
    const parentB = await mkdtemp(path.join(tmpdir(), 'cs-bare-b-'));
    const bareA = path.join(parentA, 'repo.git');
    const bareB = path.join(parentB, 'repo.git');
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-bare-cap-'));
    const emptyDest = await mkdtemp(path.join(tmpdir(), 'cs-bare-empty-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-bare-work-'));
    try {
      gitIsolated(parentA, ['clone', '--bare', '-q', workA.dir, bareA]);
      gitIsolated(parentB, ['clone', '--bare', '-q', workB.dir, bareB]);
      const headA = readFileSync(path.join(bareA, 'HEAD'), 'utf8');
      const headB = readFileSync(path.join(bareB, 'HEAD'), 'utf8');
      expect(headA).toBe(headB);
      expect(existsSync(path.join(bareA, 'index'))).toBe(false);
      expect(existsSync(path.join(bareB, 'index'))).toBe(false);

      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          bareA,
          workA.commit,
          '--json',
          '--bundle-dir',
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      const otherDest = path.join(bareB, 'evidence');
      const capturedDest = path.join(bareA, 'evidence');

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          otherDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(otherDest, 'COMPLETE'))).toBe(true);

      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          capturedDest,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(capturedDest, 'COMPLETE'))).toBe(false);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          emptyDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(emptyDest, 'COMPLETE'))).toBe(true);
    } finally {
      await rm(workA.dir, { recursive: true, force: true });
      await rm(workB.dir, { recursive: true, force: true });
      await rm(parentA, { recursive: true, force: true });
      await rm(parentB, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(emptyDest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('allows overlay --bundle-dir inside an unrelated checkout that shares one captured blob', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-shared-blob-cap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-shared-blob-work-'));
    const shared = await fixtureRepo({
      'goal-gen/package.json': coherentFiles['goal-gen/package.json'],
      'goal-gen/package-lock.json': `${JSON.stringify(
        {
          name: 'other',
          version: '9.9.9',
          lockfileVersion: 3,
          packages: { '': { name: 'other', version: '9.9.9' } },
        },
        null,
        2,
      )}\n`,
      'goal-gen/bin/goal-gen.mjs': '#!/usr/bin/env node\nexport const other = true;\n',
      'README.md': 'unrelated checkout\n',
    });
    const none = await fixtureRepo({
      'goal-gen/package.json': mismatchedManifest(),
      'goal-gen/package-lock.json': `${JSON.stringify(
        {
          name: 'none',
          version: '0.0.1',
          lockfileVersion: 3,
          packages: { '': { name: 'none', version: '0.0.1' } },
        },
        null,
        2,
      )}\n`,
      'goal-gen/bin/goal-gen.mjs': '#!/usr/bin/env node\nexport const none = true;\n',
    });
    const sharedEvidence = path.join(shared.dir, 'evidence');
    const noneEvidence = path.join(none.dir, 'evidence');
    const sourceEvidence = path.join(dir, 'evidence');
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
          captureDir,
        ]),
      ).toBe(0);
      const captured = (
        JSON.parse(stdoutText()) as {
          source: { captured: Array<{ path: string; gitSha: string }>; commit: string };
        }
      ).source;
      expect(captured.commit).toBe(commit);
      expect(shared.commit).not.toBe(commit);
      const pkgSha = captured.captured.find((row) => row.path === 'goal-gen/package.json')?.gitSha;
      const lockSha = captured.captured.find((row) => row.path === 'goal-gen/package-lock.json')?.gitSha;
      const binSha = captured.captured.find((row) => row.path === 'goal-gen/bin/goal-gen.mjs')?.gitSha;
      expect(pkgSha).toMatch(/^[0-9a-f]{40}$/);
      expect(lockSha).toMatch(/^[0-9a-f]{40}$/);
      expect(binSha).toMatch(/^[0-9a-f]{40}$/);
      const hasObject = (repo: string, sha: string): boolean =>
        spawnSync('git', ['-C', repo, 'cat-file', '-e', sha], { encoding: 'utf8' }).status === 0;
      expect(hasObject(shared.dir, pkgSha!)).toBe(true);
      expect(hasObject(shared.dir, lockSha!)).toBe(false);
      expect(hasObject(shared.dir, binSha!)).toBe(false);
      expect(hasObject(shared.dir, commit)).toBe(false);
      expect(hasObject(none.dir, pkgSha!)).toBe(false);
      expect(hasObject(none.dir, lockSha!)).toBe(false);
      expect(hasObject(none.dir, binSha!)).toBe(false);
      expect(path.resolve(sharedEvidence).startsWith(`${path.resolve(dir)}${path.sep}`)).toBe(false);

      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          sharedEvidence,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(sharedEvidence, 'COMPLETE'))).toBe(true);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          noneEvidence,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(noneEvidence, 'COMPLETE'))).toBe(true);

      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          sourceEvidence,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(sourceEvidence, 'COMPLETE'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(shared.dir, { recursive: true, force: true });
      await rm(none.dir, { recursive: true, force: true });
    }
  });

  it('allows overlay --bundle-dir inside an unrelated git checkout used as evidence storage', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-unrelated-cap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-unrelated-work-'));
    const unrelated = await fixtureRepo({ 'notes.txt': 'evidence-store\n' });
    const evidence = path.join(unrelated.dir, 'evidence');
    const sourceNested = path.join(dir, 'evidence');
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      const unrelatedHead = gitFileHash(unrelated.dir, 'HEAD');
      const unrelatedIndex = gitFileHash(unrelated.dir, 'index');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          evidence,
        ]),
      ).toBe(0);
      expect(existsSync(path.join(evidence, 'manifest.json'))).toBe(true);
      expect(existsSync(path.join(evidence, 'COMPLETE'))).toBe(true);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(gitFileHash(unrelated.dir, 'HEAD')).toBe(unrelatedHead);
      expect(gitFileHash(unrelated.dir, 'index')).toBe(unrelatedIndex);

      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          sourceNested,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(sourceNested, 'manifest.json'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(unrelated.dir, { recursive: true, force: true });
    }
  });

  it('allows chained overlay --bundle-dir inside an unrelated git checkout used as evidence storage', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-chained-unrel-cap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-chained-unrel-work-'));
    const emptyDest = await mkdtemp(path.join(tmpdir(), 'cs-chained-unrel-empty-'));
    const unrelated = await fixtureRepo({ 'notes.txt': 'evidence-store\n' });
    const firstDest = path.join(unrelated.dir, 'evidence-first');
    const chainedDest = path.join(unrelated.dir, 'evidence-chained');
    const sourceNested = path.join(dir, 'evidence');
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      const unrelatedHead = gitFileHash(unrelated.dir, 'HEAD');
      const unrelatedIndex = gitFileHash(unrelated.dir, 'index');

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          firstDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(firstDest, 'COMPLETE'))).toBe(true);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          firstDest,
          '--json',
          '--bundle-dir',
          chainedDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(chainedDest, 'COMPLETE'))).toBe(true);
      expect(existsSync(path.join(chainedDest, 'manifest.json'))).toBe(true);
      expect(gitFileHash(unrelated.dir, 'HEAD')).toBe(unrelatedHead);
      expect(gitFileHash(unrelated.dir, 'index')).toBe(unrelatedIndex);

      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          firstDest,
          '--json',
          '--bundle-dir',
          sourceNested,
        ]),
      ).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(sourceNested, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(sourceNested, 'manifest.json'))).toBe(false);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          firstDest,
          '--json',
          '--bundle-dir',
          emptyDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(emptyDest, 'COMPLETE'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(emptyDest, { recursive: true, force: true });
      await rm(unrelated.dir, { recursive: true, force: true });
    }
  });

  it('persists overlay --bundle-dir in an unrelated empty dest after the captured checkout is gone', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-gone-src-cap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-gone-src-work-'));
    const overlayOut = await mkdtemp(path.join(tmpdir(), 'cs-gone-src-out-'));
    const liveNested = path.join(dir, 'evidence');
    const liveGitNested = path.join(dir, '.git', 'evidence');
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      for (const bundleDir of [liveNested, liveGitNested]) {
        stderrSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            captureDir,
            '--json',
            '--bundle-dir',
            bundleDir,
          ]),
        ).toBe(2);
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
      }

      await rm(dir, { recursive: true, force: true });
      expect(existsSync(dir)).toBe(false);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayOut,
        ]),
      ).toBe(0);
      expect(existsSync(path.join(overlayOut, 'manifest.json'))).toBe(true);
      expect(existsSync(path.join(overlayOut, 'COMPLETE'))).toBe(true);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(overlayOut, { recursive: true, force: true });
    }
  });

  it('refuses overlay --bundle-dir in the original captured source after a symlink repoPath is retargeted', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const retarget = await fixtureRepo({ 'notes.txt': 'other-repo\n' });
    const aliasHome = await mkdtemp(path.join(tmpdir(), 'cs-alias-home-'));
    const alias = path.join(aliasHome, 'repo');
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-alias-cap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-alias-work-'));
    const overlayOut = await mkdtemp(path.join(tmpdir(), 'cs-alias-out-'));
    const originalNested = path.join(dir, 'evidence');
    const originalGitNested = path.join(dir, '.git', 'evidence');
    const liveNested = path.join(retarget.dir, 'evidence');
    symlinkSync(dir, alias);
    try {
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          alias,
          commit,
          '--json',
          '--bundle-dir',
          captureDir,
        ]),
      ).toBe(0);
      unlinkSync(alias);
      symlinkSync(retarget.dir, alias);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      for (const bundleDir of [originalNested, originalGitNested, liveNested]) {
        stderrSpy.mockClear();
        expect(
          await main([
            'acceptance',
            'verify-candidate',
            'package-manifest-lockfile',
            extraPath,
            '--from-capture',
            captureDir,
            '--json',
            '--bundle-dir',
            bundleDir,
          ]),
        ).toBe(2);
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(existsSync(path.join(bundleDir, 'manifest.json'))).toBe(false);
        expect(existsSync(path.join(bundleDir, 'COMPLETE'))).toBe(false);
      }
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayOut,
        ]),
      ).toBe(0);
      expect(existsSync(path.join(overlayOut, 'COMPLETE'))).toBe(true);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(retarget.dir, { recursive: true, force: true });
      await rm(aliasHome, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(overlayOut, { recursive: true, force: true });
    }
  });

  it('refuses capture --bundle-dir inside a worktree retargeted between identity resolve and object reads', async () => {
    const decoy = await fixtureRepo(coherentFiles);
    const cloneHome = await mkdtemp(path.join(tmpdir(), 'cs-toctou-clone-'));
    const target = path.join(cloneHome, 'toctou-target');
    gitIsolated(cloneHome, ['clone', '-q', decoy.dir, target]);
    const aliasHome = await mkdtemp(path.join(tmpdir(), 'cs-toctou-alias-'));
    const alias = path.join(aliasHome, 'repo');
    symlinkSync(decoy.dir, alias);
    const wrapperDir = await mkdtemp(path.join(tmpdir(), 'cs-toctou-git-'));
    const countPath = path.join(wrapperDir, 'absolute-git-dir.count');
    writeFileSync(countPath, '0\n', 'utf8');
    const hostGit = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((dir) => path.join(dir, 'git'))
      .find((candidate) => existsSync(candidate));
    if (hostGit === undefined) throw new Error('expected git on PATH');
    writeFileSync(
      path.join(wrapperDir, 'git'),
      `#!/bin/sh
real_git=${JSON.stringify(hostGit)}
count_file=${JSON.stringify(countPath)}
alias_path=${JSON.stringify(alias)}
target_path=${JSON.stringify(target)}
flip=0
for arg in "$@"; do
  if [ "$arg" = "--absolute-git-dir" ]; then
    flip=1
  fi
done
if [ "$flip" = 1 ]; then
  n=$(cat "$count_file")
  n=$((n + 1))
  printf '%s\\n' "$n" > "$count_file"
  if [ "$n" = 2 ]; then
    rm -f "$alias_path"
    ln -s "$target_path" "$alias_path"
  fi
fi
exec "$real_git" "$@"
`,
      'utf8',
    );
    chmodSync(path.join(wrapperDir, 'git'), 0o755);
    const evidence = path.join(target, 'evidence');
    const previousPath = process.env.PATH ?? '';
    try {
      process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath}`;
      stderrSpy.mockClear();
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          alias,
          decoy.commit,
          '--json',
          '--bundle-dir',
          evidence,
        ]),
      ).toBe(2);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(evidence, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(evidence, 'COMPLETE'))).toBe(false);
    } finally {
      process.env.PATH = previousPath;
      await rm(decoy.dir, { recursive: true, force: true });
      await rm(cloneHome, { recursive: true, force: true });
      await rm(aliasHome, { recursive: true, force: true });
      await rm(wrapperDir, { recursive: true, force: true });
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

  it('rejects selected blobs without matching captured identity before snapshot', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const allMissing = await mkdtemp(path.join(tmpdir(), 'cs-caprow-all-'));
    const oneMissing = await mkdtemp(path.join(tmpdir(), 'cs-caprow-one-'));
    const overlayMissing = await mkdtemp(path.join(tmpdir(), 'cs-caprow-overlay-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-caprow-overlay-out-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-caprow-work-'));
    try {
      for (const bundleDir of [allMissing, oneMissing, overlayMissing]) {
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
      }

      const rewriteCaptured = (
        bundleDir: string,
        captured: { path: string; mode: string; type: string; gitSha: string }[],
      ): void => {
        const manifestPath = path.join(bundleDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          source: { captured: { path: string; mode: string; type: string; gitSha: string }[] };
        };
        manifest.source.captured = captured;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      };

      rewriteCaptured(allMissing, []);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', allMissing, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/captured/);

      const oneManifest = JSON.parse(readFileSync(path.join(oneMissing, 'manifest.json'), 'utf8')) as {
        source: { captured: { path: string; mode: string; type: string; gitSha: string }[] };
      };
      rewriteCaptured(
        oneMissing,
        oneManifest.source.captured.filter((row) => row.path !== 'goal-gen/package.json'),
      );
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', oneMissing, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/package\.json/);

      rewriteCaptured(overlayMissing, []);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          overlayMissing,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(existsSync(path.join(overlayDest, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(allMissing, { recursive: true, force: true });
      await rm(oneMissing, { recursive: true, force: true });
      await rm(overlayMissing, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects overlay-null blob replace that retargets selected hash', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const retarget = await mkdtemp(path.join(tmpdir(), 'cs-blobid-retarget-'));
    const control = await mkdtemp(path.join(tmpdir(), 'cs-blobid-control-'));
    const overlaySrc = await mkdtemp(path.join(tmpdir(), 'cs-blobid-overlay-src-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-blobid-overlay-out-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-blobid-work-'));
    try {
      for (const bundleDir of [retarget, control, overlaySrc]) {
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
      }

      const tamper = (bundleDir: string, updateSelected: boolean): void => {
        const extra = Buffer.from(extraFieldManifest());
        writeFileSync(path.join(bundleDir, 'blobs', 'goal-gen', 'package.json'), extra);
        if (!updateSelected) return;
        const manifestPath = path.join(bundleDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          source: {
            overlay: null;
            selected: { path: string; sha256: string; byteLength: number }[];
            captured: { path: string; sha256: string; gitSha: string }[];
          };
        };
        expect(manifest.source.overlay).toBeNull();
        const selected = manifest.source.selected.find((row) => row.path === 'goal-gen/package.json');
        const captured = manifest.source.captured.find((row) => row.path === 'goal-gen/package.json');
        expect(selected).toBeDefined();
        expect(captured).toBeDefined();
        expect(captured!.sha256).not.toBe(sha256Hex(extra));
        selected!.sha256 = sha256Hex(extra);
        selected!.byteLength = extra.length;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      };

      tamper(retarget, true);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', retarget, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/package\.json/);

      tamper(control, false);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', control, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(JSON.parse(stderrText()).error.message).toMatch(/do not match manifest/);

      tamper(overlaySrc, true);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          overlaySrc,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(existsSync(path.join(overlayDest, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(retarget, { recursive: true, force: true });
      await rm(control, { recursive: true, force: true });
      await rm(overlaySrc, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects coherent captured-row rewrite that keeps source.commit', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const coherentDest = await mkdtemp(path.join(tmpdir(), 'cs-coherent-cap-'));
    const control = await mkdtemp(path.join(tmpdir(), 'cs-coherent-cap-control-'));
    const overlaySrc = await mkdtemp(path.join(tmpdir(), 'cs-coherent-cap-overlay-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-coherent-cap-out-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-coherent-cap-work-'));
    try {
      for (const bundleDir of [coherentDest, control, overlaySrc]) {
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
      }

      const extra = Buffer.from(extraFieldManifest());
      const tamper = (bundleDir: string, rewriteCaptured: boolean): void => {
        writeFileSync(path.join(bundleDir, 'blobs', 'goal-gen', 'package.json'), extra);
        const manifestPath = path.join(bundleDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          source: {
            overlay: null;
            commit: string;
            selected: { path: string; sha256: string; byteLength: number }[];
            captured: {
              path: string;
              mode: string;
              type: string;
              gitSha: string;
              sha256: string;
              byteLength: number;
            }[];
          };
        };
        expect(manifest.source.overlay).toBeNull();
        expect(manifest.source.commit).toBe(commit);
        const selected = manifest.source.selected.find((row) => row.path === 'goal-gen/package.json');
        const captured = manifest.source.captured.find((row) => row.path === 'goal-gen/package.json');
        expect(selected).toBeDefined();
        expect(captured).toBeDefined();
        expect(captured!.sha256).not.toBe(sha256Hex(extra));
        selected!.sha256 = sha256Hex(extra);
        selected!.byteLength = extra.length;
        if (rewriteCaptured) {
          captured!.sha256 = sha256Hex(extra);
          captured!.byteLength = extra.length;
          captured!.gitSha = gitBlobSha1(extra);
        }
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      };

      tamper(coherentDest, true);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', coherentDest, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/source\.commit/);

      tamper(control, false);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', control, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/captured identity/);

      tamper(overlaySrc, true);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          overlaySrc,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(existsSync(path.join(overlayDest, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(coherentDest, { recursive: true, force: true });
      await rm(control, { recursive: true, force: true });
      await rm(overlaySrc, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects duplicate captured rows that retarget selected bytes', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const dupDest = await mkdtemp(path.join(tmpdir(), 'cs-dup-cap-'));
    const control = await mkdtemp(path.join(tmpdir(), 'cs-dup-cap-control-'));
    const overlaySrc = await mkdtemp(path.join(tmpdir(), 'cs-dup-cap-overlay-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-dup-cap-out-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-dup-cap-work-'));
    try {
      for (const bundleDir of [dupDest, control, overlaySrc]) {
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
      }

      const extra = Buffer.from(extraFieldManifest());
      const tamper = (bundleDir: string, duplicateCaptured: boolean): void => {
        writeFileSync(path.join(bundleDir, 'blobs', 'goal-gen', 'package.json'), extra);
        const manifestPath = path.join(bundleDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          source: {
            overlay: null;
            commit: string;
            selected: { path: string; sha256: string; byteLength: number }[];
            captured: {
              path: string;
              mode: string;
              type: string;
              gitSha: string;
              sha256: string;
              byteLength: number;
            }[];
          };
        };
        expect(manifest.source.overlay).toBeNull();
        const selected = manifest.source.selected.find((row) => row.path === 'goal-gen/package.json');
        const captured = manifest.source.captured.find((row) => row.path === 'goal-gen/package.json');
        expect(selected).toBeDefined();
        expect(captured).toBeDefined();
        expect(captured!.sha256).not.toBe(sha256Hex(extra));
        selected!.sha256 = sha256Hex(extra);
        selected!.byteLength = extra.length;
        if (duplicateCaptured) {
          manifest.source.captured.push({
            ...captured!,
            sha256: sha256Hex(extra),
            byteLength: extra.length,
            gitSha: gitBlobSha1(extra),
          });
        }
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      };

      tamper(dupDest, true);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', dupDest, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/duplicate captured blob path/);

      tamper(control, false);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', control, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/captured identity/);

      tamper(overlaySrc, true);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          overlaySrc,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(existsSync(path.join(overlayDest, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(dupDest, { recursive: true, force: true });
      await rm(control, { recursive: true, force: true });
      await rm(overlaySrc, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects coherent captured-row rewrite when source.identity is missing or malformed', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const deleted = await mkdtemp(path.join(tmpdir(), 'cs-noid-del-'));
    const nulled = await mkdtemp(path.join(tmpdir(), 'cs-noid-null-'));
    const relative = await mkdtemp(path.join(tmpdir(), 'cs-noid-rel-'));
    const keepIdentity = await mkdtemp(path.join(tmpdir(), 'cs-noid-keep-'));
    try {
      for (const bundleDir of [deleted, nulled, relative, keepIdentity]) {
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
      }

      const extra = Buffer.from(extraFieldManifest());
      const tamper = (bundleDir: string, identity: 'delete' | 'null' | 'relative' | 'keep'): void => {
        writeFileSync(path.join(bundleDir, 'blobs', 'goal-gen', 'package.json'), extra);
        const manifestPath = path.join(bundleDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          source: {
            overlay: null;
            commit: string;
            identity?: unknown;
            selected: { path: string; sha256: string; byteLength: number }[];
            captured: {
              path: string;
              mode: string;
              type: string;
              gitSha: string;
              sha256: string;
              byteLength: number;
            }[];
          };
        };
        expect(manifest.source.overlay).toBeNull();
        expect(manifest.source.commit).toBe(commit);
        const selected = manifest.source.selected.find((row) => row.path === 'goal-gen/package.json');
        const captured = manifest.source.captured.find((row) => row.path === 'goal-gen/package.json');
        expect(selected).toBeDefined();
        expect(captured).toBeDefined();
        expect(captured!.sha256).not.toBe(sha256Hex(extra));
        selected!.sha256 = sha256Hex(extra);
        selected!.byteLength = extra.length;
        captured!.sha256 = sha256Hex(extra);
        captured!.byteLength = extra.length;
        captured!.gitSha = gitBlobSha1(extra);
        if (identity === 'delete') delete manifest.source.identity;
        if (identity === 'null') manifest.source.identity = null;
        if (identity === 'relative') {
          manifest.source.identity = {
            repoPath: 'src',
            gitDir: 'src/.git',
            commonGitDir: 'src/.git',
            worktree: 'src',
          };
        }
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      };

      for (const [bundleDir, identity] of [
        [deleted, 'delete'],
        [nulled, 'null'],
        [relative, 'relative'],
      ] as const) {
        tamper(bundleDir, identity);
        stdoutSpy.mockClear();
        stderrSpy.mockClear();
        expect(await main(['acceptance', 'reproduce', bundleDir, '--json'])).toBe(1);
        expect(stdoutText()).toBe('');
        expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
        expect(JSON.parse(stderrText()).error.message).toMatch(/source\.identity/);
      }

      tamper(keepIdentity, 'keep');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', keepIdentity, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/source\.commit/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(deleted, { recursive: true, force: true });
      await rm(nulled, { recursive: true, force: true });
      await rm(relative, { recursive: true, force: true });
      await rm(keepIdentity, { recursive: true, force: true });
    }
  });

  it('rejects extra or malformed captured rows before snapshot', async () => {
    const files = { ...coherentFiles, 'goal-gen/README.md': 'never selected\n' };
    const { dir, commit } = await fixtureRepo(files);
    const extras = await mkdtemp(path.join(tmpdir(), 'cs-capextra-'));
    const control = await mkdtemp(path.join(tmpdir(), 'cs-capextra-control-'));
    const overlaySrc = await mkdtemp(path.join(tmpdir(), 'cs-capextra-overlay-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-capextra-out-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-capextra-work-'));
    try {
      for (const bundleDir of [extras, control, overlaySrc]) {
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
      }

      const readme = Buffer.from('never selected\n');
      const appendExtras = (bundleDir: string): void => {
        const manifestPath = path.join(bundleDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          source: {
            selected: { path: string }[];
            captured: unknown[];
          };
        };
        expect(manifest.source.selected.map((row) => row.path)).toEqual([
          'goal-gen/package.json',
          'goal-gen/package-lock.json',
          'goal-gen/bin/goal-gen.mjs',
        ]);
        manifest.source.captured.push(
          null,
          { not: 'a captured row' },
          {
            path: 123,
            mode: '100644',
            type: 'blob',
            gitSha: gitBlobSha1(readme),
            sha256: sha256Hex(readme),
            byteLength: readme.length,
          },
          {
            path: 'goal-gen/README.md',
            mode: '100644',
            type: 'blob',
            gitSha: gitBlobSha1(readme),
            sha256: sha256Hex(readme),
            byteLength: readme.length,
          },
        );
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      };

      appendExtras(extras);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', extras, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(/captured/);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', control, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      appendExtras(overlaySrc);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          overlaySrc,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(existsSync(path.join(overlayDest, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(extras, { recursive: true, force: true });
      await rm(control, { recursive: true, force: true });
      await rm(overlaySrc, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects selected blobs whose path contains a directory symlink', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const mid = await mkdtemp(path.join(tmpdir(), 'cs-symblob-mid-'));
    const overlay = await mkdtemp(path.join(tmpdir(), 'cs-symblob-overlay-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-symblob-overlay-out-'));
    const leaf = await mkdtemp(path.join(tmpdir(), 'cs-symblob-leaf-'));
    const host = await mkdtemp(path.join(tmpdir(), 'cs-symblob-host-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-symblob-work-'));
    try {
      for (const bundleDir of [mid, overlay, leaf]) {
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
      }

      const retargetGoalGen = (bundleDir: string, hostDir: string): void => {
        const inner = path.join(bundleDir, 'blobs', 'goal-gen');
        renameSync(inner, hostDir);
        symlinkSync(hostDir, inner);
      };

      retargetGoalGen(mid, path.join(host, 'mid-goal-gen'));
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', mid, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(JSON.parse(stderrText()).error.message).toMatch(/symlink/);

      retargetGoalGen(overlay, path.join(host, 'overlay-goal-gen'));
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          overlay,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(existsSync(path.join(overlayDest, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(false);

      const leafBlob = path.join(leaf, 'blobs', 'goal-gen', 'package.json');
      const leafHost = path.join(host, 'package.json');
      renameSync(leafBlob, leafHost);
      symlinkSync(leafHost, leafBlob);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', leaf, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(JSON.parse(stderrText()).error.message).toMatch(/regular file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(mid, { recursive: true, force: true });
      await rm(overlay, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(leaf, { recursive: true, force: true });
      await rm(host, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects reproduce when overlaid blob bytes are swapped for same-sized external file', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-open-swap-cap-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-open-swap-overlay-'));
    const noswap = await mkdtemp(path.join(tmpdir(), 'cs-open-swap-noswap-'));
    const swapped = await mkdtemp(path.join(tmpdir(), 'cs-open-swap-swap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-open-swap-work-'));
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      const overlayText = extraFieldManifest();
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': overlayText }), 'utf8');
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      const blobRel = path.join('blobs', 'goal-gen', 'package.json');
      const durable = readFileSync(path.join(overlayDest, blobRel));
      const external = Buffer.alloc(durable.length, 0x58);
      expect(external.length).toBe(durable.length);
      expect(sha256Hex(external)).not.toBe(sha256Hex(durable));
      const retargetSelected = (bundleDir: string): void => {
        copyCaptureTree(overlayDest, bundleDir);
        const manifestPath = path.join(bundleDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          source: {
            overlay: { files: Record<string, string> } | null;
            selected: Array<{ path: string; sha256: string; byteLength: number }>;
          };
        };
        expect(manifest.source.overlay?.files['goal-gen/package.json']).toBeDefined();
        const row = manifest.source.selected.find((item) => item.path === 'goal-gen/package.json');
        expect(row).toBeDefined();
        row!.sha256 = sha256Hex(external);
        row!.byteLength = external.length;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      };
      retargetSelected(noswap);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', noswap, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(JSON.parse(stderrText()).error.message).toMatch(/selected blob bytes do not match manifest/);

      retargetSelected(swapped);
      const blobFile = path.join(swapped, blobRel);
      const replace = (): void => {
        try {
          writeFileSync(blobFile, external);
        } catch {
          // blob may be mid-open
        }
      };
      const watcher = watch(path.dirname(blobFile), (_event, filename) => {
        if (filename === 'package.json') replace();
      });
      try {
        stdoutSpy.mockClear();
        stderrSpy.mockClear();
        expect(await main(['acceptance', 'reproduce', swapped, '--json'])).not.toBe(0);
        expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
        expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      } finally {
        watcher.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(noswap, { recursive: true, force: true });
      await rm(swapped, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects reproduce when manifest.json is swapped for a planted-digest symlink or FIFO', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-man-open-cap-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-man-open-overlay-'));
    const swapped = await mkdtemp(path.join(tmpdir(), 'cs-man-open-swap-'));
    const fifoDir = await mkdtemp(path.join(tmpdir(), 'cs-man-open-fifo-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-man-open-work-'));
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', overlayDest, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      const plantedDigest = '0'.repeat(64);
      copyCaptureTree(overlayDest, swapped);
      const manifestPath = path.join(swapped, 'manifest.json');
      const original = readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(original) as { profile: { digest: string } };
      expect(parsed.profile.digest).toHaveLength(64);
      expect(parsed.profile.digest).not.toBe(plantedDigest);
      const planted = original.replace(parsed.profile.digest, plantedDigest);
      expect(planted.length).toBe(original.length);
      const plantedPath = path.join(work, 'planted-manifest.json');
      writeFileSync(plantedPath, planted);
      unlinkSync(manifestPath);
      symlinkSync(plantedPath, manifestPath);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', swapped, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(stdoutText()).not.toContain(plantedDigest);
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(JSON.parse(stderrText()).error.message).toMatch(/manifest\.json is not a regular file/);

      copyCaptureTree(overlayDest, fifoDir);
      const fifoManifest = path.join(fifoDir, 'manifest.json');
      unlinkSync(fifoManifest);
      const fifo = spawnSync('mkfifo', ['-m', '0600', fifoManifest], { encoding: 'utf8' });
      expect(fifo.status).toBe(0);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const fifoResult = await Promise.race([
        main(['acceptance', 'reproduce', fifoDir, '--json']).then((code) => ({ code })),
        new Promise<{ timedOut: true }>((resolve) => {
          setTimeout(() => resolve({ timedOut: true }), 8000);
        }),
      ]);
      expect(fifoResult).toEqual({ code: 1 });
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(JSON.parse(stderrText()).error.message).toMatch(/manifest\.json is not a regular file/);

      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', overlayDest, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(swapped, { recursive: true, force: true });
      await rm(fifoDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects reproduce when a selected blob is swapped for a FIFO', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-blob-fifo-cap-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-blob-fifo-overlay-'));
    const fifoDir = await mkdtemp(path.join(tmpdir(), 'cs-blob-fifo-swap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-blob-fifo-work-'));
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', overlayDest, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      copyCaptureTree(overlayDest, fifoDir);
      const fifoBlob = path.join(fifoDir, 'blobs', 'goal-gen', 'package.json');
      unlinkSync(fifoBlob);
      const fifo = spawnSync('mkfifo', ['-m', '0600', fifoBlob], { encoding: 'utf8' });
      expect(fifo.status).toBe(0);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const fifoResult = await Promise.race([
        main(['acceptance', 'reproduce', fifoDir, '--json']).then((code) => ({ code })),
        new Promise<{ timedOut: true }>((resolve) => {
          setTimeout(() => resolve({ timedOut: true }), 8000);
        }),
      ]);
      expect(fifoResult).toEqual({ code: 1 });
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(JSON.parse(stderrText()).error.message).toMatch(/selected blob is not a regular file/);

      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', overlayDest, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(fifoDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects reproduce when COMPLETE is swapped for a planted-schema symlink, FIFO, or 8MiB file', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-complete-open-cap-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-complete-open-overlay-'));
    const swapped = await mkdtemp(path.join(tmpdir(), 'cs-complete-open-swap-'));
    const fifoDir = await mkdtemp(path.join(tmpdir(), 'cs-complete-open-fifo-'));
    const largeDir = await mkdtemp(path.join(tmpdir(), 'cs-complete-open-large-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-complete-open-work-'));
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', overlayDest, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);

      copyCaptureTree(overlayDest, swapped);
      const plantedSchema = 'yellow-goal/candidate-offline-milestone/v1\n';
      const plantedPath = path.join(work, 'planted-COMPLETE');
      writeFileSync(plantedPath, plantedSchema);
      const swappedComplete = path.join(swapped, 'COMPLETE');
      unlinkSync(swappedComplete);
      symlinkSync(plantedPath, swappedComplete);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', swapped, '--json'])).toBe(1);
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');

      copyCaptureTree(overlayDest, fifoDir);
      const fifoComplete = path.join(fifoDir, 'COMPLETE');
      unlinkSync(fifoComplete);
      const fifo = spawnSync('mkfifo', ['-m', '0600', fifoComplete], { encoding: 'utf8' });
      expect(fifo.status).toBe(0);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const fifoResult = await Promise.race([
        main(['acceptance', 'reproduce', fifoDir, '--json']).then((code) => ({ code })),
        new Promise<{ timedOut: true }>((resolve) => {
          setTimeout(() => resolve({ timedOut: true }), 8000);
        }),
      ]);
      expect(fifoResult).toEqual({ code: 1 });
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');

      copyCaptureTree(overlayDest, largeDir);
      const largeComplete = path.join(largeDir, 'COMPLETE');
      unlinkSync(largeComplete);
      writeFileSync(largeComplete, Buffer.alloc(8 * 1024 * 1024));
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const largeResult = await Promise.race([
        main(['acceptance', 'reproduce', largeDir, '--json']).then((code) => ({ code })),
        new Promise<{ timedOut: true }>((resolve) => {
          setTimeout(() => resolve({ timedOut: true }), 8000);
        }),
      ]);
      expect(largeResult).toEqual({ code: 1 });
      expect(lstatSync(largeComplete).size).toBe(8 * 1024 * 1024);
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');

      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', overlayDest, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(swapped, { recursive: true, force: true });
      await rm(fifoDir, { recursive: true, force: true });
      await rm(largeDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects gone-source reproduce when source.commit is not a full object ID', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-gone-commit-cap-'));
    const liveTamper = await mkdtemp(path.join(tmpdir(), 'cs-gone-commit-live-'));
    const goneHonest = await mkdtemp(path.join(tmpdir(), 'cs-gone-commit-honest-'));
    const goneTamper = await mkdtemp(path.join(tmpdir(), 'cs-gone-commit-tamper-'));
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
          captureDir,
        ]),
      ).toBe(0);

      const plantInvalidCommit = (bundleDir: string): void => {
        copyCaptureTree(captureDir, bundleDir);
        const manifestPath = path.join(bundleDir, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { source: { commit: string } };
        manifest.source.commit = 'not-a-commit';
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      };

      plantInvalidCommit(liveTamper);
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', liveTamper, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(
        /capture bundle source.commit is not a full commit object ID/,
      );

      copyCaptureTree(captureDir, goneHonest);
      copyCaptureTree(captureDir, goneTamper);
      const goneManifest = path.join(goneTamper, 'manifest.json');
      const goneParsed = JSON.parse(readFileSync(goneManifest, 'utf8')) as { source: { commit: string } };
      goneParsed.source.commit = 'not-a-commit';
      writeFileSync(goneManifest, `${JSON.stringify(goneParsed, null, 2)}\n`, 'utf8');

      await rm(dir, { recursive: true, force: true });
      expect(existsSync(dir)).toBe(false);

      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', goneHonest, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(JSON.parse(stdoutText()).source.commit).toBe(commit);

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', goneTamper, '--json'])).toBe(1);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(stdoutText()).not.toContain('not-a-commit');
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INVALID');
      expect(JSON.parse(stderrText()).error.message).toMatch(
        /capture bundle source.commit is not a full commit object ID/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(liveTamper, { recursive: true, force: true });
      await rm(goneHonest, { recursive: true, force: true });
      await rm(goneTamper, { recursive: true, force: true });
    }
  });

  it('rejects reproduce that mixes COMPLETE from one dest with extra-field overlay from a replacement', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-root-fd-cap-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-root-fd-overlay-'));
    const dest = await mkdtemp(path.join(tmpdir(), 'cs-root-fd-dest-'));
    const aside = `${dest}.aside`;
    const work = await mkdtemp(path.join(tmpdir(), 'cs-root-fd-work-'));
    let worker: Worker | undefined;
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          overlayDest,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      unlinkSync(path.join(overlayDest, 'COMPLETE'));

      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', captureDir, '--json'])).toBe(0);
      const honest = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean };
        source: { overlay: { files?: Record<string, string> } | null };
      };
      expect(honest.decision.accepted).toBe(true);
      expect(honest.source.overlay).toBeNull();
      expect(stdoutText()).not.toContain('captured-base extra-field alternative');

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', overlayDest, '--json'])).toBe(1);
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      expect(JSON.parse(stderrText()).error.message).toMatch(/bundle is missing COMPLETE/);

      copyCaptureTree(captureDir, dest);
      let flipped = false;
      worker = new Worker(
        `
        import { closeSync, constants, fstatSync, openSync, readdirSync, renameSync } from 'node:fs';
        import { parentPort, workerData } from 'node:worker_threads';
        const { dest, replacement, aside } = workerData;
        const flags = constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0);
        let heldFd;
        try {
          heldFd = openSync(dest, flags);
        } catch (err) {
          parentPort.postMessage(String(err));
          throw err;
        }
        const held = fstatSync(heldFd);
        parentPort.postMessage('ready');
        try {
          for (;;) {
            let extraDestFd = false;
            try {
              for (const fd of readdirSync('/proc/self/fd')) {
                if (fd === String(heldFd)) continue;
                const n = Number(fd);
                if (!Number.isInteger(n)) continue;
                let st;
                try { st = fstatSync(n); } catch { continue; }
                if (st.isDirectory() && st.dev === held.dev && st.ino === held.ino) {
                  extraDestFd = true;
                  break;
                }
              }
            } catch { /* proc may flicker */ }
            if (extraDestFd) {
              try {
                renameSync(dest, aside);
                renameSync(replacement, dest);
                parentPort.postMessage('flipped');
              } catch (err) {
                parentPort.postMessage(String(err));
              }
              break;
            }
          }
        } finally {
          try { closeSync(heldFd); } catch { /* already closed */ }
        }
        `,
        { eval: true, workerData: { dest, replacement: overlayDest, aside } },
      );
      let workerErr: unknown;
      let resolveReady!: () => void;
      const readyWait = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      worker.on('message', (msg: string) => {
        if (msg === 'ready') {
          resolveReady();
          return;
        }
        if (msg === 'flipped') {
          flipped = true;
          return;
        }
        workerErr = msg;
        resolveReady();
      });
      worker.once('error', (err) => {
        workerErr = err;
        resolveReady();
      });
      await readyWait;
      expect(workerErr).toBeUndefined();
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const code = await main(['acceptance', 'reproduce', dest, '--json']);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(workerErr).toBeUndefined();
      expect(flipped).toBe(true);
      expect(existsSync(path.join(dest, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(aside, 'COMPLETE'))).toBe(true);
      expect(readFileSync(path.join(dest, 'blobs', 'goal-gen', 'package.json'), 'utf8')).toContain(
        'captured-base extra-field alternative',
      );
      const mixed = JSON.parse(stdoutText() || '{}') as {
        decision?: { accepted?: boolean };
        source?: { overlay?: { files?: Record<string, string> } | null };
      };
      expect(mixed.decision?.accepted === true && mixed.source?.overlay != null).toBe(false);
      expect(stdoutText()).not.toContain('captured-base extra-field alternative');
      if (code === 0) {
        expect(mixed.decision?.accepted).toBe(true);
        expect(mixed.source?.overlay).toBeNull();
      } else {
        expect(code).toBe(1);
        expect(JSON.parse(stderrText()).error.code).toBe('BUNDLE_INCOMPLETE');
      }

      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', captureDir, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(JSON.parse(stdoutText()).source.overlay).toBeNull();
    } finally {
      worker?.terminate();
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
      await rm(aside, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects capture and overlay persist when dest is renamed aside after dest is opened', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-persist-rename-cap-'));
    const dest = await mkdtemp(path.join(tmpdir(), 'cs-persist-rename-dest-'));
    const aside = `${dest}.aside`;
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-persist-rename-ovl-'));
    const overlayAside = `${overlayDest}.aside`;
    const honestCapture = await mkdtemp(path.join(tmpdir(), 'cs-persist-rename-honest-cap-'));
    const honestOverlay = await mkdtemp(path.join(tmpdir(), 'cs-persist-rename-honest-ovl-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-persist-rename-work-'));
    let captureWorker: Worker | undefined;
    let overlayWorker: Worker | undefined;
    try {
      const captureSwap = startHeldDestEmptySwapWorker(dest, aside);
      captureWorker = captureSwap.worker;
      await captureSwap.readyWait;
      expect(captureSwap.err()).toBeUndefined();
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const captureCode = await main([
        'acceptance',
        'capture-source',
        'package-manifest-lockfile',
        dir,
        commit,
        '--json',
        '--bundle-dir',
        dest,
      ]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(captureSwap.err()).toBeUndefined();
      expect(captureSwap.flipped()).toBe(true);
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(captureCode).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(dest, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(aside, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(aside, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(aside, 'blobs'))).toBe(false);

      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          captureDir,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(captureDir, 'COMPLETE'))).toBe(true);

      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          honestCapture,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(honestCapture, 'COMPLETE'))).toBe(true);

      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      const overlaySwap = startHeldDestEmptySwapWorker(overlayDest, overlayAside);
      overlayWorker = overlaySwap.worker;
      await overlaySwap.readyWait;
      expect(overlaySwap.err()).toBeUndefined();
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const overlayCode = await main([
        'acceptance',
        'verify-candidate',
        'package-manifest-lockfile',
        extraPath,
        '--from-capture',
        captureDir,
        '--json',
        '--bundle-dir',
        overlayDest,
      ]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(overlaySwap.err()).toBeUndefined();
      expect(overlaySwap.flipped()).toBe(true);
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(overlayCode).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(overlayAside, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(overlayAside, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(overlayAside, 'blobs'))).toBe(false);

      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          honestOverlay,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(honestOverlay, 'COMPLETE'))).toBe(true);
    } finally {
      captureWorker?.terminate();
      overlayWorker?.terminate();
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
      await rm(aside, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(overlayAside, { recursive: true, force: true });
      await rm(honestCapture, { recursive: true, force: true });
      await rm(honestOverlay, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects capture and overlay persist when dest is moved into the source after dest is opened', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-dest-moved-cap-'));
    const dest = await mkdtemp(path.join(tmpdir(), 'cs-dest-moved-dest-'));
    const stolen = path.join(dir, 'stolen-dest');
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-dest-moved-ovl-'));
    const overlayStolen = path.join(dir, 'stolen-overlay-dest');
    const honestCapture = await mkdtemp(path.join(tmpdir(), 'cs-dest-moved-honest-cap-'));
    const honestOverlay = await mkdtemp(path.join(tmpdir(), 'cs-dest-moved-honest-ovl-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-dest-moved-work-'));
    let captureWorker: Worker | undefined;
    let overlayWorker: Worker | undefined;
    try {
      const captureSwap = startHeldDestMoveIntoSourceWorker(dest, stolen);
      captureWorker = captureSwap.worker;
      await captureSwap.readyWait;
      expect(captureSwap.err()).toBeUndefined();
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const captureCode = await main([
        'acceptance',
        'capture-source',
        'package-manifest-lockfile',
        dir,
        commit,
        '--json',
        '--bundle-dir',
        dest,
      ]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(captureSwap.err()).toBeUndefined();
      expect(captureSwap.flipped()).toBe(true);
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(captureCode).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(dest, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(stolen, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(stolen, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(stolen, 'blobs'))).toBe(false);

      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          captureDir,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(captureDir, 'COMPLETE'))).toBe(true);

      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          honestCapture,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(honestCapture, 'COMPLETE'))).toBe(true);

      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      const overlaySwap = startHeldDestMoveIntoSourceWorker(overlayDest, overlayStolen);
      overlayWorker = overlaySwap.worker;
      await overlaySwap.readyWait;
      expect(overlaySwap.err()).toBeUndefined();
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const overlayCode = await main([
        'acceptance',
        'verify-candidate',
        'package-manifest-lockfile',
        extraPath,
        '--from-capture',
        captureDir,
        '--json',
        '--bundle-dir',
        overlayDest,
      ]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(overlaySwap.err()).toBeUndefined();
      expect(overlaySwap.flipped()).toBe(true);
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(overlayCode).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(overlayStolen, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(overlayStolen, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(overlayStolen, 'blobs'))).toBe(false);

      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          honestOverlay,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(honestOverlay, 'COMPLETE'))).toBe(true);
    } finally {
      captureWorker?.terminate();
      overlayWorker?.terminate();
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
      await rm(stolen, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(overlayStolen, { recursive: true, force: true });
      await rm(honestCapture, { recursive: true, force: true });
      await rm(honestOverlay, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects capture and overlay persist when dest children are stolen before the dest inode check', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const dest = await mkdtemp(path.join(tmpdir(), 'cs-children-stolen-dest-'));
    const overlayDest = await mkdtemp(path.join(tmpdir(), 'cs-children-stolen-ovl-'));
    const honestCapture = await mkdtemp(path.join(tmpdir(), 'cs-children-stolen-honest-cap-'));
    const honestOverlay = await mkdtemp(path.join(tmpdir(), 'cs-children-stolen-honest-ovl-'));
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-children-stolen-cap-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-children-stolen-work-'));
    const stolenManifest = path.join(dir, 'stolen-manifest.json');
    const stolenBlobs = path.join(dir, 'stolen-blobs');
    const overlayStolenManifest = path.join(dir, 'stolen-overlay-manifest.json');
    const overlayStolenBlobs = path.join(dir, 'stolen-overlay-blobs');
    let captureWorker: Worker | undefined;
    let overlayWorker: Worker | undefined;
    try {
      const captureSteal = startHeldDestChildrenStealWorker(dest, stolenManifest, stolenBlobs);
      captureWorker = captureSteal.worker;
      await captureSteal.readyWait;
      expect(captureSteal.err()).toBeUndefined();
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const captureCode = await main([
        'acceptance',
        'capture-source',
        'package-manifest-lockfile',
        dir,
        commit,
        '--json',
        '--bundle-dir',
        dest,
      ]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(captureSteal.err()).toBeUndefined();
      expect(captureSteal.flipped()).toBe(true);
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(captureCode).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(dest, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(dest, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(dest, 'blobs'))).toBe(false);
      expect(existsSync(stolenManifest)).toBe(false);
      expect(existsSync(stolenBlobs)).toBe(false);

      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          captureDir,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(captureDir, 'COMPLETE'))).toBe(true);

      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'capture-source',
          'package-manifest-lockfile',
          dir,
          commit,
          '--json',
          '--bundle-dir',
          honestCapture,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(honestCapture, 'COMPLETE'))).toBe(true);
      expect(existsSync(path.join(honestCapture, 'manifest.json'))).toBe(true);
      expect(existsSync(path.join(honestCapture, 'blobs'))).toBe(true);

      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      const overlaySteal = startHeldDestChildrenStealWorker(
        overlayDest,
        overlayStolenManifest,
        overlayStolenBlobs,
      );
      overlayWorker = overlaySteal.worker;
      await overlaySteal.readyWait;
      expect(overlaySteal.err()).toBeUndefined();
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      const overlayCode = await main([
        'acceptance',
        'verify-candidate',
        'package-manifest-lockfile',
        extraPath,
        '--from-capture',
        captureDir,
        '--json',
        '--bundle-dir',
        overlayDest,
      ]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(overlaySteal.err()).toBeUndefined();
      expect(overlaySteal.flipped()).toBe(true);
      expect(JSON.parse(stdoutText() || '{}').decision?.accepted).not.toBe(true);
      expect(overlayCode).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(existsSync(path.join(overlayDest, 'COMPLETE'))).toBe(false);
      expect(existsSync(path.join(overlayDest, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(overlayDest, 'blobs'))).toBe(false);
      expect(existsSync(overlayStolenManifest)).toBe(false);
      expect(existsSync(overlayStolenBlobs)).toBe(false);

      stdoutSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          honestOverlay,
        ]),
      ).toBe(0);
      expect(JSON.parse(stdoutText()).decision.accepted).toBe(true);
      expect(existsSync(path.join(honestOverlay, 'COMPLETE'))).toBe(true);
      expect(existsSync(path.join(honestOverlay, 'manifest.json'))).toBe(true);
      expect(existsSync(path.join(honestOverlay, 'blobs'))).toBe(true);
    } finally {
      captureWorker?.terminate();
      overlayWorker?.terminate();
      await rm(dir, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
      await rm(overlayDest, { recursive: true, force: true });
      await rm(honestCapture, { recursive: true, force: true });
      await rm(honestOverlay, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(stolenManifest, { force: true });
      await rm(stolenBlobs, { recursive: true, force: true });
      await rm(overlayStolenManifest, { force: true });
      await rm(overlayStolenBlobs, { recursive: true, force: true });
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

  it('treats --from-capture on a 3c candidate-offline bundle as usage', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'cs-from-3c-work-'));
    const offlineDir = await mkdtemp(path.join(tmpdir(), 'cs-from-3c-bundle-'));
    try {
      const examples = configRepairCandidates();
      const sitePath = path.join(work, 'site.json');
      await writeFile(sitePath, `${JSON.stringify(examples.alpha)}\n`, 'utf8');
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'config-repair',
          sitePath,
          '--json',
          '--bundle-dir',
          offlineDir,
        ]),
      ).toBe(0);
      expect(readFileSync(path.join(offlineDir, 'COMPLETE'), 'utf8')).toBe(
        'yellow-goal/candidate-offline-milestone/v1\n',
      );
      const overlayPath = path.join(work, 'overlay.json');
      await writeFile(
        overlayPath,
        fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }),
        'utf8',
      );
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          overlayPath,
          '--from-capture',
          offlineDir,
          '--json',
        ]),
      ).toBe(2);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(JSON.parse(stderrText()).error.message).toMatch(/from-capture|capture bundle/i);
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(offlineDir, { recursive: true, force: true });
    }
  });

  it('treats an empty --from-capture value as usage', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'cs-empty-from-cap-'));
    try {
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');
      for (const fromCapture of ['--from-capture=', '--from-capture'] as const) {
        const argv = [
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          fromCapture,
          ...(fromCapture === '--from-capture' ? [''] : []),
          '--json',
        ];
        stdoutSpy.mockClear();
        stderrSpy.mockClear();
        expect(await main(argv)).toBe(2);
        expect(stdoutText()).toBe('');
        expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
        expect(JSON.parse(stderrText()).error.message).toMatch(/from-capture/i);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('persists profile-digest-mismatch overlays and refuses a non-empty --bundle-dir', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-digest-cap-'));
    const persistDir = await mkdtemp(path.join(tmpdir(), 'cs-digest-persist-'));
    const occupied = await mkdtemp(path.join(tmpdir(), 'cs-digest-occupied-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-digest-work-'));
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
          captureDir,
        ]),
      ).toBe(0);
      const captureManifestPath = path.join(captureDir, 'manifest.json');
      const captureManifest = JSON.parse(readFileSync(captureManifestPath, 'utf8')) as {
        profile: { digest: string; version: string };
        implementationRevision: string;
      };
      const installedDigest = captureManifest.profile.digest;
      const installedVersion = captureManifest.profile.version;
      const tamperedDigest = '0'.repeat(64);
      const storedRevision = `goal-gen@9.9.9#${'a'.repeat(64)}`;
      const storedVersion = 'historical-9.9.9';
      expect(installedDigest).not.toBe(tamperedDigest);
      expect(captureManifest.implementationRevision).not.toBe(storedRevision);
      expect(installedVersion).not.toBe(storedVersion);
      captureManifest.profile.digest = tamperedDigest;
      captureManifest.profile.version = storedVersion;
      captureManifest.implementationRevision = storedRevision;
      writeFileSync(captureManifestPath, `${JSON.stringify(captureManifest, null, 2)}\n`, 'utf8');
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');

      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          persistDir,
        ]),
      ).toBe(0);
      const overlayed = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
        profile: { digest: string; version: string };
        implementationRevision: string;
      };
      expect(overlayed.decision.accepted).toBe(false);
      expect(overlayed.decision.reasons).toEqual(['profile-digest-mismatch']);
      expect(overlayed.implementationRevision).toBe(storedRevision);
      expect(overlayed.profile.version).toBe(storedVersion);
      expect(overlayed.profile.version).not.toBe(installedVersion);
      expect(readFileSync(path.join(persistDir, 'COMPLETE'), 'utf8')).toBe(
        'yellow-goal/committed-source-capture/v1\n',
      );
      const persisted = JSON.parse(readFileSync(path.join(persistDir, 'manifest.json'), 'utf8')) as {
        decision: { accepted: boolean; reasons: string[] };
        profile: { digest: string; version: string };
        implementationRevision: string;
      };
      expect(persisted.decision.accepted).toBe(false);
      expect(persisted.decision.reasons).toEqual(['profile-digest-mismatch']);
      expect(persisted.profile.digest).toBe(tamperedDigest);
      expect(persisted.implementationRevision).toBe(storedRevision);
      expect(persisted.profile.version).toBe(storedVersion);
      expect(persisted.profile.version).not.toBe(installedVersion);

      const moved = `${persistDir}-moved`;
      renameSync(persistDir, moved);
      stdoutSpy.mockClear();
      expect(await main(['acceptance', 'reproduce', moved, '--json'])).toBe(0);
      const reproduced = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
        profile: { digest: string; version: string };
        implementationRevision: string;
      };
      expect(reproduced.decision.accepted).toBe(false);
      expect(reproduced.decision.reasons).toEqual(['profile-digest-mismatch']);
      expect(reproduced.profile.digest).toBe(tamperedDigest);
      expect(reproduced.profile.digest).not.toBe(installedDigest);
      expect(reproduced.implementationRevision).toBe(storedRevision);
      expect(reproduced.profile.version).toBe(storedVersion);
      expect(reproduced.profile.version).not.toBe(installedVersion);

      const sentinel = path.join(occupied, 'keep-me.txt');
      await writeFile(sentinel, 'occupied\n', 'utf8');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          occupied,
        ]),
      ).toBe(2);
      expect(stdoutText()).toBe('');
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(readFileSync(sentinel, 'utf8')).toBe('occupied\n');
      expect(existsSync(path.join(occupied, 'manifest.json'))).toBe(false);
      expect(existsSync(path.join(occupied, 'COMPLETE'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(persistDir, { recursive: true, force: true });
      await rm(`${persistDir}-moved`, { recursive: true, force: true });
      await rm(occupied, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('treats installed profile digest drift as profile-digest-mismatch before new blob policy', async () => {
    const { dir, commit } = await fixtureRepo(coherentFiles);
    const captureDir = await mkdtemp(path.join(tmpdir(), 'cs-digest-policy-cap-'));
    const persistAllow = await mkdtemp(path.join(tmpdir(), 'cs-digest-policy-allow-'));
    const persistBytes = await mkdtemp(path.join(tmpdir(), 'cs-digest-policy-bytes-'));
    const work = await mkdtemp(path.join(tmpdir(), 'cs-digest-policy-work-'));
    const installed = getCommittedSourceProfile('package-manifest-lockfile');
    const spy = vi.spyOn(committedSourceProfiles, 'getCommittedSourceProfile');
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
          captureDir,
        ]),
      ).toBe(0);
      const extraPath = path.join(work, 'extra.json');
      await writeFile(extraPath, fileContentCandidate({ 'goal-gen/package.json': extraFieldManifest() }), 'utf8');

      spy.mockImplementation((id) => ({
        ...installed,
        allowedPaths: ['goal-gen/package.json'],
        maxFiles: 1,
      }));
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          persistAllow,
        ]),
      ).toBe(0);
      const allowlisted = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
      };
      expect(allowlisted.decision.accepted).toBe(false);
      expect(allowlisted.decision.reasons).toEqual(['profile-digest-mismatch']);
      expect(existsSync(path.join(persistAllow, 'COMPLETE'))).toBe(true);

      spy.mockImplementation((id) => ({
        ...installed,
        maxFileBytes: 1,
      }));
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(
        await main([
          'acceptance',
          'verify-candidate',
          'package-manifest-lockfile',
          extraPath,
          '--from-capture',
          captureDir,
          '--json',
          '--bundle-dir',
          persistBytes,
        ]),
      ).toBe(0);
      const tightened = JSON.parse(stdoutText()) as {
        decision: { accepted: boolean; reasons: string[] };
      };
      expect(tightened.decision.accepted).toBe(false);
      expect(tightened.decision.reasons).toEqual(['profile-digest-mismatch']);
      expect(existsSync(path.join(persistBytes, 'COMPLETE'))).toBe(true);
    } finally {
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
      await rm(persistAllow, { recursive: true, force: true });
      await rm(persistBytes, { recursive: true, force: true });
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
