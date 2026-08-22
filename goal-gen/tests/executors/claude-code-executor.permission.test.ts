/**
 * Regression tests for fail-closed permission-mode handling (finding F1).
 *
 * The defect being pinned: the executor used to coerce an absent or unknown
 * `action.payload.permissionMode` to `bypassPermissions` — the single most permissive mode — via
 * `requestedMode && ALLOWED.has(requestedMode) ? requestedMode : 'bypassPermissions'`. The
 * guidance invariant is the opposite: unknown modes are REJECTED, and bypass is only ever an
 * explicit host choice, never a fallback (permission-profiles.json invariant; 06_SECURITY doc).
 *
 * `claude` is never actually spawned here: child_process is mocked so we can (a) assert the exact
 * `--permission-mode` argv the executor would pass and (b) prove the fail-closed paths never reach
 * spawn at all.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
    spawnSync: spawnSyncMock,
  };
});

import { ClaudeCodeExecutor } from '../../backend/src/executors/claude-code-executor';
import type { Action } from '../../backend/src/planner/types';
import type { RunContext } from '../../backend/src/types';

const FAKE_SHA = 'a'.repeat(40);

/** Minimal fake `claude` child: emits a success envelope on stdout, then close(0). */
function fakeClaudeChild(): unknown {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (sig?: string) => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => {
    child.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })),
    );
    child.emit('close', 0, null);
  });
  return child;
}

function action(payload: Action['payload']): Action {
  return {
    id: 'a1',
    name: 'test action',
    cost: 1,
    preconditions: {},
    effects: { done: true },
    executor: 'claude-code',
    payload,
    verify: { command: 'true' },
  };
}

function ctx(): RunContext {
  return {
    runId: 'r1',
    worktreePath: '/tmp/fake-worktree',
    signal: new AbortController().signal,
    budgetUsdRemaining: 5,
  };
}

/** The `--permission-mode` value from the argv of the (single) spawn call, or undefined. */
function spawnedPermissionMode(): string | undefined {
  const call = spawnMock.mock.calls[0];
  if (!call) return undefined;
  const argv = call[1] as string[];
  const i = argv.indexOf('--permission-mode');
  return i >= 0 ? argv[i + 1] : undefined;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  // git rev-parse HEAD / status --porcelain baselines succeed with a stable SHA and clean tree.
  spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes('rev-parse')) return { status: 0, stdout: `${FAKE_SHA}\n`, stderr: '', error: undefined };
    return { status: 0, stdout: '', stderr: '', error: undefined };
  });
  spawnMock.mockImplementation(() => fakeClaudeChild());
});

describe('fail-closed permission-mode handling (F1 regression)', () => {
  it('absent payload mode uses the host-configured mode — never bypassPermissions by default', async () => {
    const exec = new ClaudeCodeExecutor(); // default configured mode: acceptEdits
    const run = await exec.run(action({ prompt: 'p' }), ctx());
    expect(run.status).toBe('succeeded');
    expect(spawnedPermissionMode()).toBe('acceptEdits');
  });

  it('unknown payload mode fails the action closed without spawning anything', async () => {
    const exec = new ClaudeCodeExecutor();
    const run = await exec.run(action({ prompt: 'p', permissionMode: 'garbage-mode' }), ctx());
    expect(run.status).toBe('failed');
    expect(run.stderr).toContain('fail-closed');
    expect(run.stderr).toContain('garbage-mode');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('a payload can never request bypassPermissions — even though the CLI supports it', async () => {
    const exec = new ClaudeCodeExecutor({ permissionMode: 'acceptEdits' });
    const run = await exec.run(action({ prompt: 'p', permissionMode: 'bypassPermissions' }), ctx());
    expect(run.status).toBe('failed');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('a payload cannot escalate above the configured mode (plan-configured run rejects acceptEdits)', async () => {
    const exec = new ClaudeCodeExecutor({ permissionMode: 'plan' });
    const run = await exec.run(action({ prompt: 'p', permissionMode: 'acceptEdits' }), ctx());
    expect(run.status).toBe('failed');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('a payload may narrow: plan requested under an acceptEdits-configured run is honored', async () => {
    const exec = new ClaudeCodeExecutor({ permissionMode: 'acceptEdits' });
    const run = await exec.run(action({ prompt: 'p', permissionMode: 'plan' }), ctx());
    expect(run.status).toBe('succeeded');
    expect(spawnedPermissionMode()).toBe('plan');
  });

  it('bypassPermissions is reachable only as an explicit host configuration', async () => {
    const exec = new ClaudeCodeExecutor({ permissionMode: 'bypassPermissions' });
    const run = await exec.run(action({ prompt: 'p' }), ctx());
    expect(run.status).toBe('succeeded');
    expect(spawnedPermissionMode()).toBe('bypassPermissions');
  });

  it('an unknown configured mode throws at construction (host config error, not coercion)', () => {
    expect(() => new ClaudeCodeExecutor({ permissionMode: 'yolo' as never })).toThrow(/fail-closed/);
  });
});
