/**
 * Orchestrator loop unit tests (plan task 5.1) — deterministic, stubbed, zero `claude` spend.
 * Covers: happy-path termination, the confirm-DoD `n` gate, budget accumulation + trip, per-action
 * retry-then-pass, the WorldState update rule (successPredicate preferred / effects fallback), the
 * `plan()` throw-catch → re-extraction path, re-extraction recovery, replan-then-recover, and
 * extraction failure. Every dependency (executor, verifier, extractor, worktree, confirm) is a
 * deterministic in-memory double.
 */
import { describe, expect, it } from 'vitest';
import { StubExecutor, StubVerifier } from '../../backend/src/executors/stub-executor';
import type { StubAgentOutcome } from '../../backend/src/executors/stub-executor';
import { StubExtractor } from '../../backend/src/extractors/stub-extractor';
import { defaultRunConfig } from '../../backend/src/orchestrator/guardrails';
import { Orchestrator } from '../../backend/src/orchestrator/orchestrator';
import type { WorktreeProvider } from '../../backend/src/orchestrator/orchestrator';
import type { Action, GoalSpec, WorldState } from '../../backend/src/planner/types';
import type { RunConfig, VerifyResult } from '../../backend/src/types';

/** Worktree double — the stubs ignore the path, so this never touches the filesystem. */
const stubWorktree: WorktreeProvider = async (opts) => ({
  root: '(stub)',
  worktreePath: '(stub)',
  branch: opts.branch ?? 'run',
  initialSha: '0'.repeat(40),
  cleanup: async () => {},
});

function action(id: string, preconditions: WorldState, effects: WorldState, verifyCommand: string): Action {
  return { id, name: id, cost: 1, preconditions, effects, executor: 'claude-code', payload: {}, verify: { command: verifyCommand } };
}

interface Harness {
  goalSpec: GoalSpec;
  expansions?: Action[][];
  executor?: { default?: StubAgentOutcome; byAction?: Record<string, StubAgentOutcome[]> };
  verifier?: { default?: VerifyResult; byCommand?: Record<string, VerifyResult[]> };
  confirm?: boolean;
  config?: Partial<RunConfig>;
  extractError?: Error;
}

function build(h: Harness) {
  const extractor = new StubExtractor({ goalSpec: h.goalSpec, ...(h.expansions ? { expansions: h.expansions } : {}), ...(h.extractError ? { extractError: h.extractError } : {}) });
  const executor = new StubExecutor(h.executor ?? { default: { status: 'succeeded', costUsd: 0 } });
  const verifier = new StubVerifier(h.verifier ?? {});
  const events: Record<string, unknown>[] = [];
  const orch = new Orchestrator({
    extractor,
    executor,
    verifier,
    config: defaultRunConfig(h.config),
    confirm: async () => h.confirm ?? true,
    worktreeProvider: stubWorktree,
    onEvent: (e) => events.push(e),
  });
  return { orch, extractor, executor, verifier, events };
}

const TWO_STEP: GoalSpec = {
  goalText: 'two linear steps',
  initialState: { a: false, b: false },
  goalState: { a: true, b: true },
  constraints: [],
  completionPolicy: 'verify-only',
  actions: [action('s1', { a: false }, { a: true }, 'verify-a'), action('s2', { a: true }, { b: true }, 'verify-b')],
};

describe('orchestrator — happy path', () => {
  it('extracts, plans, confirms, executes serially, and terminates succeeded', async () => {
    const { orch, executor } = build({ goalSpec: TWO_STEP });
    const summary = await orch.run({ goalText: TWO_STEP.goalText });
    expect(summary.status).toBe('succeeded');
    expect(summary.replans).toBe(0);
    expect(summary.reextractions).toBe(0);
    expect(executor.runs.map((r) => r.actionId)).toEqual(['s1', 's2']); // serial, in order
    expect(summary.actions.every((a) => a.status === 'succeeded')).toBe(true);
  });
});

