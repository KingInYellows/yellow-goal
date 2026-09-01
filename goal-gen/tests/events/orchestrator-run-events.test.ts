/**
 * RR6–RR10 end to end through the orchestrator: with a `RunEventEmitter` injected as `events`,
 * a full stubbed run must produce one valid run-event/v1 envelope per emit, a contiguous
 * sequence from 0, the emitter's runId everywhere (including persisted rows), and the
 * `AwaitingAcceptance` durable write recording the exact sequence its streamed envelope was
 * minted with (RR9). Deterministic, zero spend.
 */
import { describe, expect, it } from 'vitest';
import { RunEventSchema, type RunEvent } from '../../backend/src/contracts/run-event';
import { RunEventEmitter } from '../../backend/src/events/run-event-emitter';
import { StubExecutor, StubVerifier } from '../../backend/src/executors/stub-executor';
import { StubExtractor } from '../../backend/src/extractors/stub-extractor';
import { defaultRunConfig } from '../../backend/src/orchestrator/guardrails';
import { Orchestrator } from '../../backend/src/orchestrator/orchestrator';
import type { OrchestratorDeps, PersistenceProvider, WorktreeProvider } from '../../backend/src/orchestrator/orchestrator';
import type { Action, GoalSpec, WorldState } from '../../backend/src/planner/types';

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

function goalSpec(completionPolicy: GoalSpec['completionPolicy']): GoalSpec {
  return {
    goalText: 'one step',
    initialState: { done: false },
    goalState: { done: true },
    constraints: [],
    completionPolicy,
    actions: [action('a1', { done: false }, { done: true }, 'verify-done')],
  };
}

interface CapturedRunEventRow {
  runId: string;
  planId: string;
  stepId?: string;
  type: string;
  payload: Record<string, unknown>;
  sequence: number;
}

function capturePersistence(): PersistenceProvider & { runEvents: CapturedRunEventRow[]; statuses: string[] } {
  const runEvents: CapturedRunEventRow[] = [];
  const statuses: string[] = [];
  return {
    runEvents,
    statuses,
    upsertGoalSpec: async () => {},
    upsertPlan: async () => {},
    insertRun: async () => {},
    insertAgentRun: async () => {},
    updateRunStatus: async (_runId, status) => {
      statuses.push(status);
    },
    insertRunEvent: async (event) => {
      runEvents.push(event);
    },
  };
}

function build(policy: GoalSpec['completionPolicy'], persistence?: PersistenceProvider) {
  const envelopes: RunEvent[] = [];
  const emitter = new RunEventEmitter({ sink: (e) => envelopes.push(e) });
  const orch = new Orchestrator({
    extractor: new StubExtractor({ goalSpec: goalSpec(policy) }),
    executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0 } }),
    verifier: new StubVerifier({}),
    config: defaultRunConfig(),
    confirm: async () => true,
    acceptanceGate: async () => 'accept',
    worktreeProvider: stubWorktree,
    events: emitter,
    ...(persistence ? { persistence } : {}),
  });
  return { orch, emitter, envelopes };
}

describe('orchestrator with a RunEventEmitter (RR6–RR10)', () => {
  it('streams only valid envelopes with a contiguous sequence and one terminal run.summary', async () => {
    const { orch, emitter, envelopes } = build('verify-only');
    const summary = await orch.run({ goalText: 'one step' });
    expect(summary.status).toBe('succeeded');

    expect(envelopes.length).toBeGreaterThan(0);
    for (const envelope of envelopes) {
      const parsed = RunEventSchema.safeParse(envelope);
      expect(parsed.success, JSON.stringify(envelope)).toBe(true);
      expect(envelope.runId).toBe(emitter.runId);
    }
    expect(envelopes.map((e) => e.sequence)).toEqual(envelopes.map((_, i) => i));
    const summaries = envelopes.filter((e) => e.type === 'run.summary');
    expect(summaries).toHaveLength(1);
    expect(envelopes[envelopes.length - 1]).toBe(summaries[0]);
    expect(summaries[0]!.payload).toMatchObject({ status: 'succeeded' });
  });

  it('terminates the stream with run.summary even when extraction fails (RR10)', async () => {
    const envelopes: RunEvent[] = [];
    const emitter = new RunEventEmitter({ sink: (e) => envelopes.push(e) });
    const throwingExtractor: OrchestratorDeps['extractor'] = {
      extract: async () => {
        throw new Error('claude unavailable');
      },
      expand: async () => {
        throw new Error('unused');
      },
    };
    const orch = new Orchestrator({
      extractor: throwingExtractor,
      executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0 } }),
      verifier: new StubVerifier({}),
      config: defaultRunConfig(),
      confirm: async () => true,
      acceptanceGate: async () => 'accept',
      worktreeProvider: stubWorktree,
      events: emitter,
    });
    const summary = await orch.run({ goalText: 'will fail before RunState exists' });
    expect(summary.status).toBe('failed');
    const summaries = envelopes.filter((e) => e.type === 'run.summary');
    expect(summaries).toHaveLength(1);
    expect(envelopes[envelopes.length - 1]).toBe(summaries[0]);
    expect(summaries[0]!.payload).toMatchObject({ status: 'failed' });
    for (const envelope of envelopes) {
      expect(RunEventSchema.safeParse(envelope).success, JSON.stringify(envelope)).toBe(true);
    }
  });

  it('defaults the run id to the emitter runId so stream and persistence agree (RR9)', async () => {
    const persistence = capturePersistence();
    const { orch, emitter } = build('verify+signoff', persistence);
    const summary = await orch.run({ goalText: 'one step' });
    expect(summary.status).toBe('succeeded');
    expect(persistence.runEvents.every((row) => row.runId === emitter.runId)).toBe(true);
  });

  it('persists AwaitingAcceptance with the exact sequence of its streamed envelope (RR9)', async () => {
    const persistence = capturePersistence();
    const { orch, envelopes } = build('verify+signoff', persistence);
    const summary = await orch.run({ goalText: 'one step' });
    expect(summary.status).toBe('succeeded');

    const streamed = envelopes.filter((e) => e.type === 'AwaitingAcceptance');
    expect(streamed).toHaveLength(1);
    const persisted = persistence.runEvents.filter((row) => row.type === 'AwaitingAcceptance');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.sequence).toBe(streamed[0]!.sequence);
    expect(persistence.statuses).toContain('awaiting-acceptance');
  });
});

