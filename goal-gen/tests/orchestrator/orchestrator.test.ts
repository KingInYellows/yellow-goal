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
import type { DodConfirmer, PersistenceProvider, WorktreeProvider } from '../../backend/src/orchestrator/orchestrator';
import { RunSession } from '../../backend/src/orchestrator/run-session';
import type { GateKind } from '../../backend/src/orchestrator/run-session';
import type { Action, GoalSpec, WorldState } from '../../backend/src/planner/types';
import type { RunConfig, RunStatus, VerifyResult } from '../../backend/src/types';

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
  /** Cost reported by each expand() call (exercises the re-extraction budget guard). */
  expandCostUsd?: number;
  executor?: { default?: StubAgentOutcome; byAction?: Record<string, StubAgentOutcome[]> };
  verifier?: { default?: VerifyResult; byCommand?: Record<string, VerifyResult[]> };
  /** A fixed answer (default true) or a stateful confirmer for re-confirmation tests. */
  confirm?: boolean | DodConfirmer;
  config?: Partial<RunConfig>;
  extractError?: Error;
  /** Optional injectable persistence dependency (mirrors executor/verifier/confirm) — omitted by
   *  default, so existing tests are unaffected; new tests can inject a fake to assert on
   *  persisted rows (plan Step 9). */
  persistence?: PersistenceProvider;
}

function build(h: Harness) {
  const extractor = new StubExtractor({
    goalSpec: h.goalSpec,
    ...(h.expansions ? { expansions: h.expansions } : {}),
    ...(h.extractError ? { extractError: h.extractError } : {}),
    ...(h.expandCostUsd !== undefined ? { expandCostUsd: h.expandCostUsd } : {}),
  });
  const executor = new StubExecutor(h.executor ?? { default: { status: 'succeeded', costUsd: 0 } });
  const verifier = new StubVerifier(h.verifier ?? {});
  const events: Record<string, unknown>[] = [];
  const fixedAnswer = typeof h.confirm === 'boolean' ? h.confirm : true;
  const confirm: DodConfirmer = typeof h.confirm === 'function' ? h.confirm : async () => fixedAnswer;
  const orch = new Orchestrator({
    extractor,
    executor,
    verifier,
    config: defaultRunConfig(h.config),
    confirm,
    worktreeProvider: stubWorktree,
    onEvent: (e) => events.push(e),
    ...(h.persistence ? { persistence: h.persistence } : {}),
  });
  return { orch, extractor, executor, verifier, events };
}

/** A `RunSession`-backed harness (plan Step 8) — unlike `build()`, this does NOT accept a
 *  `confirm` option: `RunSession` supplies its own `confirm`/`acceptanceGate` bound to its
 *  internal pending-gate slot, so tests interact via `session.resolveGate()`/`pause()`/`resume()`
 *  instead of a fixed answer. `build()`'s `confirm` seam has no equivalent here by design — that
 *  IS the thing this shell adds. */
interface SessionHarness {
  goalSpec: GoalSpec;
  expansions?: Action[][];
  executor?: { default?: StubAgentOutcome; byAction?: Record<string, StubAgentOutcome[]> };
  verifier?: { default?: VerifyResult; byCommand?: Record<string, VerifyResult[]> };
  config?: Partial<RunConfig>;
  persistence?: PersistenceProvider;
}

function buildSession(h: SessionHarness) {
  const extractor = new StubExtractor({
    goalSpec: h.goalSpec,
    ...(h.expansions ? { expansions: h.expansions } : {}),
  });
  const executor = new StubExecutor(h.executor ?? { default: { status: 'succeeded', costUsd: 0 } });
  const verifier = new StubVerifier(h.verifier ?? {});
  const events: Record<string, unknown>[] = [];
  const session = new RunSession({
    extractor,
    executor,
    verifier,
    config: defaultRunConfig(h.config),
    worktreeProvider: stubWorktree,
    onEvent: (e) => events.push(e),
    ...(h.persistence ? { persistence: h.persistence } : {}),
  });
  return { session, extractor, executor, verifier, events };
}