describe('orchestrator — confirm-DoD gate', () => {
  it('n at the DoD gate exits cancelled with no execution', async () => {
    const { orch, executor } = build({ goalSpec: TWO_STEP, confirm: false });
    const summary = await orch.run({ goalText: TWO_STEP.goalText });
    expect(summary.status).toBe('cancelled');
    expect(summary.reason).toMatch(/cancelled at DoD/i);
    expect(executor.runs).toHaveLength(0); // nothing ran
  });
});

describe('orchestrator — budget guardrail', () => {
  it('accumulates cost and trips budget-exhausted before the next dispatch', async () => {
    const { orch, executor } = build({
      goalSpec: TWO_STEP,
      executor: { default: { status: 'succeeded', costUsd: 25 } },
      config: { maxBudgetUsd: 20 },
    });
    const summary = await orch.run({ goalText: TWO_STEP.goalText });
    expect(summary.status).toBe('budget-exhausted');
    expect(executor.runs.map((r) => r.actionId)).toEqual(['s1']); // s2 never dispatched
    expect(summary.costUsd).toBe(25);
  });

  it('trips budget mid-action, between retries of the SAME step', async () => {
    const ONE: GoalSpec = { ...TWO_STEP, goalState: { a: true }, actions: [action('s1', { a: false }, { a: true }, 'verify-a')] };
    // cost 15/run, cap 20, verify always fails ⇒ attempt1 (15) attempt2 (30) attempt3 budget-trips pre-dispatch.
    const { orch, executor } = build({
      goalSpec: ONE,
      executor: { default: { status: 'succeeded', costUsd: 15 } },
      verifier: { default: { exitCode: 1, stdout: '', stderr: 'fail' } },
      config: { maxBudgetUsd: 20, maxRetriesPerAction: 3 },
    });
    const summary = await orch.run({ goalText: 'x' });
    expect(summary.status).toBe('budget-exhausted');
    expect(executor.runs).toHaveLength(2); // 3rd retry tripped the budget BEFORE dispatching
  });
});

describe('orchestrator — per-action retries', () => {
  it('retries within a step and passes on the second attempt', async () => {
    const ONE: GoalSpec = { ...TWO_STEP, goalState: { a: true }, actions: [action('s1', { a: false }, { a: true }, 'verify-a')] };
    const { orch, executor, verifier } = build({
      goalSpec: ONE,
      verifier: { byCommand: { 'verify-a': [{ exitCode: 1, stdout: '', stderr: 'nope' }, { exitCode: 0, stdout: '', stderr: '' }] } },
    });
    const summary = await orch.run({ goalText: 'x' });
    expect(summary.status).toBe('succeeded');
    expect(summary.replans).toBe(0); // retry, not replan
    expect(executor.runs).toHaveLength(2);
    expect(verifier.calls).toHaveLength(2);
    expect(summary.actions[0]?.attempts).toBe(2);
  });
});

describe('orchestrator — WorldState update rule', () => {
  it('applies a non-empty successPredicate (not effects) on a verify pass', async () => {
    const spec: GoalSpec = {
      goalText: 'sp',
      initialState: { done: false },
      goalState: { done: true },
      constraints: [],
      completionPolicy: 'verify-only',
      actions: [
        {
          id: 's1',
          name: 's1',
          cost: 1,
          preconditions: { done: false },
          effects: { done: true, sideEffect: true }, // planner reaches goalState via effects
          executor: 'claude-code',
          payload: {},
          verify: { command: 'v', successPredicate: { done: true } }, // omits sideEffect
        },
      ],
    };
    const { orch, events } = build({ goalSpec: spec });
    const summary = await orch.run({ goalText: 'sp' });
    expect(summary.status).toBe('succeeded');
    const pass = events.find((e) => e['ev'] === 'step.pass');
    expect(pass?.['applied']).toEqual({ done: true }); // successPredicate, NOT effects (no sideEffect)
  });

  it('falls back to effects when there is no successPredicate', async () => {
    const spec: GoalSpec = { ...TWO_STEP, goalState: { a: true }, actions: [action('s1', { a: false }, { a: true }, 'verify-a')] };
    const { orch, events } = build({ goalSpec: spec });
    const summary = await orch.run({ goalText: 'x' });
    expect(summary.status).toBe('succeeded');
    const pass = events.find((e) => e['ev'] === 'step.pass');
    expect(pass?.['applied']).toEqual({ a: true }); // effects, the fallback
  });
});

