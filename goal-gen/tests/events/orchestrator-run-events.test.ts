/**
 * RR6–RR10 end to end through the orchestrator: with a `RunEventEmitter` injected as `events`,
 * a full stubbed run must produce one valid run-event/v1 envelope per emit, a contiguous
 * sequence from 0, the emitter's runId everywhere (including persisted rows), and the
 * `AwaitingAcceptance` durable write recording the exact sequence its streamed envelope was
 * minted with (RR9). Deterministic, zero spend.
 */
import { describe, expect, it, vi } from 'vitest';
import { RunEventSchema, type RunEvent } from '../../backend/src/contracts/run-event';
import { RunEventEmitter } from '../../backend/src/events/run-event-emitter';
import { StubExecutor, StubVerifier } from '../../backend/src/executors/stub-executor';
import { StubExtractor } from '../../backend/src/extractors/stub-extractor';
import { RUN_WALL_CLOCK_MS, defaultRunConfig } from '../../backend/src/orchestrator/guardrails';
import { Orchestrator } from '../../backend/src/orchestrator/orchestrator';
import type { OrchestratorDeps, PersistenceProvider, WorktreeProvider } from '../../backend/src/orchestrator/orchestrator';
import { RunSession } from '../../backend/src/orchestrator/run-session';
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

function build(policy: GoalSpec['completionPolicy'], persistence?: PersistenceProvider, onEnvelope?: (event: RunEvent) => void) {
  const envelopes: RunEvent[] = [];
  const emitter = new RunEventEmitter({
    sink: (event) => {
      envelopes.push(event);
      onEnvelope?.(event);
    },
  });
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
    let statusWhenAwaitingAcceptanceStreamed: string | undefined;
    const { orch, envelopes } = build('verify+signoff', persistence, (event) => {
      if (event.type === 'AwaitingAcceptance') {
        statusWhenAwaitingAcceptanceStreamed = persistence.statuses.at(-1);
      }
    });
    const summary = await orch.run({ goalText: 'one step' });
    expect(summary.status).toBe('succeeded');

    const streamed = envelopes.filter((e) => e.type === 'AwaitingAcceptance');
    expect(streamed).toHaveLength(1);
    const persisted = persistence.runEvents.filter((row) => row.type === 'AwaitingAcceptance');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.sequence).toBe(streamed[0]!.sequence);
    expect(persistence.statuses).toContain('awaiting-acceptance');
    expect(statusWhenAwaitingAcceptanceStreamed).toBe('awaiting-acceptance');
  });

  it('arms the acceptance gate before publishing AwaitingAcceptance', async () => {
    const envelopes: RunEvent[] = [];
    let acceptedFromSink: boolean | undefined;
    let session!: RunSession;
    const emitter = new RunEventEmitter({
      sink: (event) => {
        envelopes.push(event);
        if (event.type === 'AwaitingAcceptance') acceptedFromSink = session.resolveGate('accept');
      },
    });
    session = new RunSession({
      extractor: new StubExtractor({ goalSpec: goalSpec('verify+signoff') }),
      executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0 } }),
      verifier: new StubVerifier({}),
      config: defaultRunConfig(),
      worktreeProvider: stubWorktree,
      events: emitter,
    });

    const pending = session.run({ goalText: 'one step' });
    await vi.waitFor(() => expect(session.pendingGateKind()).toBe('dod'));
    expect(session.resolveGate(true)).toBe(true);
    expect((await pending).status).toBe('succeeded');
    expect(acceptedFromSink).toBe(true);
    expect(envelopes.some((event) => event.type === 'AwaitingAcceptance')).toBe(true);
  });

  it('still publishes AwaitingAcceptance when the status write fails', async () => {
    const persistence = capturePersistence();
    persistence.updateRunStatus = async (_runId, status) => {
      if (status === 'awaiting-acceptance') throw new Error('database unavailable');
      persistence.statuses.push(status);
    };
    const { orch, envelopes } = build('verify+signoff', persistence);

    expect((await orch.run({ goalText: 'one step' })).status).toBe('succeeded');
    expect(envelopes.some((event) => event.type === 'persistence.error')).toBe(true);
    expect(envelopes.some((event) => event.type === 'AwaitingAcceptance')).toBe(true);
    expect(persistence.runEvents.some((event) => event.type === 'AwaitingAcceptance')).toBe(true);
  });
});

describe('single-run event ownership (RR7)', () => {
  it('derives a RunSession id from its injected emitter and completes under that identity', async () => {
    const envelopes: RunEvent[] = [];
    const emitter = new RunEventEmitter({ runId: 'session-event-owner', sink: (event) => envelopes.push(event) });
    const session = new RunSession({
      extractor: new StubExtractor({ goalSpec: goalSpec('verify-only') }),
      executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0 } }),
      verifier: new StubVerifier({}),
      config: defaultRunConfig(),
      worktreeProvider: stubWorktree,
      events: emitter,
    });

    expect(session.runId).toBe(emitter.runId);
    const pending = session.run({ goalText: 'one step' });
    await vi.waitFor(() => expect(session.pendingGateKind()).toBe('dod'));
    expect(session.resolveGate(true)).toBe(true);
    expect((await pending).status).toBe('succeeded');
    expect(new Set(envelopes.map((event) => event.runId))).toEqual(new Set([emitter.runId]));
    expect(envelopes.at(-1)?.type).toBe('run.summary');
  });

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