describe('single-run event ownership (RR7)', () => {
  it('fails a concurrent call on a separate emitter without changing the active run owner', async () => {
    const envelopes: RunEvent[] = [];
    const emitter = new RunEventEmitter({ sink: (e) => envelopes.push(e) });
    const baseExtractor = new StubExtractor({ goalSpec: goalSpec('verify-only') });
    let markExtractStarted: (() => void) | undefined;
    let releaseExtract: (() => void) | undefined;
    const extractStarted = new Promise<void>((resolve) => {
      markExtractStarted = resolve;
    });
    const extractGate = new Promise<void>((resolve) => {
      releaseExtract = resolve;
    });
    const extractor: OrchestratorDeps['extractor'] = {
      extract: async (req) => {
        markExtractStarted?.();
        await extractGate;
        return baseExtractor.extract(req);
      },
      expand: (evidence, current, pool, signal) => baseExtractor.expand(evidence, current, pool, signal),
    };
    const orch = new Orchestrator({
      extractor,
      executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0 } }),
      verifier: new StubVerifier({}),
      config: defaultRunConfig(),
      confirm: async () => true,
      worktreeProvider: stubWorktree,
      events: emitter,
    });

    const activeRun = orch.run({ goalText: 'first run' });
    await extractStarted;
    const rejected = await orch.run({ goalText: 'overlapping run' });
    expect(rejected).toMatchObject({ status: 'failed', reason: expect.stringContaining('may run only once') });

    const rejectedRunId = envelopes[0]?.runId;
    expect(rejectedRunId).toBeDefined();
    expect(rejectedRunId).not.toBe(emitter.runId);
    expect(envelopes).toMatchObject([
      { runId: rejectedRunId, sequence: 0, type: 'error', payload: { code: 'RUN_EVENT_OWNER_CONFLICT' } },
      { runId: rejectedRunId, sequence: 1, type: 'run.summary', payload: { status: 'failed' } },
    ]);

    releaseExtract?.();
    expect((await activeRun).status).toBe('succeeded');
    const activeEnvelopes = envelopes.filter((event) => event.runId === emitter.runId);
    expect(activeEnvelopes.length).toBeGreaterThan(0);
    expect(activeEnvelopes.map((event) => event.sequence)).toEqual(activeEnvelopes.map((_, index) => index));
    expect(activeEnvelopes.at(-1)?.type).toBe('run.summary');
  });

  it('fails an explicit runId mismatch before calling the extractor', async () => {
    const envelopes: RunEvent[] = [];
    const emitter = new RunEventEmitter({ sink: (e) => envelopes.push(e) });
    const baseExtractor = new StubExtractor({ goalSpec: goalSpec('verify-only') });
    let extractCalls = 0;
    const extractor: OrchestratorDeps['extractor'] = {
      extract: (req) => {
        extractCalls++;
        return baseExtractor.extract(req);
      },
      expand: (evidence, current, pool, signal) => baseExtractor.expand(evidence, current, pool, signal),
    };
    const orch = new Orchestrator({
      extractor,
      executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0 } }),
      verifier: new StubVerifier({}),
      config: defaultRunConfig(),
      confirm: async () => true,
      worktreeProvider: stubWorktree,
      events: emitter,
    });

    const summary = await orch.run({ goalText: 'one step' }, 'explicit-run-id');
    expect(summary).toMatchObject({ status: 'failed', reason: expect.stringContaining('does not match') });
    expect(extractCalls).toBe(0);
    expect(new Set(envelopes.map((e) => e.runId))).toEqual(new Set(['explicit-run-id']));
    expect(envelopes.map((event) => event.sequence)).toEqual([0, 1]);
    expect(envelopes.map((event) => event.type)).toEqual(['error', 'run.summary']);
  });
});