describe('orchestrator — plan() throw-catch (design decision #3)', () => {
  it('catches a duplicate-id intake throw and routes to bounded re-extraction', async () => {
    const dup: GoalSpec = {
      ...TWO_STEP,
      actions: [action('s1', { a: false }, { a: true }, 'va'), action('s1', { a: true }, { b: true }, 'vb')], // duplicate id
    };
    const { orch, extractor, executor } = build({ goalSpec: dup, expansions: [[], []] });
    const summary = await orch.run({ goalText: 'dup' }); // must NOT throw
    expect(summary.status).toBe('failed');
    expect(summary.reextractions).toBe(2); // bounded by the cap
    expect(extractor.expandCalls).toBe(2); // each throw consumed a re-extraction
    expect(executor.runs).toHaveLength(0); // never got a runnable plan
    expect(summary.reason).toMatch(/re-extraction cap/i);
  });
});

describe('orchestrator — re-extraction recovery', () => {
  it('expands the pool when the initial pool cannot plan, then completes', async () => {
    const empty: GoalSpec = { goalText: 'build', initialState: { built: false }, goalState: { built: true }, constraints: [], completionPolicy: 'verify-only', actions: [] };
    const buildIt = action('build-it', { built: false }, { built: true }, 'verify-built');
    const { orch, extractor, executor } = build({ goalSpec: empty, expansions: [[buildIt]] });
    const summary = await orch.run({ goalText: 'build' });
    expect(summary.status).toBe('succeeded');
    expect(summary.reextractions).toBe(1);
    expect(extractor.expandCalls).toBe(1);
    expect(executor.runs.map((r) => r.actionId)).toEqual(['build-it']);
  });
});

describe('orchestrator — replan then recover', () => {
  it('re-plans after a step exhausts its retries, then succeeds on the re-run', async () => {
    const ONE: GoalSpec = { ...TWO_STEP, goalState: { a: true }, actions: [action('s1', { a: false }, { a: true }, 'verify-a')] };
    // fail all 3 retries, then pass on the post-replan re-run
    const { orch, executor, verifier } = build({
      goalSpec: ONE,
      verifier: {
        byCommand: {
          'verify-a': [
            { exitCode: 1, stdout: '', stderr: 'x' },
            { exitCode: 1, stdout: '', stderr: 'x' },
            { exitCode: 1, stdout: '', stderr: 'x' },
            { exitCode: 0, stdout: '', stderr: '' },
          ],
        },
      },
    });
    const summary = await orch.run({ goalText: 'x' });
    expect(summary.status).toBe('succeeded');
    expect(summary.replans).toBe(1); // one same-pool re-plan
    expect(executor.runs).toHaveLength(4); // 3 failed retries + 1 successful re-run
    expect(verifier.calls).toHaveLength(4);
  });
});

describe('orchestrator — extraction failure', () => {
  it('returns a failed summary (never throws) when extraction errors', async () => {
    const { orch, executor } = build({ goalSpec: TWO_STEP, extractError: new Error('boom') });
    const summary = await orch.run({ goalText: 'x' });
    expect(summary.status).toBe('failed');
    expect(summary.reason).toMatch(/extraction failed: boom/);
    expect(executor.runs).toHaveLength(0);
  });
});
