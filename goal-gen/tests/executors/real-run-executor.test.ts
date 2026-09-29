/**
 * `createRealRunExecutor` (ADR-0020, AGX-R11/R12/R13/R15). child_process is mocked, so no worker
 * is ever spawned: the tests assert the exact argv the executor would pass, and that every
 * pre-spawn refusal leaves the spawn mock untouched.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock, spawnSync: spawnSyncMock };
});

import { RunApprovalError } from '../../backend/src/cli/errors';
import type { RunManifest } from '../../backend/src/cli/run-manifest';
import { ClaudeCodeExecutor, REAL_RUN_DENY_RULES } from '../../backend/src/executors/claude-code-executor';
import { createRealRunExecutor } from '../../backend/src/executors/real-run-executor';
import type { Action } from '../../backend/src/planner/types';
import type { RunContext } from '../../backend/src/types';

const FAKE_SHA = 'a'.repeat(40);
const HEX = 'b'.repeat(64);

const SUCCESS_ENVELOPE = { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.08 };

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 'yellow-goal/run-manifest/v1',
    engineVersion: '0.2.0',
    protocolId: 'yellow-goal/provider-protocol/v2',
    profile: { id: 'config-repair', version: '2', digest: HEX },
    requestHash: HEX,
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    allowedTools: ['Edit(./SITE)', 'Edit(./site.json)', 'Read(./**)'],
    disallowedTools: ['Bash', 'WebFetch'],
    maxTurns: 8,
    caps: { perActionUsd: 0.5, totalUsd: 5 },
    actionTimeoutMs: 300_000,
    runWallClockMs: 900_000,
    authMode: 'subscription',
    attemptCount: 1,
    expiresInMinutes: 60,
    ...overrides,
  };
}

function fakeChild(envelope: unknown = SUCCESS_ENVELOPE): unknown {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { on: () => void; end: (text: string) => void };
    kill: (sig?: string) => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on: () => {}, end: (text: string) => stdinWrites.push(text) };
  child.kill = () => true;
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify(envelope)));
    child.emit('close', 0, null);
  });
  return child;
}

function action(payload: Action['payload'] = { prompt: 'repair the site' }): Action {
  return {
    id: 'a1',
    name: 'repair',
    cost: 1,
    preconditions: {},
    effects: { done: true },
    executor: 'claude-code',
    payload,
    verify: { command: 'true' },
  };
}

// Real directories: the real-run pre-spawn checks look for worker config in the worktree and
// realpath the git dir, which must lie outside it. git itself is mocked.
let scratch: string;
let worktreeDir: string;
let gitDir: string;
const stdinWrites: string[] = [];

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'real-run-executor-'));
  worktreeDir = mkdtempSync(path.join(scratch, 'wt-'));
  gitDir = mkdtempSync(path.join(scratch, 'gitdir-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function ctx(): RunContext {
  return { runId: 'r1', worktreePath: worktreeDir, signal: new AbortController().signal, budgetUsdRemaining: 5 };
}

function spawnedArgv(): string[] {
  const call = spawnMock.mock.calls[0];
  if (!call) throw new Error('nothing spawned');
  return call[1] as string[];
}

function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, i) => (arg === flag ? [argv[i + 1]!] : []));
}

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof RunApprovalError) return err.code;
    throw err;
  }
  return undefined;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  stdinWrites.length = 0;
  spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes('--absolute-git-dir')) return { status: 0, stdout: `${gitDir}\n`, stderr: '', error: undefined };
    if (args.includes('rev-parse')) return { status: 0, stdout: `${FAKE_SHA}\n`, stderr: '', error: undefined };
    return { status: 0, stdout: '', stderr: '', error: undefined };
  });
  spawnMock.mockImplementation(() => fakeChild());
  vi.stubEnv('ANTHROPIC_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createRealRunExecutor argv (AGX-R11/R12/R15)', () => {
  it('emits acceptEdits, one flag per approved tool rule, the per-action budget, and the injected command', async () => {
    const exec = createRealRunExecutor(manifest(), {
      workerCommand: { file: '/usr/bin/node', args: ['/fake/worker.mjs', '--scenario', 'success'] },
    });
    const run = await exec.run(action(), ctx());
    expect(run.status).toBe('succeeded');
    expect(run.costUsd).toBe(0.08);
    const [file, argv, options] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(file).toBe('/usr/bin/node');
    expect(argv.slice(0, 3)).toEqual(['/fake/worker.mjs', '--scenario', 'success']);
    expect(flagValues(argv, '--permission-mode')).toEqual(['acceptEdits']);
    expect(flagValues(argv, '--allowedTools')).toEqual(['Edit(./SITE)', 'Edit(./site.json)', 'Read(./**)']);
    expect(flagValues(argv, '--tools')).toEqual(['Edit,Read']);
    expect(flagValues(argv, '--disallowedTools')).toEqual(['Bash', 'WebFetch', ...REAL_RUN_DENY_RULES]);
    expect(REAL_RUN_DENY_RULES).toEqual(
      expect.arrayContaining([
        'Edit(./.claude/**)',
        'Write(./.git/**)',
        'Write(./.mcp.json)',
        'Write(./**/.claude/**)',
        'Write(./**/.git/**)',
        'Edit(./CLAUDE.local.md)',
        'Bash',
        'WebFetch',
        'WebSearch',
      ]),
    );
    expect(flagValues(argv, '--max-budget-usd')).toEqual(['0.5']);
    expect(flagValues(argv, '--model')).toEqual(['sonnet']);
    expect(flagValues(argv, '--max-turns')).toEqual(['8']);
    expect(argv).not.toContain('--settings');
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('defaults to the claude command and pins the worker config (no user settings, no MCP servers)', async () => {
    await createRealRunExecutor(manifest()).run(action(), ctx());
    expect(spawnMock.mock.calls[0]![0]).toBe('claude');
    const argv = spawnedArgv();
    expect(flagValues(argv, '--setting-sources')).toEqual(['project']);
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).not.toContain('--settings');
  });

  it('sends the prompt on stdin, never argv, so it cannot be parsed as a flag or subcommand', async () => {
    for (const prompt of ['--mcp-config={}', 'update']) {
      spawnMock.mockClear();
      stdinWrites.length = 0;
      await createRealRunExecutor(manifest()).run(action({ prompt }), ctx());
      expect(spawnedArgv()).not.toContain(prompt);
      expect(stdinWrites).toEqual([prompt]);
    }
  });

  it('refuses before spawning when the git dir cannot be resolved', async () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--absolute-git-dir')) return { status: 128, stdout: '', stderr: 'not a git repository', error: undefined };
      if (args.includes('rev-parse')) return { status: 0, stdout: `${FAKE_SHA}\n`, stderr: '', error: undefined };
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });
    const run = await createRealRunExecutor(manifest()).run(action(), ctx());
    expect(run.status).toBe('failed');
    expect(run.stderr).toContain('git dir unavailable');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses before spawning when the git dir resolves inside the worktree', async () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--absolute-git-dir')) return { status: 0, stdout: `${worktreeDir}\n`, stderr: '', error: undefined };
      if (args.includes('rev-parse')) return { status: 0, stdout: `${FAKE_SHA}\n`, stderr: '', error: undefined };
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });
    const run = await createRealRunExecutor(manifest()).run(action(), ctx());
    expect(run.stderr).toContain('inside the worktree');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('a negative reported cost is not a meter reading: the run fails as malformed output', async () => {
    spawnMock.mockImplementation(() => fakeChild({ ...SUCCESS_ENVELOPE, total_cost_usd: -1 }));
    const run = await createRealRunExecutor(manifest()).run(action(), ctx());
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('malformed-output');
    expect(run.costUsd).toBeUndefined();
  });

  it('fixes the approved mode: an action payload cannot change it, even to narrow', async () => {
    const exec = createRealRunExecutor(manifest());
    const run = await exec.run(action({ prompt: 'p', permissionMode: 'plan' }), ctx());
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('mode-rejected');
    expect(run.costUsd).toBeUndefined();
    expect(run.stderr).toContain("rejected action permissionMode 'plan'");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('an action requesting the approved mode itself spawns normally', async () => {
    const run = await createRealRunExecutor(manifest()).run(action({ prompt: 'p', permissionMode: 'acceptEdits' }), ctx());
    expect(run.status).toBe('succeeded');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('pins to the caller-recorded git dir (ctx.gitDir) instead of re-resolving it', async () => {
    // The worktree's own .git would resolve inside it; the recorded dir is trusted instead.
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--absolute-git-dir')) return { status: 0, stdout: `${worktreeDir}\n`, stderr: '', error: undefined };
      if (args.includes('rev-parse')) return { status: 0, stdout: `${FAKE_SHA}\n`, stderr: '', error: undefined };
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });
    const run = await createRealRunExecutor(manifest()).run(action(), { ...ctx(), gitDir });
    expect(run.status).toBe('succeeded');
    const gitCalls = spawnSyncMock.mock.calls as Array<[string, string[], { env: NodeJS.ProcessEnv }]>;
    expect(gitCalls.some(([, args]) => args.includes('--absolute-git-dir'))).toBe(false);
    expect(gitCalls.every(([, args, opts]) => args.includes('core.fsmonitor=false') && opts.env.GIT_DIR === gitDir)).toBe(true);
  });

  it('a caller-recorded git dir that no longer exists is a refusal, not a thrown error', async () => {
    const run = await createRealRunExecutor(manifest()).run(action(), { ...ctx(), gitDir: path.join(scratch, 'missing') });
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('worktree-refused');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('auth-mode guard at spawn time (AGX-R13)', () => {
  it('refuses an API key under subscription auth without spawning', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const run = await createRealRunExecutor(manifest({ authMode: 'subscription' })).run(action(), ctx());
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('auth-mode-mismatch');
    expect(run.stderr).toContain('AUTH_MODE_MISMATCH');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses api-key auth without a key without spawning', async () => {
    const run = await createRealRunExecutor(manifest({ authMode: 'api-key' })).run(action(), ctx());
    expect(run.failureClass).toBe('auth-mode-mismatch');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([['ANTHROPIC_AUTH_TOKEN'], ['ANTHROPIC_BASE_URL'], ['CLAUDE_CODE_USE_BEDROCK'], ['CLAUDE_CODE_OAUTH_TOKEN']])(
    'refuses when %s would override the approved credential',
    async (name) => {
      vi.stubEnv(name, '1');
      const run = await createRealRunExecutor(manifest()).run(action(), ctx());
      expect(run.failureClass).toBe('auth-mode-mismatch');
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it('spawns when api-key auth has a key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const run = await createRealRunExecutor(manifest({ authMode: 'api-key' })).run(action(), ctx());
    expect(run.status).toBe('succeeded');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('filesystem confinement before spawn (AGX-R11 negative fixture)', () => {
  it.each([
    ['Edit'],
    ['Bash(ls)'],
    ['Read(//etc/**)'],
    ['Edit(../x)'],
    ['Read(~/.ssh/**)'],
    ['Write(/site.json)'],
    ['Edit(C:\\x)'],
  ])('refuses an allowlist containing %s at construction', (rule) => {
    expect(refusalCode(() => createRealRunExecutor(manifest({ allowedTools: ['Edit(./site.json)', rule] })))).toBe(
      'TOOLS_UNCONFINED',
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('caps (AGX-R12)', () => {
  it('rejects a per-action cap above the total cap', () => {
    expect(refusalCode(() => createRealRunExecutor(manifest({ caps: { perActionUsd: 6, totalUsd: 5 } })))).toBe(
      'MANIFEST_INVALID',
    );
  });

  it('rejects a total cap above the ADR-0010 default', () => {
    expect(refusalCode(() => createRealRunExecutor(manifest({ caps: { perActionUsd: 1, totalUsd: 25 } })))).toBe(
      'MANIFEST_INVALID',
    );
  });

  it('a result without a cost figure is cost-unmetered, not success', async () => {
    spawnMock.mockImplementation(() => fakeChild({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));
    const run = await createRealRunExecutor(manifest()).run(action(), ctx());
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('cost-unmetered');
    expect(run.costUsd).toBeUndefined();
  });
});

/** A child that never answers on its own; kill() makes it close with the signal. */
function hangingChild(): unknown {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { on: () => void; end: (text: string) => void };
    kill: (sig?: string) => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on: () => {}, end: () => {} };
  child.kill = (sig?: string) => {
    queueMicrotask(() => child.emit('close', null, sig ?? 'SIGTERM'));
    return true;
  };
  return child;
}