/** Polls `pendingGateKind()` until it matches `kind` — the stand-in for a real HTTP request
 *  arriving after the gate opens (plan Step 8). */
async function waitForGateKind(session: RunSession, kind: GateKind, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (session.pendingGateKind() !== kind) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for gate kind '${kind}' (current: ${session.pendingGateKind()})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function waitForGateKindAndRunCount(session: RunSession, kind: GateKind, runCount: number, executor: StubExecutor, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (session.pendingGateKind() !== kind || executor.runs.length < runCount) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for gate kind '${kind}' with ${runCount} run(s) (current: ${session.pendingGateKind()}, runs: ${executor.runs.length})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** An in-memory `PersistenceProvider` double — records every upserted `Plan` and inserted
 *  `AgentRun`/run so tests can assert on persisted rows without a real database. */
function fakePersistence(): PersistenceProvider & {
  goalSpecs: Array<{ id: string; goalText: string; goalState: Partial<WorldState>; completionPolicy: GoalSpec['completionPolicy'] }>;
  plans: Array<{ id: string; goalSpecId: string; replanOf?: string }>;
  runs: Array<{ id: string; planId: string; status: 'running'; startedAt: string }>;
  agentRuns: Array<{ id: string; planId: string; stepId: string; actionId: string }>;
  runStatuses: Map<string, RunStatus | 'running'>;
  runEvents: Array<{ runId: string; planId: string; stepId?: string; type: string; payload: Record<string, unknown> }>;
} {
  const goalSpecs: Array<{ id: string; goalText: string; goalState: Partial<WorldState>; completionPolicy: GoalSpec['completionPolicy'] }> = [];
  const plans: Array<{ id: string; goalSpecId: string; replanOf?: string }> = [];
  const runs: Array<{ id: string; planId: string; status: 'running'; startedAt: string }> = [];
  const agentRuns: Array<{ id: string; planId: string; stepId: string; actionId: string }> = [];
  const runStatuses = new Map<string, RunStatus | 'running'>();
  const runEvents: Array<{ runId: string; planId: string; stepId?: string; type: string; payload: Record<string, unknown> }> = [];
  return {
    goalSpecs,
    plans,
    runs,
    agentRuns,
    runStatuses,
    runEvents,
    upsertGoalSpec: async (goalSpec) => {
      if (goalSpecs.some((g) => g.id === goalSpec.id)) return;
      goalSpecs.push(goalSpec);
    },
    upsertPlan: async (plan) => {
      if (plans.some((p) => p.id === plan.id)) return; // mirrors ON CONFLICT DO NOTHING
      plans.push({ id: plan.id, goalSpecId: plan.goalSpecId, ...(plan.replanOf ? { replanOf: plan.replanOf } : {}) });
    },
    insertRun: async (run) => {
      runs.push(run);
    },
    insertAgentRun: async (agentRun, runId) => {
      expect(runId).toBeDefined();
      agentRuns.push({ id: agentRun.id, planId: agentRun.planId, stepId: agentRun.stepId, actionId: agentRun.actionId });
    },
    updateRunStatus: async (runId, status) => {
      runStatuses.set(runId, status);
    },
    insertRunEvent: async (event) => {
      runEvents.push(event);
    },
  };
}

const TWO_STEP: GoalSpec = {
  goalText: 'two linear steps',
  initialState: { a: false, b: false },
  goalState: { a: true, b: true },
  constraints: [],
  completionPolicy: 'verify-only',
  actions: [action('s1', { a: false }, { a: true }, 'verify-a'), action('s2', { a: true }, { b: true }, 'verify-b')],
};

describe('orchestrator — persistence seam (plan Step 9)', () => {
  it('upserts the plan once and inserts one run + one agent_run per dispatched step, with deterministic unique stepIds', async () => {
    const persistence = fakePersistence();
    const { orch } = build({ goalSpec: TWO_STEP, persistence });
    const summary = await orch.run({ goalText: TWO_STEP.goalText }, 'test-run-id');
    expect(summary.status).toBe('succeeded');

    expect(persistence.goalSpecs).toHaveLength(1);
    expect(persistence.plans).toHaveLength(1); // single initial plan, no replan/reextraction
    expect(persistence.goalSpecs[0]?.id).toBe(persistence.plans[0]?.goalSpecId);
    const planId = persistence.plans[0]?.id;
    expect(planId).toBeTruthy();

    expect(persistence.runs).toHaveLength(1);
    expect(persistence.runs[0]).toMatchObject({ id: 'test-run-id', planId, status: 'running' });
    expect(persistence.runStatuses.get('test-run-id')).toBe('succeeded');

    expect(persistence.agentRuns).toHaveLength(2);
    expect(persistence.agentRuns.map((r) => r.actionId)).toEqual(['s1', 's2']);
    expect(persistence.agentRuns.every((r) => r.planId === planId)).toBe(true);
    const stepIds = persistence.agentRuns.map((r) => r.stepId);
    expect(new Set(stepIds).size).toBe(2); // unique per dispatched step
    expect(stepIds.every((id) => id.length > 0)).toBe(true);
  });

  it('does not persist anything when no persistence dependency is injected (existing behavior unaffected)', async () => {
    const { orch } = build({ goalSpec: TWO_STEP });
    const summary = await orch.run({ goalText: TWO_STEP.goalText });
    expect(summary.status).toBe('succeeded'); // no throw from the default no-op persistence
  });

  it('does not mark the run persisted when insertRun fails best-effort', async () => {
    const persistence = fakePersistence();
    const statusUpdates: Array<{ runId: string; status: RunStatus | 'running' }> = [];
    const failingPersistence: PersistenceProvider = {
      ...persistence,
      insertRun: async () => {
        throw new Error('insert run failed');
      },
      updateRunStatus: async (runId, status) => {
        statusUpdates.push({ runId, status });
        await persistence.updateRunStatus(runId, status);
      },
    };
    const { orch, events } = build({ goalSpec: TWO_STEP, persistence: failingPersistence });
    const summary = await orch.run({ goalText: TWO_STEP.goalText }, 'run-insert-failed');
    expect(summary.status).toBe('succeeded');
    expect(statusUpdates).toEqual([]);
    expect(events).toContainEqual({ ev: 'persistence.error', op: 'insertRun', message: 'insert run failed' });
  });
});

describe('orchestrator — runId minting (plan Step 7)', () => {
  it('mints a fresh runId per run() call on a REUSED instance, never colliding (the fixed constructor-time bug)', async () => {
    const { orch, executor } = build({ goalSpec: TWO_STEP });
    await orch.run({ goalText: TWO_STEP.goalText }); // no runId passed -> defaults to crypto.randomUUID()
    await orch.run({ goalText: TWO_STEP.goalText }); // same instance, second call
    const runIds = new Set(executor.runs.map((r) => r.runId));
    expect(runIds.size).toBe(2); // one distinct runId per call, not shared across the reused instance
  });

  it('uses the injected runId when supplied (R3/R4: API mints and injects per invocation)', async () => {
    const { orch, executor } = build({ goalSpec: TWO_STEP });
    await orch.run({ goalText: TWO_STEP.goalText }, 'api-minted-uuid');
    expect(executor.runs.every((r) => r.runId === 'api-minted-uuid')).toBe(true);
  });
});

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

describe('orchestrator — repeated action within one plan (PR #8 review P2)', () => {
  it('dispatches a later re-occurrence of an already-passed action rather than skipping it', async () => {
    // A: {} -> {x:1} · B: {x:1} -> {y:1, x:0} (clears x) · C: {x:1} -> {z:1}; goal {x:1,y:1,z:1}.
    // The optimal plan must restore x after B clears it, so A legitimately appears twice: [A, C, B, A].
    // A Set<actionId>-keyed `completed` would mark every occurrence of "A" done after the FIRST pass
    // and silently skip the final A, leaving x unsatisfied forever.
    const spec: GoalSpec = {
      goalText: 'repeat-action',
      initialState: { x: 0, y: 0, z: 0 },
      goalState: { x: 1, y: 1, z: 1 },
      constraints: [],
      completionPolicy: 'verify-only',
      actions: [
        action('A', {}, { x: 1 }, 'verify-A'),
        action('B', { x: 1 }, { y: 1, x: 0 }, 'verify-B'),
        action('C', { x: 1 }, { z: 1 }, 'verify-C'),
      ],
    };
    const { orch, executor } = build({ goalSpec: spec });
    const summary = await orch.run({ goalText: spec.goalText });
    expect(summary.status).toBe('succeeded');
    expect(summary.replans).toBe(0); // resolved within the single initial plan, no replan needed
    const dispatched = executor.runs.map((r) => r.actionId);
    expect(dispatched).toEqual(['A', 'C', 'B', 'A']); // 'A' dispatched BOTH times the plan emits it
    expect(dispatched.filter((id) => id === 'A')).toHaveLength(2);
  });
});

describe('orchestrator — 3-occurrence non-monotonic plan (PR #8/#9 review, cross-plan `completed` staleness)', () => {
  it('walks forward to the final step instead of bouncing back to an intervening one', async () => {
    // P: {} -> {x:1} · Q: {x:1} -> {y:1, x:0} (clears x) · R: {x:1,y:1} -> {w:1}; goal {x:1,y:1,w:1}.
    // R needs BOTH x and y, so it can only run after Q (the only source of y) AND after x is restored
    // (Q clears it) — the unique optimal plan is [P, Q, P, R]. A per-pass "invalidate this actionId's
    // completion when ground truth stops matching what it established" design breaks this: the second
    // P's pass makes Q's own recorded update ({x:0}) stop matching current ground truth (x is back to
    // 1), so Q's completion gets invalidated too — and nextStep's occurrence-scan (from the start of
    // plan.steps) finds Q's now-"undone" occurrence BEFORE it ever reaches R, redispatching Q instead
    // of advancing to R. The plan-local cursor design never re-examines an already-passed position, so
    // this can't happen.
    const spec: GoalSpec = {
      goalText: 'non-monotonic-3-occurrence',
      initialState: { x: 0, y: 0, w: 0 },
      goalState: { x: 1, y: 1, w: 1 },
      constraints: [],
      completionPolicy: 'verify-only',
      actions: [
        action('P', {}, { x: 1 }, 'verify-P'),
        action('Q', { x: 1 }, { y: 1, x: 0 }, 'verify-Q'),
        action('R', { x: 1, y: 1 }, { w: 1 }, 'verify-R'),
      ],
    };
    const { orch, executor } = build({ goalSpec: spec });
    const summary = await orch.run({ goalText: spec.goalText });
    expect(summary.status).toBe('succeeded');
    expect(summary.replans).toBe(0); // resolved within the single initial plan
    expect(executor.runs.map((r) => r.actionId)).toEqual(['P', 'Q', 'P', 'R']);
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

describe('orchestrator — livelock guard (forced-replan streak)', () => {
  // s1 is always applicable (empty preconditions) and its EFFECTS set `k`, but its narrow
  // successPredicate omits `k`. So ground-truth `k` never becomes true, s2 stays perpetually stale,
  // and the planner (blind to `completed`) keeps re-emitting [s1, s2]. Without a streak bound this run
  // would spin forever — this test would HANG. It must terminate.
  const LIVELOCK: GoalSpec = {
    goalText: 'narrow successPredicate strands a downstream step',
    initialState: { k: false, goal: false },
    goalState: { goal: true },
    constraints: [],
    completionPolicy: 'verify-only',
    actions: [
      { id: 's1', name: 's1', cost: 1, preconditions: {}, effects: { a: true, k: true }, executor: 'claude-code', payload: {}, verify: { command: 'va', successPredicate: { a: true } } },
      { id: 's2', name: 's2', cost: 1, preconditions: { k: true }, effects: { goal: true }, executor: 'claude-code', payload: {}, verify: { command: 'vb' } },
    ],
  };

  it('terminates instead of spinning when a narrow successPredicate strands a downstream step', async () => {
    const { orch, executor, events } = build({
      goalSpec: LIVELOCK,
      config: { maxReplans: 3, maxReextractions: 1 },
    });
    const summary = await orch.run({ goalText: 'x' });
    expect(summary.status).toBe('failed'); // bounded — not an infinite loop
    expect(executor.runs.map((r) => r.actionId)).toEqual(['s1']); // s1 dispatched once; s2 never dispatchable
    expect(events.some((e) => e['ev'] === 'replan.loop')).toBe(true); // streak bound tripped
    // Each escalation to re-extraction resets the streak, so the post-re-extraction plan gets a FULL
    // maxReplans budget again — i.e. more than maxReplans(3) total forced replans across the two bursts.
    // (Without the reset this would be exactly 3, re-escalating immediately and skipping the 2nd burst.)
    const forcedReplans = events.filter((e) => e['ev'] === 'replanned' && e['forced'] === true).length;
    expect(forcedReplans).toBeGreaterThan(3);
  });
});

describe('orchestrator — re-confirm replan-introduced actions (PR #8 review P1)', () => {
  // The cheap single-step plan is [s1]; its effects claim both goals but its narrow successPredicate
  // omits g2 (and consumes `fresh`, so s1 cannot be re-applied). The ground-truth gap forces a replan
  // onto s2 — which was in the pool but NOT in the operator-confirmed plan.
  const RECONFIRM: GoalSpec = {
    goalText: 'a replan surfaces a pool action the operator never confirmed',
    initialState: { fresh: true, g1: false, g2: false },
    goalState: { g1: true, g2: true },
    constraints: [],
    completionPolicy: 'verify-only',
    actions: [
      { id: 's1', name: 's1', cost: 1, preconditions: { fresh: true }, effects: { g1: true, g2: true, fresh: false }, executor: 'claude-code', payload: {}, verify: { command: 'v1', successPredicate: { g1: true, fresh: false } } },
      { id: 's2', name: 's2', cost: 1, preconditions: {}, effects: { g2: true }, executor: 'claude-code', payload: {}, verify: { command: 'v2' } },
    ],
  };

  it('re-confirms the DoD before dispatching a same-pool action that was not initially confirmed', async () => {
    const { orch, executor, events } = build({ goalSpec: RECONFIRM });
    const summary = await orch.run({ goalText: 'x' });
    expect(summary.status).toBe('succeeded');
    expect(executor.runs.map((r) => r.actionId)).toEqual(['s1', 's2']);
    const reconf = events.find((e) => e['ev'] === 'dod.reconfirmed' && e['actionId'] === 's2');
    expect(reconf).toBeDefined(); // s2 was re-confirmed before dispatch
  });

  it('cancels when the operator rejects the re-confirmation of a replan-introduced action', async () => {
    let calls = 0;
    const confirm: DodConfirmer = async () => { calls++; return calls === 1; }; // accept initial DoD, reject the re-confirm
    const { orch, executor } = build({ goalSpec: RECONFIRM, confirm });
    const summary = await orch.run({ goalText: 'x' });
    expect(summary.status).toBe('cancelled');
    expect(summary.reason).toMatch(/re-confirmation/i);
    expect(executor.runs.map((r) => r.actionId)).toEqual(['s1']); // s2 rejected, never ran
  });
});

describe('orchestrator — re-extraction ladder uses the full budget (PR #8 review P2)', () => {
  it('keeps expanding while the pool is unsatisfiable until a later round adds the missing action', async () => {
    const empty: GoalSpec = { goalText: 'two-stage build', initialState: { setup: false, built: false }, goalState: { built: true }, constraints: [], completionPolicy: 'verify-only', actions: [] };
    const setupIt = action('setup-it', { setup: false }, { setup: true }, 'verify-setup'); // does NOT reach the goal
    const buildIt = action('build-it', { setup: true }, { built: true }, 'verify-built'); // needs setup first
    const { orch, extractor, executor } = build({ goalSpec: empty, expansions: [[setupIt], [buildIt]], config: { maxReextractions: 2 } });
    const summary = await orch.run({ goalText: 'x' });
    expect(summary.status).toBe('succeeded');
    expect(summary.reextractions).toBe(2); // round 1 (setup, still unreachable) → round 2 (build) → plannable
    expect(extractor.expandCalls).toBe(2);
    expect(executor.runs.map((r) => r.actionId)).toEqual(['setup-it', 'build-it']);
  });
});

describe('orchestrator — re-extraction respects the budget cap (PR #8 review P2)', () => {
  const empty: GoalSpec = { goalText: 'pricey expand', initialState: { setup: false, built: false }, goalState: { built: true }, constraints: [], completionPolicy: 'verify-only', actions: [] };
  const setupIt = action('setup-it', { setup: false }, { setup: true }, 'verify-setup'); // unreachable alone → forces a 2nd round
  const buildIt = action('build-it', { setup: true }, { built: true }, 'verify-built');

  it('stops budget-exhausted when an expansion pushes spend over the cap (after-expand guard)', async () => {
    const { orch, executor } = build({ goalSpec: { ...empty, actions: [] }, expansions: [[buildIt]], expandCostUsd: 25, config: { maxBudgetUsd: 20 } });
    const summary = await orch.run({ goalText: 'x' });
    expect(summary.status).toBe('budget-exhausted');
    expect(summary.reason).toMatch(/re-extraction/i);
    expect(summary.costUsd).toBe(25); // spend is still recorded
    expect(executor.runs).toHaveLength(0); // never reached dispatch
  });

  it('refuses to start a re-extraction once spend is already at the cap (before-expand guard)', async () => {
    // Round 1 spends exactly to the cap (setup, still unreachable → recurse); round 2 must refuse before expand().
    const { orch, extractor, executor } = build({ goalSpec: empty, expansions: [[setupIt], [buildIt]], expandCostUsd: 20, config: { maxBudgetUsd: 20, maxReextractions: 2 } });
    const summary = await orch.run({ goalText: 'x' });
    expect(summary.status).toBe('budget-exhausted');
    expect(summary.reason).toMatch(/before re-extraction/i);
    expect(extractor.expandCalls).toBe(1); // round 2 refused before calling expand()
    expect(executor.runs).toHaveLength(0);
  });
});

/** Immediately satisfied at `initialState` with no actions — isolates the sign-off gate (R30)
 *  from any step-dispatch machinery. */
const ALREADY_SATISFIED: GoalSpec = {
  goalText: 'already satisfied, needs sign-off',
  initialState: { done: true },
  goalState: { done: true },
  constraints: [],
  completionPolicy: 'verify+signoff',
  actions: [],
};
const SIGNOFF_REMEDIATION = action('remediate-signoff', { done: true }, { remediated: true }, 'verify-remediated');
const SIGNOFF_REMEDIATION_RETRY = action('remediate-signoff-retry', { done: true }, { remediated: true }, 'verify-remediated-retry');

describe('RunSession — gate mechanics (plan Step 8, R22-R31)', () => {
  it('resolves the initial DoD gate via the stand-in resolver (resolveGate) and succeeds', async () => {
    const { session, executor } = buildSession({ goalSpec: TWO_STEP });
    const summaryPromise = session.run({ goalText: TWO_STEP.goalText });
    await waitForGateKind(session, 'dod');
    expect(session.resolveGate(true)).toBe(true);
    const summary = await summaryPromise;
    expect(summary.status).toBe('succeeded');
    expect(executor.runs.map((r) => r.actionId)).toEqual(['s1', 's2']);
  });

  it('resolves the initial DoD gate as declined and cancels the run', async () => {
    const { session } = buildSession({ goalSpec: TWO_STEP });
    const summaryPromise = session.run({ goalText: TWO_STEP.goalText });
    await waitForGateKind(session, 'dod');
    expect(session.resolveGate(false)).toBe(true);
    const summary = await summaryPromise;
    expect(summary.status).toBe('cancelled');
  });

  it('abort-race: cancel() while a gate is open resolves it as declined (R25)', async () => {
    const { session, executor } = buildSession({ goalSpec: TWO_STEP });
    const summaryPromise = session.run({ goalText: TWO_STEP.goalText });
    await waitForGateKind(session, 'dod');
    session.cancel(); // fires the AbortSignal the gate is racing against
    const summary = await summaryPromise;
    expect(summary.status).toBe('cancelled');
    expect(executor.runs).toHaveLength(0); // never reached dispatch
  });

  it('pause() blocks the first dispatch until resume() is called', async () => {
    const { session, executor } = buildSession({ goalSpec: TWO_STEP });
    session.pause(); // paused before the loop even starts
    const summaryPromise = session.run({ goalText: TWO_STEP.goalText });
    await waitForGateKind(session, 'dod');
    session.resolveGate(true); // clears the DoD gate; the pause check is the very next thing in the loop
    await new Promise((r) => setTimeout(r, 10)); // let pending microtasks/timers settle
    expect(executor.runs).toHaveLength(0); // still blocked by pause — no dispatch yet
    session.resume();
    const summary = await summaryPromise;
    expect(summary.status).toBe('succeeded');
    expect(executor.runs).toHaveLength(2);
  });

  it('sign-off gate (R30): accepting after goalState is satisfied succeeds and persists the terminal status', async () => {
    const persistence = fakePersistence();
    const { session } = buildSession({ goalSpec: ALREADY_SATISFIED, persistence });
    const summaryPromise = session.run({ goalText: ALREADY_SATISFIED.goalText });
    await waitForGateKind(session, 'dod'); // initial DoD confirm fires unconditionally first
    session.resolveGate(true);
    await waitForGateKind(session, 'accept');
    expect(session.resolveGate('accept')).toBe(true);
    const summary = await summaryPromise;
    expect(summary.status).toBe('succeeded');
    expect(summary.reason).toMatch(/signed off/);
    expect(persistence.runStatuses.get(session.runId)).toBe('succeeded');
  });

  it('sign-off gate (R30): rejecting after goalState is satisfied continues through re-extraction', async () => {
    const persistence = fakePersistence();
    const { session, extractor, executor, events } = buildSession({ goalSpec: ALREADY_SATISFIED, expansions: [[SIGNOFF_REMEDIATION]], persistence });
    const summaryPromise = session.run({ goalText: ALREADY_SATISFIED.goalText });
    await waitForGateKind(session, 'dod');
    session.resolveGate(true);
    await waitForGateKind(session, 'accept');
    expect(session.resolveGate('reject')).toBe(true);
    await waitForGateKind(session, 'reconfirm');
    expect(persistence.runStatuses.get(session.runId)).toBe('running');
    expect(session.resolveGate(true)).toBe(true);
    await waitForGateKind(session, 'accept');
    expect(executor.runs.map((r) => r.actionId)).toEqual(['remediate-signoff']);
    expect(session.resolveGate('accept')).toBe(true);
    const summary = await summaryPromise;
    expect(summary.status).toBe('succeeded');
    expect(summary.reason).toMatch(/signed off/);
    expect(extractor.expandCalls).toBe(1);
    expect(events.some((e) => e.ev === 'signoff.rejected')).toBe(true);
    expect(persistence.runStatuses.get(session.runId)).toBe('succeeded');
  });

  it('sign-off gate (R30): aborting while awaiting sign-off cancels without remediation', async () => {
    const persistence = fakePersistence();
    const { session, extractor, events } = buildSession({ goalSpec: ALREADY_SATISFIED, expansions: [[SIGNOFF_REMEDIATION]], persistence });
    const summaryPromise = session.run({ goalText: ALREADY_SATISFIED.goalText });
    await waitForGateKind(session, 'dod');
    session.resolveGate(true);
    await waitForGateKind(session, 'accept');
    session.cancel();
    const summary = await summaryPromise;
    expect(summary.status).toBe('cancelled');
    expect(summary.reason).toMatch(/aborted during sign-off/);
    expect(extractor.expandCalls).toBe(0);
    expect(events.some((e) => e.ev === 'signoff.rejected')).toBe(false);
    expect(persistence.runStatuses.get(session.runId)).toBe('cancelled');
  });

  it('sign-off gate (R30): failed remediation re-enters remediation instead of reopening sign-off', async () => {
    const persistence = fakePersistence();
    const { session, extractor, executor } = buildSession({
      goalSpec: ALREADY_SATISFIED,
      expansions: [[SIGNOFF_REMEDIATION], [SIGNOFF_REMEDIATION_RETRY]],
      verifier: {
        byCommand: {
          'verify-remediated': [
            { exitCode: 1, stdout: '', stderr: 'still not accepted' },
            { exitCode: 1, stdout: '', stderr: 'still not accepted' },
            { exitCode: 1, stdout: '', stderr: 'still not accepted' },
          ],
        },
      },
      persistence,
    });
    const summaryPromise = session.run({ goalText: ALREADY_SATISFIED.goalText });
    await waitForGateKind(session, 'dod');
    session.resolveGate(true);
    await waitForGateKind(session, 'accept');
    session.resolveGate('reject');
    await waitForGateKind(session, 'reconfirm');
    session.resolveGate(true);
    await waitForGateKindAndRunCount(session, 'reconfirm', 3, executor);
    expect(executor.runs.map((r) => r.actionId)).toEqual(['remediate-signoff', 'remediate-signoff', 'remediate-signoff']);
    expect(session.resolveGate(true)).toBe(true);
    await waitForGateKindAndRunCount(session, 'accept', 4, executor);
    expect(executor.runs.map((r) => r.actionId)).toEqual(['remediate-signoff', 'remediate-signoff', 'remediate-signoff', 'remediate-signoff-retry']);
    expect(extractor.expandCalls).toBe(2);
    expect(session.resolveGate('accept')).toBe(true);
    const summary = await summaryPromise;
    expect(summary.status).toBe('succeeded');
    expect(persistence.runStatuses.get(session.runId)).toBe('succeeded');
  });

  it('R31: the awaiting-acceptance status/event write lands synchronously BEFORE the gate awaits', async () => {
    const persistence = fakePersistence();
    const { session } = buildSession({ goalSpec: ALREADY_SATISFIED, persistence });
    const summaryPromise = session.run({ goalText: ALREADY_SATISFIED.goalText });
    await waitForGateKind(session, 'dod');
    session.resolveGate(true);
    await waitForGateKind(session, 'accept');
    // The gate is still OPEN (unresolved) at this point — assert the write already landed.
    expect(persistence.runStatuses.get(session.runId)).toBe('awaiting-acceptance');
    expect(persistence.runEvents.some((e) => e.runId === session.runId && e.type === 'AwaitingAcceptance')).toBe(true);
    const event = persistence.runEvents.find((e) => e.runId === session.runId && e.type === 'AwaitingAcceptance');
    expect(event?.payload.goalState).toEqual(ALREADY_SATISFIED.goalState);
    session.resolveGate('accept');
    await summaryPromise;
  });
});
