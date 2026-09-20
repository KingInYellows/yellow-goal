import { spawn, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MUTATED_CANDIDATE_REASON } from './acceptance-evidence';
import type { ObservedCheckSpec, ObservedFixtureProfile, ObservedFixtureVariant } from './observed-fixture-profiles';

export type ObservedCheckOutcome = {
  id: string;
  command: string;
  cwd: string;
  status: 'passed' | 'failed' | 'blocked' | 'not-run';
  exitStatus?: number;
  signal?: string;
  reason?: string;
  preCheckTree?: string;
  postCheckTree?: string;
};

export type ObservationFault = {
  code: string;
  message: string;
};

export type ObservationResult = {
  repo: string;
  cleanupDir: string;
  baseRevision: string;
  candidateTree: string;
  diff: string;
  overlay: Record<string, string>;
  checks: ObservedCheckOutcome[];
  faults: ObservationFault[];
};

function gitEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'observed-fixture',
    GIT_AUTHOR_EMAIL: 'observed-fixture@invalid',
    GIT_COMMITTER_NAME: 'observed-fixture',
    GIT_COMMITTER_EMAIL: 'observed-fixture@invalid',
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  return env;
}

function git(repo: string, args: string[], env: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv): string {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: extra ? { ...env, ...extra } : env,
    timeout: 15_000,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || 'git failed').trim();
    throw new Error(`git ${args.join(' ')}: ${detail}`);
  }
  return (result.stdout ?? '').trim();
}

function writeFiles(repo: string, files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
}

function writeSymlinks(repo: string, links: Record<string, string> | undefined): void {
  if (links === undefined) return;
  for (const [relative, target] of Object.entries(links)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    symlinkSync(target, full);
  }
}

function overlayFiles(base: Record<string, string>, overlay: Record<string, string>): Record<string, string> {
  return { ...base, ...overlay };
}

function walk(root: string, dir: string, visit: (full: string, name: string, stat: ReturnType<typeof lstatSync>) => void): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = lstatSync(full);
    visit(full, name, stat);
    if (stat !== undefined && stat.isDirectory() && name !== '.git') walk(root, full, visit);
  }
}

function findEmptyDirs(repo: string): string[] {
  const found: string[] = [];
  walk(repo, repo, (full, name, stat) => {
    if (stat === undefined || !stat.isDirectory() || name === '.git' || full === repo) return;
    if (readdirSync(full).length === 0) found.push(path.relative(repo, full));
  });
  return found;
}

function findNestedGit(repo: string): string[] {
  const rootGit = path.join(repo, '.git');
  const found: string[] = [];
  walk(repo, repo, (full, name) => {
    if (name === '.git' && full !== rootGit) found.push(path.relative(repo, full));
  });
  return found;
}

function findEscapingSymlinks(repo: string): string[] {
  const found: string[] = [];
  const root = path.resolve(repo);
  walk(repo, repo, (full, _name, stat) => {
    if (stat === undefined || !stat.isSymbolicLink()) return;
    const resolved = path.resolve(path.dirname(full), readlinkSync(full));
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      found.push(path.relative(repo, full));
    }
  });
  return found;
}

function listGitlinks(repo: string, env: NodeJS.ProcessEnv): string[] {
  const raw = spawnSync('git', ['-C', repo, 'ls-files', '-s'], { encoding: 'utf8', env, timeout: 15_000 });
  if (raw.status !== 0) return [];
  return (raw.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('160000 '))
    .map((line) => line.split(/\s+/).slice(3).join(' '))
    .filter((value) => value.length > 0);
}

function submoduleExtraPaths(repo: string, env: NodeJS.ProcessEnv): string[] {
  const dirty: string[] = [];
  for (const gitlink of listGitlinks(repo, env)) {
    const inner = path.join(repo, gitlink);
    const status = spawnSync('git', ['-C', inner, 'status', '--porcelain', '--ignored'], {
      encoding: 'utf8',
      env,
      timeout: 15_000,
    });
    if (status.status !== 0 || (status.stdout ?? '').trim() !== '') dirty.push(gitlink);
  }
  return dirty;
}

