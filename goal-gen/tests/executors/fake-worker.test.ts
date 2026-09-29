/**
 * AGX-R32: the real-run executor against the fake worker, as a real child process — no
 * child_process mock. Every recorded-envelope scenario must produce exactly one worker
 * invocation and the expected outcome, with zero spend (no real `claude`).
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCandidateOfflineProfile } from '../../backend/src/cli/candidate-offline-profiles';
import type { RunManifest } from '../../backend/src/cli/run-manifest';
import { ClaudeCodeExecutor } from '../../backend/src/executors/claude-code-executor';
import { createRealRunExecutor } from '../../backend/src/executors/real-run-executor';
import { createWorktree, type WorktreeHandle } from '../../backend/src/executors/worktree';
import type { Action } from '../../backend/src/planner/types';
import type { AgentRunFailureClass } from '../../backend/src/types';

const FAKE_WORKER = path.join(__dirname, '..', 'fixtures', 'claude-worker', 'fake-claude.mjs');
const HEX = 'c'.repeat(64);

function manifest(): RunManifest {
  return {
    schemaVersion: 'yellow-goal/run-manifest/v1',
    engineVersion: '0.2.0',
    protocolId: 'yellow-goal/provider-protocol/v2',
    profile: { id: 'config-repair', version: '2', digest: HEX },
    requestHash: HEX,
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    allowedTools: ['Edit(./SITE)', 'Edit(./site.json)', 'Read(./**)'],
    disallowedTools: [],
    maxTurns: 8,
    caps: { perActionUsd: 0.5, totalUsd: 5 },
    // Well inside vitest's 30s test timeout, so a hung worker takes the executor's own timeout path.
    actionTimeoutMs: 5_000,
    runWallClockMs: 120_000,
    authMode: 'subscription',
    attemptCount: 1,
    expiresInMinutes: 60,
  };
}

function action(): Action {
  const profile = getCandidateOfflineProfile('config-repair', '2');
  return {
    id: 'repair',
    name: 'config-repair milestone',
    cost: 1,
    preconditions: {},
    effects: { done: true },
    executor: 'claude-code',
    payload: { prompt: profile.milestoneText! },
    verify: { command: 'true' },
  };
}

let dir: string;
let worktree: WorktreeHandle;

beforeEach(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  dir = await mkdtemp(path.join(tmpdir(), 'fake-worker-'));
  worktree = await createWorktree({ seedFiles: getCandidateOfflineProfile('config-repair', '2').baseFiles });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await worktree.cleanup();
  await rm(dir, { recursive: true, force: true });
});

async function runScenario(scenario: string) {
  return runScenarioIn(worktree, scenario);
}

async function runScenarioIn(target: WorktreeHandle, scenario: string) {
  const record = path.join(dir, 'invocations.jsonl');
  const exec = createRealRunExecutor(manifest(), {
    workerCommand: { file: process.execPath, args: [FAKE_WORKER, '--scenario', scenario, '--record', record] },
  });
  const run = await exec.run(action(), {
    runId: 'fake',
    worktreePath: target.worktreePath,
    signal: new AbortController().signal,
    budgetUsdRemaining: 5,
  });
  const invocations = (await readFile(record, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { argv: string[]; prompt: string; cwd: string; apiKeyPresent: boolean });
  return { run, invocations };
}

describe('fake worker scenarios (AGX-R32)', () => {
  it('success: one invocation with the approved argv, metered cost, candidate written', async () => {
    const { run, invocations } = await runScenario('success');
    expect(run.status).toBe('succeeded');
    expect(run.failureClass).toBeUndefined();
    expect(run.costUsd).toBeCloseTo(0.0803324);
    expect(run.diffRef).toMatch(/^dirty:/);
    expect(invocations).toHaveLength(1);
    const [invocation] = invocations;
    expect(invocation!.cwd).toBe(worktree.worktreePath);
    expect(invocation!.apiKeyPresent).toBe(false);
    expect(invocation!.prompt).toBe(getCandidateOfflineProfile('config-repair', '2').milestoneText);
    expect(invocation!.argv).not.toContain(invocation!.prompt);
    expect(invocation!.argv).toEqual(
      expect.arrayContaining(['--permission-mode', 'acceptEdits', '--max-budget-usd', '0.5', '--allowedTools', 'Edit(./site.json)']),
    );
    expect(invocation!.argv).toEqual(expect.arrayContaining(['--setting-sources', 'project', '--strict-mcp-config']));
    expect(await readFile(path.join(worktree.worktreePath, 'SITE'), 'utf8')).toBe('alpha.test\n');
  });

  it.each<[string, AgentRunFailureClass, number | undefined]>([
    ['error-result', 'error-result', 0.0121],
    ['budget-stop', 'budget', 0.0121978],
    ['max-turns', 'max-turns', 0.0122338],
    ['permission-denial', 'permission-denied', 0.032695],
    ['malformed-output', 'malformed-output', undefined],
    ['missing-cost', 'cost-unmetered', undefined],
  ])('%s: one invocation, failed as %s', async (scenario, failureClass, cost) => {
    const { run, invocations } = await runScenario(scenario);
    expect(invocations).toHaveLength(1);
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe(failureClass);
    if (cost === undefined) expect(run.costUsd).toBeUndefined();
    else expect(run.costUsd).toBeCloseTo(cost);
  });

  it('gitfile-rewrite: the engine git calls stay pinned, so a planted core.fsmonitor never runs', async () => {
    const { run, invocations } = await runScenario('gitfile-rewrite');
    expect(invocations).toHaveLength(1);
    expect(run.status).toBe('succeeded');
    expect(run.diffRef).toMatch(/^dirty:/);
    expect(existsSync(path.join(worktree.worktreePath, 'fsmonitor-ran'))).toBe(false);
  });

  it.each<[string, (root: string) => void]>([
    ['.claude directory', (root) => mkdirSync(path.join(root, '.claude'))],
    ['.mcp.json file', (root) => writeFileSync(path.join(root, '.mcp.json'), '{}\n')],
    ['CLAUDE.local.md file', (root) => writeFileSync(path.join(root, 'CLAUDE.local.md'), 'x\n')],
    ['dangling .claude symlink', (root) => symlinkSync(path.join(root, 'missing-target'), path.join(root, '.claude'))],
  ])('refuses a worktree that already holds worker config (%s), with zero invocations', async (_label, plant) => {
    plant(worktree.worktreePath);
    const record = path.join(dir, 'invocations.jsonl');
    const exec = createRealRunExecutor(manifest(), {
      workerCommand: { file: process.execPath, args: [FAKE_WORKER, '--scenario', 'success', '--record', record] },
    });
    const run = await exec.run(action(), {
      runId: 'fake',
      worktreePath: worktree.worktreePath,
      signal: new AbortController().signal,
      budgetUsdRemaining: 5,
    });
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('worktree-refused');
    expect(run.stderr).toContain('worktree already contains worker config');
    expect(existsSync(record)).toBe(false);
  });

  it('legacy (non-real-run) path: the activity oracle never runs a planted core.fsmonitor either', async () => {
    const record = path.join(dir, 'invocations.jsonl');
    const legacy = new ClaudeCodeExecutor({
      workerCommand: { file: process.execPath, args: [FAKE_WORKER, '--scenario', 'gitfile-rewrite', '--record', record] },
    });
    const run = await legacy.run(action(), {
      runId: 'fake',
      worktreePath: worktree.worktreePath,
      signal: new AbortController().signal,
      budgetUsdRemaining: 5,
      gitDir: worktree.gitDir,
    });
    expect(run.status).toBe('succeeded');
    expect(run.diffRef).toMatch(/^dirty:/);
    expect(existsSync(path.join(worktree.worktreePath, 'fsmonitor-ran'))).toBe(false);
  });

  it('refuses a worktree whose .git gitfile already points inside it, with zero invocations', async () => {
    mkdirSync(path.join(worktree.worktreePath, 'planted', 'objects'), { recursive: true });
    mkdirSync(path.join(worktree.worktreePath, 'planted', 'refs', 'heads'), { recursive: true });
    writeFileSync(path.join(worktree.worktreePath, 'planted', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(worktree.worktreePath, 'planted', 'config'), '[core]\n\trepositoryformatversion = 0\n');
    writeFileSync(path.join(worktree.worktreePath, '.git'), 'gitdir: ./planted\n');
    const record = path.join(dir, 'invocations.jsonl');
    const exec = createRealRunExecutor(manifest(), {
      workerCommand: { file: process.execPath, args: [FAKE_WORKER, '--scenario', 'success', '--record', record] },
    });
    const run = await exec.run(action(), {
      runId: 'fake',
      worktreePath: worktree.worktreePath,
      signal: new AbortController().signal,
      budgetUsdRemaining: 5,
    });
    expect(run.status).toBe('failed');
    expect(existsSync(record)).toBe(false);
  });

  it('noise-only: a modified tracked noise file is not a change (porcelain -z leading space)', async () => {
    const seeded = await createWorktree({
      seedFiles: { ...getCandidateOfflineProfile('config-repair', '2').baseFiles, 'ruvector.db': 'seed\n' },
    });
    try {
      const { run } = await runScenarioIn(seeded, 'noise-only');
      expect(run.status).toBe('succeeded');
      expect(run.diffRef).toBeUndefined();
    } finally {
      await seeded.cleanup();
    }
  });
});
