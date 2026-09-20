import { spawnSync } from 'node:child_process';
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
import { OBSERVER_OUTPUT_LIMIT, observerToolPath, runBoundedArgv } from './observed-fixture-child';
import type { ObservedCheckSpec, ObservedFixtureVariant } from './observed-fixture-profiles';

export const REPRODUCIBLE_GIT_DATE = '1970-01-01T00:00:00+0000';
export const REPRODUCIBLE_COMMIT_MESSAGE = 'observed-fixture-base';

export type ObservableProfile = {
  timeoutMs: number;
  checks: ObservedCheckSpec[];
  baseFiles: Record<string, string>;
};

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
  deadlineExceeded?: boolean;
  outputTruncated?: boolean;
  rawExitStatus?: number;
  rawSignal?: string;
  stdout?: string;
  stderr?: string;
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
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, '.gitconfig'),
    [
      '[user]',
      '\tname = observed-fixture',
      '\temail = observed-fixture@invalid',
      '[commit]',
      '\tgpgsign = false',
      '[init]',
      '\tdefaultBranch = main',
      '',
    ].join('\n'),
    'utf8',
  );
  return {
    HOME: home,
    TMPDIR: home,
    PATH: observerToolPath(),
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 'observed-fixture',
    GIT_AUTHOR_EMAIL: 'observed-fixture@invalid',
    GIT_COMMITTER_NAME: 'observed-fixture',
    GIT_COMMITTER_EMAIL: 'observed-fixture@invalid',
    GIT_AUTHOR_DATE: REPRODUCIBLE_GIT_DATE,
    GIT_COMMITTER_DATE: REPRODUCIBLE_GIT_DATE,
    GOAL_GEN_DISPOSABLE_OBSERVER: '1',
  };
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

function notRunRow(spec: ObservedCheckSpec, reason: string): ObservedCheckOutcome {
  return {
    id: spec.id,
    command: spec.command,
    cwd: spec.cwd,
    status: 'not-run',
    reason,
  };
}

export async function observeFixture(
  profile: ObservableProfile,
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
    git(repo, ['init', '-q', '--initial-branch=main'], env);
    writeFiles(repo, profile.baseFiles);
    git(repo, ['add', '-A'], env);
    git(repo, ['commit', '-qm', REPRODUCIBLE_COMMIT_MESSAGE], env);
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
    let stopped = false;
    let stopReason = '';
    for (const spec of profile.checks) {
      if (stopped) {
        checks.push(notRunRow(spec, `never-launched: ${stopReason}`));
        continue;
      }
      const outcome = await runOneCheck(repo, cleanupDir, env, spec, candidateTree, profile.timeoutMs);
      checks.push(outcome);
      if (outcome.status === 'blocked' && outcome.reason === MUTATED_CANDIDATE_REASON) {
        stopped = true;
        stopReason = 'stopped after leftover mutation';
      } else if (outcome.status === 'not-run') {
        stopped = true;
        stopReason = 'stopped after a check could not be launched';
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
  cleanupDir: string,
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
    return notRunRow(spec, `never-launched: pre-measurement failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (preCheckTree !== candidateTree) {
    return {
      id: spec.id,
      command: spec.command,
      cwd: spec.cwd,
      status: 'blocked',
      preCheckTree,
      reason: 'preCheckTree does not equal candidateTree',
    };
  }

  const readyPath = spec.awaitReady === true ? path.join(cleanupDir, `ready-${spec.id}`) : undefined;
  const run = await runBoundedArgv({
    argv: spec.argv,
    cwd,
    env,
    timeoutMs,
    outputLimit: OBSERVER_OUTPUT_LIMIT,
    readyPath,
    startupReadyMs: spec.awaitReadyMs,
  });
  if (run.spawnError !== undefined) {
    return notRunRow(spec, `never-launched: spawn failed: ${run.spawnError}`);
  }

  let postCheckTree: string | undefined;
  try {
    postCheckTree = measureTree(repo, env);
  } catch {
    postCheckTree = undefined;
  }

  const leftover = leftoverMutationReason(repo, env);
  const mutatedTrees = postCheckTree !== undefined && postCheckTree !== preCheckTree;
  const truncated = run.stdoutTruncated || run.stderrTruncated;
  const launched: ObservedCheckOutcome = {
    id: spec.id,
    command: spec.command,
    cwd: spec.cwd,
    status: 'blocked',
    preCheckTree,
    postCheckTree,
    deadlineExceeded: run.timedOut && !run.readyFailed ? true : undefined,
    outputTruncated: truncated || undefined,
    rawExitStatus: run.exitStatus,
    rawSignal: run.signal,
    stdout: run.stdout === '' ? undefined : run.stdout,
    stderr: run.stderr === '' ? undefined : run.stderr,
  };

  if (leftover || mutatedTrees) {
    const blocked: ObservedCheckOutcome = { ...launched, reason: MUTATED_CANDIDATE_REASON };
    if (run.signal !== undefined) blocked.signal = run.signal;
    else if (typeof run.exitStatus === 'number') blocked.exitStatus = run.exitStatus;
    return blocked;
  }

  if (run.readyFailed) {
    const blocked: ObservedCheckOutcome = { ...launched, reason: 'readiness-failed' };
    if (run.signal !== undefined) blocked.signal = run.signal;
    return blocked;
  }
  if (run.timedOut) {
    const blocked: ObservedCheckOutcome = { ...launched, reason: 'deadline-exceeded' };
    if (run.signal !== undefined) blocked.signal = run.signal;
    return blocked;
  }
  if (run.signal !== undefined) {
    return { ...launched, signal: run.signal, reason: `killed by ${run.signal}` };
  }
  if (truncated) {
    return { ...launched, reason: 'output-truncated' };
  }
  if (postCheckTree === undefined) {
    return { ...launched, reason: 'missing post-check measurement' };
  }
  if (run.exitStatus === 0) {
    return {
      id: spec.id,
      command: spec.command,
      cwd: spec.cwd,
      status: 'passed',
      preCheckTree,
      postCheckTree,
      exitStatus: 0,
      stdout: run.stdout === '' ? undefined : run.stdout,
      stderr: run.stderr === '' ? undefined : run.stderr,
    };
  }
  return {
    id: spec.id,
    command: spec.command,
    cwd: spec.cwd,
    status: 'failed',
    preCheckTree,
    postCheckTree,
    exitStatus: run.exitStatus ?? 1,
    stdout: run.stdout === '' ? undefined : run.stdout,
    stderr: run.stderr === '' ? undefined : run.stderr,
  };
}

export async function removeObservationRepo(repo: string): Promise<void> {
  await rm(repo, { recursive: true, force: true });
}

export { collectPreconditionFaults, gitEnv, leftoverMutationReason, measureTree };