function realIndexDirty(repo: string, env: NodeJS.ProcessEnv): boolean {
  const cached = spawnSync('git', ['-C', repo, 'diff', '--cached', '--quiet'], { encoding: 'utf8', env, timeout: 15_000 });
  return cached.status !== 0;
}

function collectPreconditionFaults(repo: string, env: NodeJS.ProcessEnv): ObservationFault[] {
  const faults: ObservationFault[] = [];
  if (realIndexDirty(repo, env)) {
    faults.push({ code: 'REAL_INDEX_DIRTY', message: 'real index is not clean before observation' });
  }
  const empty = findEmptyDirs(repo);
  if (empty.length > 0) {
    faults.push({ code: 'EMPTY_DIRECTORY', message: `empty directories before measurement: ${empty.join(', ')}` });
  }
  const nested = findNestedGit(repo);
  if (nested.length > 0) {
    faults.push({ code: 'EMBEDDED_REPOSITORY', message: `nested .git before measurement: ${nested.join(', ')}` });
  }
  const escaping = findEscapingSymlinks(repo);
  if (escaping.length > 0) {
    faults.push({ code: 'ESCAPING_SYMLINK', message: `escaping symlink: ${escaping.join(', ')}` });
  }
  const dirtySubs = submoduleExtraPaths(repo, env);
  if (dirtySubs.length > 0) {
    faults.push({ code: 'SUBMODULE_DIRTY', message: `dirty or extra-path submodule: ${dirtySubs.join(', ')}` });
  }
  return faults;
}

function leftoverMutationReason(repo: string, env: NodeJS.ProcessEnv): string | undefined {
  const empty = findEmptyDirs(repo);
  if (empty.length > 0) return MUTATED_CANDIDATE_REASON;
  const nested = findNestedGit(repo);
  if (nested.length > 0) return MUTATED_CANDIDATE_REASON;
  const escaping = findEscapingSymlinks(repo);
  if (escaping.length > 0) return MUTATED_CANDIDATE_REASON;
  const dirtySubs = submoduleExtraPaths(repo, env);
  if (dirtySubs.length > 0) return MUTATED_CANDIDATE_REASON;
  return undefined;
}

function measureTree(repo: string, env: NodeJS.ProcessEnv): string {
  const scratch = mkdtempSync(path.join(tmpdir(), 'observed-objects-'));
  try {
    const objects = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], env);
    const measureEnv = {
      GIT_OBJECT_DIRECTORY: scratch,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
      GIT_INDEX_FILE: path.join(scratch, 'index'),
    };
    git(repo, ['add', '-A', '--force'], env, measureEnv);
    return git(repo, ['write-tree'], env, measureEnv);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runArgv(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ exitStatus?: number; signal?: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    if (argv.length === 0) {
      reject(new Error('empty argv'));
      return;
    }
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 100);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Wait for the child to actually exit so post-check measurement sees the
      // leftover tree. A later normal exit (hang traps SIGTERM then exits 0)
      // must not rewrite a timeout into passed/failed.
      if (timedOut) {
        resolve({ timedOut: true, signal: signal ?? 'SIGTERM' });
        return;
      }
      if (signal) resolve({ timedOut: false, signal });
      else resolve({ timedOut: false, exitStatus: code ?? 1 });
    });
  });
}

