/**
 * The orchestrator pins every post-run git call to the worktree's pre-run git dir: the handle's
 * `gitDir` reaches both the executor's `RunContext` and `captureDiff`, so an agent that rewrites
 * the worktree's `.git` gitfile cannot redirect the engine's own git calls. `captureDiff` itself
 * is covered against a planted gitfile in tests/executors/diff-capture.test.ts; this pins the
 * wiring, which no other test exercises.
 */
import { describe, expect, it, vi } from 'vitest';

const { captureDiffMock } = vi.hoisted(() => ({ captureDiffMock: vi.fn(() => undefined) }));
vi.mock('../../backend/src/executors/diff-capture', () => ({ captureDiff: captureDiffMock }));

import { StubExecutor, StubVerifier } from '../../backend/src/executors/stub-executor';
import { StubExtractor } from '../../backend/src/extractors/stub-extractor';
import { defaultRunConfig } from '../../backend/src/orchestrator/guardrails';
import { Orchestrator, type WorktreeProvider } from '../../backend/src/orchestrator/orchestrator';
import type { Action, GoalSpec } from '../../backend/src/planner/types';
import type { AgentRun, RunContext } from '../../backend/src/types';

const PINNED_GIT_DIR = '/pinned/scratch/git-dir';

const worktreeProvider: WorktreeProvider = async (opts) => ({
  root: '(stub)',
  worktreePath: '(stub)',
  gitDir: PINNED_GIT_DIR,
  branch: opts.branch ?? 'run',
  initialSha: '0'.repeat(40),
  cleanup: async () => {},
});

/** Records the `RunContext` each dispatch received. */
class ContextRecordingExecutor extends StubExecutor {
  readonly contexts: RunContext[] = [];
  override async run(action: Action, ctx: RunContext): Promise<AgentRun> {
    this.contexts.push(ctx);
    return super.run(action, ctx);
  }
}

const ONE_STEP: GoalSpec = {
  goalText: 'one step',
  initialState: { a: false },
  goalState: { a: true },
  constraints: [],
  completionPolicy: 'verify-only',
  actions: [{ id: 's1', name: 's1', cost: 1, preconditions: { a: false }, effects: { a: true }, executor: 'claude-code', payload: {}, verify: { command: 'verify-a' } }],
};

describe('orchestrator git-dir pin wiring', () => {
  it('passes the handle gitDir to the executor context and to captureDiff', async () => {
    const executor = new ContextRecordingExecutor({ default: { status: 'succeeded', costUsd: 0 } });
    const orch = new Orchestrator({
      extractor: new StubExtractor({ goalSpec: ONE_STEP }),
      executor,
      verifier: new StubVerifier({}),
      config: defaultRunConfig({}),
      confirm: async () => true,
      worktreeProvider,
    });

    const summary = await orch.run({ goalText: ONE_STEP.goalText }, 'gitdir-run');

    expect(summary.status).toBe('succeeded');
    expect(executor.contexts.map((ctx) => ctx.gitDir)).toEqual([PINNED_GIT_DIR]);
    expect(captureDiffMock).toHaveBeenCalledTimes(1);
    expect(captureDiffMock).toHaveBeenCalledWith('(stub)', '0'.repeat(40), PINNED_GIT_DIR);
  });
});
