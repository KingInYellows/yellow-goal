/**
 * Requirement-to-test matrix for `acceptance verify-fixture` (VS spec OF-01–OF-10).
 * Observations are real. Recorder is the packed/installed subprocess, not imported JSON.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MUTATED_CANDIDATE_REASON } from '../../backend/src/cli/acceptance-evidence';
import { main } from '../../backend/src/cli/index';
import { runObservedFixtureVerify } from '../../backend/src/cli/observed-fixture-command';
import {
  collectPreconditionFaults,
  gitEnv,
  leftoverMutationReason,
  measureTree,
  observeFixture,
  removeObservationRepo,
} from '../../backend/src/cli/observed-fixture-observer';
import {
  getObservedFixtureProfile,
  getObservedFixtureVariant,
} from '../../backend/src/cli/observed-fixture-profiles';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const commandSource = readFileSync(
  path.join(packageRoot, 'backend/src/cli/observed-fixture-command.ts'),
  'utf8',
);
const observerSource = readFileSync(
  path.join(packageRoot, 'backend/src/cli/observed-fixture-observer.ts'),
  'utf8',
);

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

function git(repo: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env, timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'git failed').trim());
  }
  return (result.stdout ?? '').trim();
}

describe('observed fixture verification', () => {
  it('OF-01: engine-owned profile; variants cannot redefine required checks', () => {
    const profile = getObservedFixtureProfile('status-probe');
    expect(profile.requiredCheckIds).toEqual(['status']);
    expect(profile.checks.map((check) => check.id)).toEqual(profile.requiredCheckIds);
    const baseline = getObservedFixtureVariant(profile, 'baseline');
    const correct = getObservedFixtureVariant(profile, 'correct');
    expect(Object.keys(baseline.files)).toEqual([]);
    expect(correct.files).toEqual({ STATUS: 'ok\n' });
    expect(profile.checks).toHaveLength(1);
  });

  it('OF-02: argument-vector spawn; command string is identity, not a shell', () => {
    const profile = getObservedFixtureProfile('status-probe');
    const check = profile.checks[0]!;
    expect(check.argv[0]).toBe(process.execPath);
    expect(check.argv[1]).toMatch(/status-probe\.mjs$/);
    expect(check.argv).not.toContain(check.command);
    expect(observerSource).toMatch(/spawn\(argv\[0]!, argv\.slice\(1\)/);
    expect(observerSource).not.toMatch(/shell:\s*true/);
    expect(observerSource).toMatch(/observed-fixture-/);
  });

  it('OF-03: trees use a temporary index, isolated object store, and --force', () => {
    expect(observerSource).toMatch(/GIT_INDEX_FILE/);
    expect(observerSource).toMatch(/GIT_OBJECT_DIRECTORY/);
    expect(observerSource).toMatch(/GIT_ALTERNATE_OBJECT_DIRECTORIES/);
    expect(observerSource).toMatch(/add', '-A', '--force'/);
  });

  it('OF-03 functional: --force includes gitignored paths; real index stays clean', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'of03-'));
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    mkdirSync(repo);
    mkdirSync(home);
    const env = gitEnv(home);
    try {
      git(repo, ['init', '-q', '--initial-branch=main'], env);
      writeFileSync(path.join(repo, 'tracked.txt'), 'keep\n');
      writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
      git(repo, ['add', '-A'], env);
      git(repo, ['commit', '-qm', 'base'], env);
      writeFileSync(path.join(repo, 'ignored.txt'), 'secret\n');
      const headTree = git(repo, ['rev-parse', 'HEAD^{tree}'], env);
      const measured = measureTree(repo, env);
      expect(measured).not.toBe(headTree);
      const cached = spawnSync('git', ['-C', repo, 'diff', '--cached', '--quiet'], {
        encoding: 'utf8',
        env,
        timeout: 15_000,
      });
      expect(cached.status).toBe(0);
    } finally {
      spawnSync('rm', ['-rf', root]);
    }
  });

  it('OF-07/OF-08: failing baseline records failed evidence and is not acceptance', async () => {
    const result = await runObservedFixtureVerify(['status-probe', 'baseline', '--json']);
    const bundle = result.output;
    expect(bundle.identities.candidateIdentity.kind).toBe('tree');
    expect(bundle.identities.candidateTree).not.toBe(bundle.identities.baseRevision);
    expect(bundle.outcomes[0]).toMatchObject({ id: 'status', status: 'failed', exitStatus: 1 });
    expect(bundle.recorder?.exit).toBe(0);
    expect(bundle.recorder?.record?.status).toBe('failed');
    expect(bundle.decision.accepted).toBe(false);
  });

  it('OF-07: correct candidate is observed passed and fixture-accepted', async () => {
    const result = await runObservedFixtureVerify(['status-probe', 'correct', '--json']);
    expect(result.output.outcomes[0]).toMatchObject({ status: 'passed', exitStatus: 0 });
    expect(result.output.recorder?.exit).toBe(0);
    expect(result.output.recorder?.record?.status).toBe('passed');
    expect(result.output.decision.accepted).toBe(true);
  });

  it('OF-07: incorrect candidate is a real failed observation, not accepted', async () => {
    const result = await runObservedFixtureVerify(['status-probe', 'incorrect', '--json']);
    expect(result.output.outcomes[0]?.status).toBe('failed');
    expect(result.output.recorder?.record?.status).toBe('failed');
    expect(result.output.decision.accepted).toBe(false);
  });

  it('OF-04 leftover file is blocked with reserved mutation reason', async () => {
    const result = await runObservedFixtureVerify(['leftover-file', 'case', '--json']);
    expect(result.output.outcomes[0]).toMatchObject({
      status: 'blocked',
      reason: MUTATED_CANDIDATE_REASON,
    });
    expect(result.output.recorder?.record?.status).toBe('blocked');
    expect(result.output.decision.accepted).toBe(false);
  });

  it('OF-04 leftover empty directory is blocked with reserved mutation reason', async () => {
    const result = await runObservedFixtureVerify(['leftover-empty-dir', 'case', '--json']);
    expect(result.output.outcomes[0]).toMatchObject({
      status: 'blocked',
      reason: MUTATED_CANDIDATE_REASON,
    });
    expect(result.output.decision.accepted).toBe(false);
  });

  it('OF-04 leftover nested .git is blocked with reserved mutation reason', async () => {
    const result = await runObservedFixtureVerify(['leftover-nested-git', 'case', '--json']);
    expect(result.output.outcomes[0]).toMatchObject({
      status: 'blocked',
      reason: MUTATED_CANDIDATE_REASON,
    });
    expect(result.output.decision.accepted).toBe(false);
  });

  it('OF-04 leftover escaping symlink is blocked with reserved mutation reason', async () => {
    const result = await runObservedFixtureVerify(['leftover-escaping-symlink', 'case', '--json']);
    expect(result.output.outcomes[0]).toMatchObject({
      status: 'blocked',
      reason: MUTATED_CANDIDATE_REASON,
    });
    expect(result.output.decision.accepted).toBe(false);
  });

  it('OF-04 dirty submodule extra paths are leftover mutation', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'of04-sub-'));
    const superRepo = path.join(root, 'super');
    const inner = path.join(root, 'inner');
    const home = path.join(root, 'home');
    mkdirSync(superRepo);
    mkdirSync(inner);
    mkdirSync(home);
    const env = gitEnv(home);
    env.GIT_ALLOW_PROTOCOL = 'file';
    try {
      git(inner, ['init', '-q', '--initial-branch=main'], env);
      writeFileSync(path.join(inner, 'inner.txt'), 'in\n');
      git(inner, ['add', '-A'], env);
      git(inner, ['commit', '-qm', 'inner'], env);
      git(superRepo, ['init', '-q', '--initial-branch=main'], env);
      writeFileSync(path.join(superRepo, 'keep.txt'), 'keep\n');
      git(superRepo, ['add', '-A'], env);
      git(superRepo, ['commit', '-qm', 'super'], env);
      git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', inner, 'sub'], env);
      git(superRepo, ['commit', '-qm', 'add-sub'], env);
      writeFileSync(path.join(superRepo, 'sub', 'extra.txt'), 'extra\n');
      expect(leftoverMutationReason(superRepo, env)).toBe(MUTATED_CANDIDATE_REASON);
    } finally {
      spawnSync('rm', ['-rf', root]);
    }
  });

  it('OF-05: timeout stays blocked after the child later exits 0', async () => {
    const result = await runObservedFixtureVerify(['timeout-probe', 'case', '--json']);
    const row = result.output.outcomes[0];
    expect(row?.status).toBe('blocked');
    expect(row?.signal).toBeDefined();
    expect(row?.exitStatus).toBeUndefined();
    expect(result.output.recorder?.record?.status).toBe('blocked');
    expect(result.output.decision.accepted).toBe(false);
  });

  it('OF-06: workflow does not import the recorder; it spawns the packed bin', () => {
    expect(commandSource).toMatch(/bin\/goal-gen\.mjs/);
    expect(commandSource).toMatch(/acceptance', 'record'/);
    expect(commandSource).not.toMatch(/acceptance-record-command/);
    expect(commandSource).not.toMatch(/recordAcceptanceEvidence/);
  });

  it('OF-09: hand-authored all-passed JSON records but cannot authorize verify-fixture', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'of09-'));
    try {
      const tree = 'b'.repeat(40);
      const fixturePath = path.join(dir, 'passed.json');
      await writeFile(
        fixturePath,
        JSON.stringify({
          schemaVersion: 'yellow-goal/acceptance-evidence/v1',
          baseRevision: 'a'.repeat(40),
          candidateIdentity: { kind: 'tree', value: tree },
          candidateTree: tree,
          requiredChecks: [{ id: 'typecheck', command: '__ACCEPTANCE_RECORDER_MUST_NOT_EXECUTE__', cwd: 'goal-gen' }],
          checks: [
            {
              id: 'typecheck',
              status: 'passed',
              command: '__ACCEPTANCE_RECORDER_MUST_NOT_EXECUTE__',
              cwd: 'goal-gen',
              candidateIdentity: { kind: 'tree', value: tree },
              preCheckTree: tree,
              postCheckTree: tree,
              exitStatus: 0,
            },
          ],
        }),
      );
      expect(await main(['acceptance', 'record', fixturePath, '--json'])).toBe(0);
      expect(JSON.parse(stdoutText()).status).toBe('passed');
      stdoutSpy.mockClear();
      stderrSpy.mockClear();
      expect(await main(['acceptance', 'verify-fixture', 'passed.json', 'correct'])).toBe(2);
      expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
      expect(stdoutText()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('OF-10: observation fault skips the recorder and invents no recorder fields', async () => {
    const result = await runObservedFixtureVerify(['precondition-escape', 'case', '--json']);
    expect(result.output.outcomes).toEqual([]);
    expect(result.output.recorder).toBeNull();
    expect(result.output.decision.accepted).toBe(false);
    expect(result.output.decision.reasons.some((reason) => reason.startsWith('observation-fault:'))).toBe(true);
  });

  it('OF-10 collectPreconditionFaults reports empty directories before measurement', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'of10-empty-'));
    const env = gitEnv(repo);
    try {
      git(repo, ['init', '-q', '--initial-branch=main'], env);
      spawnSync('mkdir', ['-p', path.join(repo, 'empty-dir')]);
      const faults = collectPreconditionFaults(repo, env);
      expect(faults.some((fault) => fault.code === 'EMPTY_DIRECTORY')).toBe(true);
    } finally {
      spawnSync('rm', ['-rf', repo]);
    }
  });

  it('usage: unknown profile or imported JSON path exits 2 with no bundle', async () => {
    expect(await main(['acceptance', 'verify-fixture'])).toBe(2);
    expect(JSON.parse(stderrText()).error.code).toBe('USAGE_ERROR');
    expect(stdoutText()).toBe('');
    stdoutSpy.mockClear();
    stderrSpy.mockClear();
    expect(await main(['acceptance', 'verify-fixture', 'no-such-profile', 'baseline'])).toBe(2);
    expect(stdoutText()).toBe('');
  });
});

describe('observed fixture observer cleanup', () => {
  it('try starts immediately after mkdtemp so mkdir/home setup failures stay inside it', () => {
    const afterMkdtemp = observerSource.slice(observerSource.indexOf('await mkdtemp'));
    const tryAt = afterMkdtemp.indexOf('\n  try {');
    const mkdirRepoAt = afterMkdtemp.indexOf('mkdirSync(repo)');
    const mkdirHomeAt = afterMkdtemp.indexOf('mkdirSync(home)');
    const gitEnvAt = afterMkdtemp.indexOf('gitEnv(home)');
    expect(tryAt).toBeGreaterThanOrEqual(0);
    expect(mkdirRepoAt).toBeGreaterThan(tryAt);
    expect(mkdirHomeAt).toBeGreaterThan(mkdirRepoAt);
    expect(gitEnvAt).toBeGreaterThan(mkdirHomeAt);
  });

  it('observeFixture materializes only a disposable tmp repo', async () => {
    const profile = getObservedFixtureProfile('status-probe');
    const variant = getObservedFixtureVariant(profile, 'baseline');
    const observation = await observeFixture(profile, variant);
    try {
      expect(observation.repo.startsWith(tmpdir()) || observation.repo.includes('/observed-fixture-')).toBe(true);
      expect(observation.faults).toEqual([]);
      expect(observation.checks[0]?.status).toBe('failed');
    } finally {
      await removeObservationRepo(observation.cleanupDir);
    }
  });
});

describe('observed fixture setup-fault cleanup', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('mkdirSync failure after mkdtemp is an observation fault and leaves cleanupDir for the caller', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        mkdirSync(
          target: Parameters<typeof actual.mkdirSync>[0],
          options?: Parameters<typeof actual.mkdirSync>[1],
        ) {
          const asString = String(target);
          if (asString.endsWith(`${path.sep}repo`) || asString.endsWith('/repo')) {
            throw new Error('injected mkdir failure');
          }
          return actual.mkdirSync(target, options);
        },
      };
    });
    const { observeFixture: observe, removeObservationRepo: remove } = await import(
      '../../backend/src/cli/observed-fixture-observer'
    );
    const { getObservedFixtureProfile: getProfile, getObservedFixtureVariant: getVariant } = await import(
      '../../backend/src/cli/observed-fixture-profiles'
    );
    const profile = getProfile('status-probe');
    const variant = getVariant(profile, 'baseline');
    const observation = await observe(profile, variant);
    try {
      expect(observation.faults[0]?.code).toBe('OBSERVATION_FAULT');
      expect(observation.faults[0]?.message).toContain('injected mkdir failure');
      expect(existsSync(observation.cleanupDir)).toBe(true);
    } finally {
      await remove(observation.cleanupDir);
      expect(existsSync(observation.cleanupDir)).toBe(false);
    }
  });
});