export async function observeFixture(
  profile: ObservedFixtureProfile,
  variant: ObservedFixtureVariant,
): Promise<ObservationResult> {
  const cleanupDir = await mkdtemp(path.join(tmpdir(), 'observed-fixture-'));
  const repo = path.join(cleanupDir, 'repo');
  const home = path.join(cleanupDir, 'home');
  const empty = (): ObservationResult => ({
    repo,
    cleanupDir,
    baseRevision: '',
    candidateTree: '',
    diff: '',
    overlay: overlayFiles(profile.baseFiles, variant.files),
    checks: [],
    faults: [],
  });
  try {
    mkdirSync(repo);
    mkdirSync(home);
    const env = gitEnv(home);
    env.TMPDIR = home;
    git(repo, ['init', '-q', '--initial-branch=main'], env);
    writeFiles(repo, profile.baseFiles);
    git(repo, ['add', '-A'], env);
    git(repo, ['commit', '-qm', 'observed-fixture-base'], env);
    const baseRevision = git(repo, ['rev-parse', 'HEAD'], env);
    writeFiles(repo, variant.files);
    writeSymlinks(repo, variant.symlinks);
    const overlay = overlayFiles(profile.baseFiles, variant.files);

    const preFaults = collectPreconditionFaults(repo, env);
    if (preFaults.length > 0) {
      return { repo, cleanupDir, baseRevision, candidateTree: '', diff: '', overlay, checks: [], faults: preFaults };
    }

    let candidateTree: string;
    try {
      candidateTree = measureTree(repo, env);
    } catch (err) {
      return {
        repo,
        cleanupDir,
        baseRevision,
        candidateTree: '',
        diff: '',
        overlay,
        checks: [],
        faults: [{ code: 'MEASUREMENT_ABORT', message: err instanceof Error ? err.message : String(err) }],
      };
    }

    const diff = spawnSync('git', ['-C', repo, 'diff', '--no-ext-diff', 'HEAD'], { encoding: 'utf8', env, timeout: 15_000 })
      .stdout ?? '';

    const checks: ObservedCheckOutcome[] = [];
    for (const spec of profile.checks) {
      const outcome = await runOneCheck(repo, env, spec, candidateTree, profile.timeoutMs);
      checks.push(outcome);
      if (outcome.status === 'blocked' && outcome.reason === MUTATED_CANDIDATE_REASON) {
        break;
      }
    }
    return { repo, cleanupDir, baseRevision, candidateTree, diff, overlay, checks, faults: [] };
  } catch (err) {
    return {
      ...empty(),
      faults: [{ code: 'OBSERVATION_FAULT', message: err instanceof Error ? err.message : String(err) }],
    };
  }
}

async function runOneCheck(
  repo: string,
  env: NodeJS.ProcessEnv,
  spec: ObservedCheckSpec,
  candidateTree: string,
  timeoutMs: number,
): Promise<ObservedCheckOutcome> {
  const cwd = path.join(repo, spec.cwd);
  let preCheckTree: string;
  try {
    preCheckTree = measureTree(repo, env);
  } catch (err) {
    return {
      id: spec.id,
      command: spec.command,
      cwd: spec.cwd,
      status: 'blocked',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const launched: ObservedCheckOutcome = {
    id: spec.id,
    command: spec.command,
    cwd: spec.cwd,
    status: 'blocked',
    preCheckTree,
  };
  if (preCheckTree !== candidateTree) {
    return { ...launched, reason: 'preCheckTree does not equal candidateTree' };
  }

  let run: { exitStatus?: number; signal?: string; timedOut: boolean };
  try {
    run = await runArgv(spec.argv, cwd, timeoutMs, env);
  } catch (err) {
    return { ...launched, reason: err instanceof Error ? err.message : String(err) };
  }

  let postCheckTree: string | undefined;
  try {
    postCheckTree = measureTree(repo, env);
  } catch {
    postCheckTree = undefined;
  }

  const leftover = leftoverMutationReason(repo, env);
  const mutatedTrees = postCheckTree !== undefined && postCheckTree !== preCheckTree;
  if (leftover || mutatedTrees) {
    const blocked: ObservedCheckOutcome = {
      ...launched,
      status: 'blocked',
      postCheckTree,
      reason: MUTATED_CANDIDATE_REASON,
    };
    if (run.timedOut || run.signal) blocked.signal = run.signal ?? 'SIGTERM';
    else if (typeof run.exitStatus === 'number') blocked.exitStatus = run.exitStatus;
    if (blocked.signal !== undefined && blocked.exitStatus !== undefined) {
      delete blocked.exitStatus;
    }
    return blocked;
  }

  if (run.timedOut || run.signal) {
    return { ...launched, status: 'blocked', postCheckTree, signal: run.signal ?? 'SIGTERM', reason: 'killed by timeout' };
  }
  if (run.exitStatus === 0) {
    return { ...launched, status: 'passed', postCheckTree, exitStatus: 0 };
  }
  return { ...launched, status: 'failed', postCheckTree, exitStatus: run.exitStatus ?? 1 };
}

export async function removeObservationRepo(repo: string): Promise<void> {
  await rm(repo, { recursive: true, force: true });
}

export { collectPreconditionFaults, gitEnv, leftoverMutationReason, measureTree };