describe('sign-off gate that cannot decide (closed stdin) — work is preserved', () => {
  it('ends the run as failed with the real RunState instead of escaping run()', async () => {
    const envelopes: RunEvent[] = [];
    const emitter = new RunEventEmitter({ sink: (event) => envelopes.push(event) });
    const orch = new Orchestrator({
      extractor: new StubExtractor({ goalSpec: goalSpec('verify+signoff') }),
      executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0.25 } }),
      verifier: new StubVerifier({}),
      config: defaultRunConfig(),
      confirm: async () => true,
      acceptanceGate: async () => {
        throw new Error('stdin closed while awaiting sign-off');
      },
      worktreeProvider: stubWorktree,
      events: emitter,
    });
    const summary = await orch.run({ goalText: 'preserve my work' });
    expect(summary.status).toBe('failed');
    expect(summary.reason).toContain('sign-off gate failed');
    expect(summary.reason).toContain('stdin closed');
    // The completed step and its spend survive into the terminal summary.
    expect(summary.actions.length).toBeGreaterThan(0);
    expect(summary.costUsd).toBeGreaterThan(0);
    expect(envelopes.some((e) => e.type === 'signoff.failed')).toBe(true);
    const last = envelopes[envelopes.length - 1]!;
    expect(last.type).toBe('run.summary');
    expect(last.payload).toMatchObject({ status: 'failed' });
    expect(envelopes.every((e) => RunEventSchema.safeParse(e).success)).toBe(true);
  });
});

describe('sign-off gate rejecting while the durable AwaitingAcceptance write is in flight', () => {
  it('is settled immediately — no unhandled rejection — and still ends failed with work preserved', async () => {
    const persistence = capturePersistence();
    // Defer the durable event write so the gate's rejection lands BEFORE publishAwaitingAcceptance
    // resolves — the window in which a bare pending promise would be an unhandled rejection.
    const slowPersistence: PersistenceProvider = {
      ...persistence,
      insertRunEvent: async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await persistence.insertRunEvent(event);
      },
    };
    const envelopes: RunEvent[] = [];
    const emitter = new RunEventEmitter({ sink: (event) => envelopes.push(event) });
    const orch = new Orchestrator({
      extractor: new StubExtractor({ goalSpec: goalSpec('verify+signoff') }),
      executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0.5 } }),
      verifier: new StubVerifier({}),
      config: defaultRunConfig(),
      confirm: async () => true,
      acceptanceGate: () => Promise.reject(new Error('stdin closed while awaiting sign-off')),
      worktreeProvider: stubWorktree,
      events: emitter,
      persistence: slowPersistence,
    });
    const summary = await orch.run({ goalText: 'reject during publish' });
    expect(summary.status).toBe('failed');
    expect(summary.reason).toContain('sign-off gate failed');
    expect(summary.actions.length).toBeGreaterThan(0);
    expect(envelopes.some((e) => e.type === 'signoff.failed')).toBe(true);
    expect(envelopes[envelopes.length - 1]?.type).toBe('run.summary');
    // The durable AwaitingAcceptance write still completed before the failure was recorded.
    expect(persistence.statuses).toContain('awaiting-acceptance');
  });
});

describe('sign-off gate that throws synchronously', () => {
  it('is treated like a rejection: failed summary, work preserved, no escape from run()', async () => {
    const envelopes: RunEvent[] = [];
    const emitter = new RunEventEmitter({ sink: (event) => envelopes.push(event) });
    const throwingGate = (() => {
      throw new Error('gate exploded before returning a promise');
    }) as unknown as OrchestratorDeps['acceptanceGate'];
    const orch = new Orchestrator({
      extractor: new StubExtractor({ goalSpec: goalSpec('verify+signoff') }),
      executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0.5 } }),
      verifier: new StubVerifier({}),
      config: defaultRunConfig(),
      confirm: async () => true,
      acceptanceGate: throwingGate,
      worktreeProvider: stubWorktree,
      events: emitter,
    });
    const summary = await orch.run({ goalText: 'sync throw' });
    expect(summary.status).toBe('failed');
    expect(summary.reason).toContain('gate exploded');
    expect(summary.actions.length).toBeGreaterThan(0);
    expect(envelopes[envelopes.length - 1]?.type).toBe('run.summary');
  });
});

describe('RunSession arms the run-wide wall-clock (CLAUDE.md invariant #6)', () => {
  it('cancels a run parked at an unresolved gate once RUN_WALL_CLOCK_MS elapses', async () => {
    vi.useFakeTimers();
    try {
      const envelopes: RunEvent[] = [];
      const emitter = new RunEventEmitter({ sink: (event) => envelopes.push(event) });
      const session = new RunSession({
        extractor: new StubExtractor({ goalSpec: goalSpec('verify-only') }),
        executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0 } }),
        verifier: new StubVerifier({}),
        config: defaultRunConfig(),
        worktreeProvider: stubWorktree,
        events: emitter,
      });
      const running = session.run({ goalText: 'nobody resolves the DoD gate' });
      // Let extraction settle and the DoD gate open, then sit just under the deadline: still parked.
      await vi.advanceTimersByTimeAsync(RUN_WALL_CLOCK_MS - 1);
      expect(session.pendingGateKind()).toBe('dod');
      await vi.advanceTimersByTimeAsync(1);
      const summary = await running;
      expect(summary.status).toBe('cancelled');
      expect(envelopes[envelopes.length - 1]?.type).toBe('run.summary');
      // Nothing left ticking once the run has settled.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the deadline when the run finishes before it', async () => {
    vi.useFakeTimers();
    try {
      const session = new RunSession({
        extractor: new StubExtractor({ goalSpec: goalSpec('verify-only') }),
        executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0 } }),
        verifier: new StubVerifier({}),
        config: defaultRunConfig(),
        worktreeProvider: stubWorktree,
        events: new RunEventEmitter({ sink: () => {} }),
      });
      const running = session.run({ goalText: 'resolved promptly' });
      await vi.advanceTimersByTimeAsync(0);
      expect(session.resolveGate(true)).toBe(true);
      const summary = await running;
      expect(summary.status).toBe('succeeded');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