describe('real-run failure classes for kill reasons (AGX-R19)', () => {
  it('timeout', async () => {
    spawnMock.mockImplementation(() => hangingChild());
    const run = await createRealRunExecutor(manifest({ actionTimeoutMs: 20 })).run(action(), ctx());
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('timeout');
    expect(run.costUsd).toBeUndefined();
  });

  it('cancel', async () => {
    spawnMock.mockImplementation(() => hangingChild());
    const controller = new AbortController();
    const pending = createRealRunExecutor(manifest()).run(action(), { ...ctx(), signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const run = await pending;
    expect(run.status).toBe('cancelled');
    expect(run.failureClass).toBe('cancel');
  });

  it('spawn-error', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    const run = await createRealRunExecutor(manifest()).run(action(), ctx());
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('spawn-error');
    expect(run.costUsd).toBeUndefined();
  });
});

describe('direct realRun construction is validated (AGX-R12)', () => {
  const base = { allowedTools: ['Edit(./site.json)'], disallowedTools: [] as string[], maxBudgetUsd: 0.5, authMode: 'subscription' as const };

  it.each([[0], [-1], [Number.NaN], [20.01], [Number.POSITIVE_INFINITY]])('refuses maxBudgetUsd %s', (maxBudgetUsd) => {
    expect(refusalCode(() => new ClaudeCodeExecutor({ realRun: { ...base, maxBudgetUsd } }))).toBe('MANIFEST_INVALID');
  });

  it.each([[0], [1.5], [Number.NaN]])('refuses maxTurns %s', (maxTurns) => {
    expect(refusalCode(() => new ClaudeCodeExecutor({ maxTurns, realRun: base }))).toBe('MANIFEST_INVALID');
  });

  it.each([[['--settings']], [['']]])('refuses disallowed rule %j', (disallowedTools) => {
    expect(refusalCode(() => new ClaudeCodeExecutor({ realRun: { ...base, disallowedTools } }))).toBe('MANIFEST_INVALID');
  });
});

describe('permission mode is only ever acceptEdits (AGX-R11, exhaustive)', () => {
  const candidates: unknown[] = ['acceptEdits', 'plan', 'auto', 'dontAsk', 'manual', 'bypassPermissions', '', undefined, 42];

  it.each(candidates.map((mode) => [mode]))('manifest permissionMode %s either refuses or spawns acceptEdits', async (mode) => {
    let exec: ClaudeCodeExecutor | undefined;
    try {
      exec = createRealRunExecutor({ ...manifest(), permissionMode: mode } as unknown as RunManifest);
    } catch (err) {
      expect(err).toBeInstanceOf(RunApprovalError);
      return;
    }
    expect(mode).toBe('acceptEdits');
    await exec.run(action(), ctx());
    expect(flagValues(spawnedArgv(), '--permission-mode')).toEqual(['acceptEdits']);
  });

  it.each(candidates.map((mode) => [mode]))(
    'a realRun executor configured with %s either refuses or spawns acceptEdits',
    async (mode) => {
      let exec: ClaudeCodeExecutor | undefined;
      try {
        exec = new ClaudeCodeExecutor({
          permissionMode: mode as never,
          realRun: { allowedTools: ['Edit(./site.json)'], disallowedTools: [], maxBudgetUsd: 0.5, authMode: 'subscription' },
        });
      } catch (err) {
        expect(err).toBeInstanceOf(RunApprovalError);
        return;
      }
      // `undefined` resolves to the default, which is acceptEdits.
      expect([undefined, 'acceptEdits']).toContain(mode);
      await exec.run(action(), ctx());
      expect(flagValues(spawnedArgv(), '--permission-mode')).toEqual(['acceptEdits']);
    },
  );
});
