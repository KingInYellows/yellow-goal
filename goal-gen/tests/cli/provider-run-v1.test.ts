import * as protocolWriter from '../../backend/src/events/protocol-stdout-writer';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../backend/src/cli/index';
import { FirstCauseRecorder, runProviderV1, type ProviderEngineDeps } from '../../backend/src/cli/provider-run-v1';
import { requestToRunInputs } from '../../backend/src/run/request-to-run';
import type { RepositoryGoalRequest } from '../../backend/src/contracts/request';
import { StubExecutor, StubVerifier } from '../../backend/src/executors/stub-executor';
import { StubExtractor } from '../../backend/src/extractors/stub-extractor';
import type { Action, GoalSpec } from '../../backend/src/planner/types';
import { requestExecutionSample } from '../contracts/support/samples';

let dir: string;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'provider-v1-'));
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: unknown, cb?: unknown) => { if (typeof cb === 'function') (cb as () => void)(); return true; }) as typeof process.stdout.write);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); stdout.mockRestore(); stderr.mockRestore(); await rm(dir, { recursive: true, force: true }); });
async function request(autoConfirmDod = true): Promise<string> {
  const file = path.join(dir, 'request.json');
  await writeFile(file, JSON.stringify({ ...requestExecutionSample, orchestration: { ...requestExecutionSample.orchestration, execution: { ...requestExecutionSample.orchestration.execution, autoConfirmDod } } }));
  return file;
}
const lines = (): Array<Record<string, unknown>> => stdout.mock.calls.map((call: unknown[]) => String(call[0])).join('').split('\n').filter(Boolean).map(JSON.parse);
const error = (): Record<string, unknown> => JSON.parse(stderr.mock.calls.map((call: unknown[]) => String(call[0])).join(''));

const fixtureWorktree: ProviderEngineDeps['worktreeProvider'] = async (opts) => ({
  root: '(fixture)', worktreePath: '(fixture)', branch: opts.branch ?? 'run', initialSha: '0'.repeat(40), cleanup: async () => {},
});

function fixtureEngine(goalSpec: GoalSpec, expansions: Action[][] = []): { deps: ProviderEngineDeps; extractor: StubExtractor; executor: StubExecutor; verifier: StubVerifier } {
  const extractor = new StubExtractor({ goalSpec, expansions });
  const executor = new StubExecutor({ default: { status: 'succeeded', costUsd: 0 } });
  const verifier = new StubVerifier();
  return { deps: { extractor, executor, verifier, worktreeProvider: fixtureWorktree }, extractor, executor, verifier };
}

function expectSingleGateTerminal(events: Array<Record<string, unknown>>, expectedKind: 'acceptance' | 'reconfirm'): Record<string, unknown> {
  const terminals = events.filter((event) => event.type === 'run.summary');
  expect(terminals).toHaveLength(1);
  expect(events.at(-1)).toBe(terminals[0]);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index));
  const gate = events.filter((event) => event.type === 'gate.required');
  expect(gate).toHaveLength(1);
  expect(gate[0]).toMatchObject({ payload: { kind: expectedKind } });
  expect(terminals[0]).toMatchObject({ payload: { status: 'cancelled', terminationReason: 'gate-required' } });
  return terminals[0]!;
}

describe('provider v1 stub run', () => {
  it.each([
    ['signal', 'timeout'], ['timeout', 'signal'], ['signal', 'gate-required'],
    ['gate-required', 'signal'], ['timeout', 'gate-required'], ['gate-required', 'timeout'],
  ] as const)('keeps the first ordered cancellation cause (%s then %s)', (first, second) => {
    const causes = new FirstCauseRecorder();
    expect(causes.record(first)).toBe(true);
    expect(causes.record(second)).toBe(false);
    expect(causes.current()).toBe(first);
    causes.freeze();
    expect(causes.record(second)).toBe(false);
  });
  it('streams one ordered success terminal with protocol start fields', async () => {
    const file = await request();
    expect(await main(['run', file, '--executor', 'stub', '--protocol', 'v1'])).toBe(0);
    const events = lines();
    expect(events[0]).toMatchObject({ type: 'run.start', payload: { protocolVersion: 'yellow-goal/provider-protocol/v1', stubScenario: 'success', simulation: true, executor: 'stub' } });
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index));
    expect(events.at(-1)).toMatchObject({ type: 'run.summary', payload: { status: 'succeeded' } });
    expect(stderr).not.toHaveBeenCalled();
  });
  it('maps deterministic failure and budget results to structured stderr', async () => {
    const file = await request();
    expect(await main(['run', file, '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', 'failed'])).toBe(1);
    expect(error()).toMatchObject({ error: { code: 'RUN_FAILED' } });
    stdout.mockClear(); stderr.mockClear();
    expect(await main(['run', file, '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', 'budget-exhausted', '--yes'])).toBe(1);
    expect(error()).toMatchObject({ error: { code: 'RUN_BUDGET_EXHAUSTED' } });
  });
  it('declines a missing DoD input without a prompt', async () => {
    const file = await request(false);
    expect(await main(['run', file, '--executor', 'stub', '--protocol', 'v1'])).toBe(1);
    expect(lines().some((event) => event.type === 'gate.required')).toBe(true);
    expect(lines().at(-1)).toMatchObject({ payload: { status: 'cancelled', terminationReason: 'gate-required' } });
    expect(error()).toMatchObject({ error: { code: 'RUN_GATE_REQUIRED' } });
  });
  it('cancels at noninteractive acceptance before rejection remediation can begin', async () => {
    const canonical = requestExecutionSample as RepositoryGoalRequest;
    const inputs = requestToRunInputs(canonical);
    const remediation: Action = {
      id: 'remediate', name: 'remediate', cost: 1, preconditions: { done: true }, effects: { remediated: true },
      executor: 'claude-code', payload: {}, verify: { command: 'remediate' },
    };
    const signoff: GoalSpec = {
      goalText: inputs.goalText, initialState: { done: false }, goalState: { done: true }, constraints: [], completionPolicy: 'verify+signoff',
      actions: [{
        id: 'initial', name: 'initial', cost: 1, preconditions: { done: false }, effects: { done: true },
        executor: 'claude-code', payload: {}, verify: { command: 'initial' },
      }],
    };
    const fixture = fixtureEngine(signoff, [[remediation]]);
    const beforeSigint = process.listenerCount('SIGINT');
    const beforeSigterm = process.listenerCount('SIGTERM');
    const code = await runProviderV1(
      inputs,
      canonical,
      { mode: 'provider-v1', requestPath: 'unused', executor: 'stub', yes: true, allowGuardrailOverride: false, timeoutMs: 1_000, timeoutExplicit: true, scenario: 'success' },
      { engineFactory: () => fixture.deps },
    );
    const events = lines();
    const terminal = expectSingleGateTerminal(events, 'acceptance');
    const gateIndex = events.findIndex((event) => event.type === 'gate.required');
    const awaitingIndex = events.findIndex((event) => event.type === 'AwaitingAcceptance');
    expect(awaitingIndex).toBeGreaterThan(gateIndex);
    expect(events.findIndex((event) => event.type === 'step.pass')).toBeLessThan(gateIndex);
    expect(events.some((event) => ['signoff.rejected', 'signoff.failed', 'reextract', 'dod.reconfirmed'].includes(String(event.type)))).toBe(false);
    expect(fixture.executor.runs.map((run) => run.actionId)).toEqual(['initial']);
    expect(fixture.verifier.calls.map((call) => call.command)).toEqual(['initial']);
    expect(fixture.extractor.expandCalls).toBe(0);
    expect(code).toBe(1);
    const reason = (terminal.payload as { reason: string }).reason;
    expect(error()).toEqual({ error: { code: 'RUN_GATE_REQUIRED', message: reason } });
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
  });
  it('runs an initially accepted action but cancels before an unconfirmed replan action', async () => {
    const canonical = requestExecutionSample as RepositoryGoalRequest;
    const baseInputs = requestToRunInputs(canonical);
    const inputs = { ...baseInputs, autoConfirm: false };
    const reconfirm: GoalSpec = {
      goalText: inputs.goalText,
      initialState: { fresh: true, g1: false, g2: false },
      goalState: { g1: true, g2: true },
      constraints: [], completionPolicy: 'verify-only',
      actions: [
        { id: 's1', name: 's1', cost: 1, preconditions: { fresh: true }, effects: { g1: true, g2: true, fresh: false }, executor: 'claude-code', payload: {}, verify: { command: 'v1', successPredicate: { g1: true, fresh: false } } },
        { id: 's2', name: 's2', cost: 1, preconditions: {}, effects: { g2: true }, executor: 'claude-code', payload: {}, verify: { command: 'v2' } },
      ],
    };
    const fixture = fixtureEngine(reconfirm);
    const beforeSigint = process.listenerCount('SIGINT');
    const beforeSigterm = process.listenerCount('SIGTERM');
    const code = await runProviderV1(
      inputs,
      canonical,
      { mode: 'provider-v1', requestPath: 'unused', executor: 'stub', yes: false, allowGuardrailOverride: false, timeoutMs: 1_000, timeoutExplicit: true, scenario: 'success' },
      {
        engineFactory: () => fixture.deps,
        confirmFactory: (protocolConfirm) => async (dod, signal, kind) => kind === 'dod' ? true : protocolConfirm(dod, signal, kind),
      },
    );
    const events = lines();
    const terminal = expectSingleGateTerminal(events, 'reconfirm');
    expect(fixture.executor.runs.map((run) => run.actionId)).toEqual(['s1']);
    expect(fixture.verifier.calls.map((call) => call.command)).toEqual(['v1']);
    expect(events.some((event) => event.type === 'dod.reconfirmed')).toBe(false);
    expect(code).toBe(1);
    const reason = (terminal.payload as { reason: string }).reason;
    expect(error()).toEqual({ error: { code: 'RUN_GATE_REQUIRED', message: reason } });
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
  });
  it('keeps a success terminal frozen when SIGTERM is emitted during its writer call', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const signals = new EventEmitter();
    const canonical = requestExecutionSample as RepositoryGoalRequest;
    const inputs = requestToRunInputs(canonical);
    const code = await runProviderV1(
      inputs,
      canonical,
      { mode: 'provider-v1', requestPath: 'unused', executor: 'stub', yes: false, allowGuardrailOverride: false, timeoutMs: 1_000, timeoutExplicit: true, scenario: 'success' },
      {
        signals,
        writerFactory: () => ({
          write: (event) => { seen.push(event as Record<string, unknown>); if ((event as { type?: string }).type === 'run.summary') signals.emit('SIGTERM'); },
          get failure() { return undefined; },
          finalize: async () => 'flushed',
        }),
      },
    );
    expect(code).toBe(0);
    expect(seen.at(-1)).toMatchObject({ type: 'run.summary', payload: { status: 'succeeded' } });
  });
  it('maps await-cancel timeout to its distinct terminal reason and stderr code', async () => {
    const file = await request();
    expect(await main(['run', file, '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', 'await-cancel', '--timeout-ms', '1'])).toBe(1);
    expect(lines().at(-1)).toMatchObject({ payload: { status: 'cancelled', terminationReason: 'timeout' } });
    expect(error()).toMatchObject({ error: { code: 'RUN_TIMEOUT' } });
  });
});

describe('provider lifecycle failure and race contract', () => {
  const canonical = requestExecutionSample as RepositoryGoalRequest;
  const inputs = requestToRunInputs(canonical);
  const invocation = {
    mode: 'provider-v1', requestPath: 'unused', executor: 'stub', yes: true,
    allowGuardrailOverride: false, timeoutMs: 1000, timeoutExplicit: true, scenario: 'success',
  } as const;
  function recording(onEvent?: (event: Record<string, unknown>) => void) {
    const events: Array<Record<string, unknown>> = [];
    const finalize = vi.fn(async () => 'flushed' as const);
    const writer = {
      write(event: unknown) { events.push(event as Record<string, unknown>); onEvent?.(event as Record<string, unknown>); },
      failure: undefined, finalize,
    };
    return { events, finalize, writer };
  }
  function terminalAgreement(events: Array<Record<string, unknown>>, status: string, code: string, cause?: string) {
    expect(events[0]).toMatchObject({ type: 'run.start', sequence: 0 });
    expect(events.map(e => e.sequence)).toEqual(events.map((_e, i) => i));
    expect(events.filter(e => e.type === 'run.summary')).toHaveLength(1);
    const summary = events.at(-1)?.payload as Record<string, unknown>;
    expect(events.at(-1)?.type).toBe('run.summary');
    expect(summary.status).toBe(status);
    if (cause === undefined) expect(summary).not.toHaveProperty('terminationReason');
    else expect(summary.terminationReason).toBe(cause);
    expect(error()).toEqual({ error: { code, message: summary.reason } });
    expect(stderr).toHaveBeenCalledTimes(1);
  }
  it('freezes an empty cause recorder against every later cause', () => {
    const causes = new FirstCauseRecorder();
    causes.freeze();
    for (const cause of ['signal', 'timeout', 'gate-required'] as const) expect(causes.record(cause)).toBe(false);
    expect(causes.current()).toBeUndefined();
  });
  it.each(['signal', 'timeout'] as const)('cancels during start for %s without constructing an engine', async cause => {
    vi.useFakeTimers();
    const signals = new EventEmitter();
    const rec = recording(event => {
      if (event.type === 'run.start') {
        if (cause === 'signal') signals.emit('SIGTERM');
        else vi.advanceTimersByTime(1000);
      }
    });
    const engineFactory = vi.fn(() => { throw new Error('must not construct'); });
    expect(await runProviderV1(inputs, canonical, invocation, { signals, engineFactory, writerFactory: () => rec.writer })).toBe(1);
    expect(engineFactory).not.toHaveBeenCalled();
    expect(rec.events).toHaveLength(2);
    terminalAgreement(rec.events, 'cancelled', cause === 'signal' ? 'RUN_CANCELLED' : 'RUN_TIMEOUT', cause);
    expect(rec.finalize).toHaveBeenCalledTimes(1);
    expect(signals.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not extract when cancellation arrives inside engine construction', async () => {
    const signals = new EventEmitter();
    const rec = recording();
    const fixture = fixtureEngine({ goalText: inputs.goalText, initialState: {}, goalState: {}, constraints: [], actions: [], completionPolicy: 'verify-only' });
    const extract = vi.spyOn(fixture.extractor, 'extract');
    expect(await runProviderV1(inputs, canonical, invocation, {
      signals, writerFactory: () => rec.writer,
      engineFactory: () => { signals.emit('SIGINT'); return fixture.deps; },
    })).toBe(1);
    expect(extract).not.toHaveBeenCalled();
    terminalAgreement(rec.events, 'cancelled', 'RUN_CANCELLED', 'signal');
    expect(rec.finalize).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('normalizes an engine throw while preserving an earlier cause (%s)', async cancelled => {
    const signals = new EventEmitter();
    const rec = recording();
    const hostile = { toString() { throw new Error('hostile conversion'); } };
    expect(await runProviderV1(inputs, canonical, invocation, {
      signals, writerFactory: () => rec.writer,
      engineFactory: () => { if (cancelled) signals.emit('SIGTERM'); throw hostile; },
    })).toBe(1);
    terminalAgreement(rec.events, cancelled ? 'cancelled' : 'failed', cancelled ? 'RUN_CANCELLED' : 'RUN_FAILED', cancelled ? 'signal' : undefined);
    expect(rec.finalize).toHaveBeenCalledTimes(1);
    expect(signals.eventNames()).toEqual([]);
  });
  it('cleans partially registered signals and finalizes once on a pre-start setup error', async () => {
    const signals = new EventEmitter();
    const originalOn = signals.on.bind(signals);
    vi.spyOn(signals, 'on').mockImplementation((name, listener) => {
      originalOn(name, listener);
      if (name === 'SIGTERM') throw new Error('registration failed');
      return signals;
    });
    const rec = recording();
    await expect(runProviderV1(inputs, canonical, invocation, { signals, writerFactory: () => rec.writer })).rejects.toThrow('registration failed');
    expect(rec.events).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
    expect(signals.eventNames()).toEqual([]);
    expect(rec.finalize).toHaveBeenCalledTimes(1);
  });
  it('normalizes a writer factory failure before any signal registration or stdout', async () => {
    const signals = new EventEmitter();
    const once = vi.spyOn(signals, 'on');
    await expect(runProviderV1(inputs, canonical, invocation, {
      signals, writerFactory: () => { throw { toString() { throw new Error('hostile'); } }; },
    })).rejects.toThrow('unknown provider protocol failure');
    expect(once).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });
  it.each(['run.start', 'run.summary'])('gives a synchronous writer failure at %s transport precedence', async eventType => {
    const signals = new EventEmitter();
    const rec = recording(event => { if (event.type === eventType) throw new Error('broken output'); });
    expect(await runProviderV1(inputs, canonical, invocation, { signals, writerFactory: () => rec.writer })).toBe(1);
    expect(error()).toEqual({ error: { code: 'RUN_STDOUT_TRANSPORT_FAILED', message: 'broken output' } });
    expect(rec.finalize).toHaveBeenCalledTimes(1);
    expect(signals.eventNames()).toEqual([]);
    expect(rec.events.filter(e => e.type === 'run.summary')).toHaveLength(eventType === 'run.start' ? 0 : 1);
  });
  it('does not retry rejected finalization and reports transport failure after a success terminal', async () => {
    const rec = recording();
    rec.finalize.mockRejectedValue(new Error('finalization failed'));
    expect(await runProviderV1(inputs, canonical, invocation, { signals: new EventEmitter(), writerFactory: () => rec.writer })).toBe(1);
    expect(rec.events.at(-1)).toMatchObject({ payload: { status: 'succeeded' } });
    expect(error()).toEqual({ error: { code: 'RUN_STDOUT_TRANSPORT_FAILED', message: 'finalization failed' } });
    expect(rec.finalize).toHaveBeenCalledTimes(1);
  });
  it.each([['signal', 'timeout'], ['timeout', 'signal']] as const)('keeps %s before %s during an active await-cancel run', async (first, second) => {
    vi.useFakeTimers();
    const signals = new EventEmitter();
    const trigger = (cause: string) => { if (cause === 'signal') signals.emit('SIGTERM'); else vi.advanceTimersByTime(1000); };
    const rec = recording(event => { if (event.type === 'stub.waiting') { trigger(first); trigger(second); } });
    expect(await runProviderV1(inputs, canonical, { ...invocation, scenario: 'await-cancel' }, { signals, writerFactory: () => rec.writer })).toBe(1);
    terminalAgreement(rec.events, 'cancelled', first === 'signal' ? 'RUN_CANCELLED' : 'RUN_TIMEOUT', first);
    expect(rec.finalize).toHaveBeenCalledTimes(1);
    expect(signals.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps a gate cause ahead of signal and timeout arriving during gate output', async () => {
    vi.useFakeTimers();
    const signals = new EventEmitter();
    const rec = recording(event => { if (event.type === 'gate.required') { signals.emit('SIGTERM'); vi.advanceTimersByTime(1000); } });
    expect(await runProviderV1({ ...inputs, autoConfirm: false }, canonical, { ...invocation, yes: false }, { signals, writerFactory: () => rec.writer })).toBe(1);
    terminalAgreement(rec.events, 'cancelled', 'RUN_GATE_REQUIRED', 'gate-required');
    expect(rec.finalize).toHaveBeenCalledTimes(1);
  });
  it('does not auto-confirm or announce a gate after a signal wins', async () => {
    const signals = new EventEmitter();
    const rec = recording();
    expect(await runProviderV1(inputs, canonical, invocation, {
      signals, writerFactory: () => rec.writer,
      confirmFactory: confirm => async (...args) => { signals.emit('SIGTERM'); return confirm(...args); },
    })).toBe(1);
    expect(rec.events.some(e => ['gate.required', 'gate.autoConfirm', 'step.pass'].includes(String(e.type)))).toBe(false);
    terminalAgreement(rec.events, 'cancelled', 'RUN_CANCELLED', 'signal');
  });
  it.each(['failed', 'budget-exhausted'] as const)('freezes a %s terminal before a late signal without adding a cause', async scenario => {
    const signals = new EventEmitter();
    const rec = recording(event => { if (event.type === 'run.summary') signals.emit('SIGTERM'); });
    expect(await runProviderV1(inputs, canonical, { ...invocation, scenario }, { signals, writerFactory: () => rec.writer })).toBe(1);
    terminalAgreement(rec.events, scenario, scenario === 'failed' ? 'RUN_FAILED' : 'RUN_BUDGET_EXHAUSTED');
    expect(rec.finalize).toHaveBeenCalledTimes(1);
  });
  it('preserves omission of protocol cancellation metadata in legacy output', async () => {
    expect(await main(['run', await request(), '--executor', 'stub', '--yes'])).toBe(0);
    expect(lines().at(-1)?.payload).not.toHaveProperty('terminationReason');
    expect(lines()[0]?.payload).not.toHaveProperty('protocolVersion');
  });
});

describe('provider pre-start CLI error mapping', () => {
  it('maps writer setup failure to UNEXPECTED_ERROR with empty stdout', async () => {
    vi.spyOn(protocolWriter, 'createProtocolStdoutWriter').mockImplementation(() => { throw new Error('writer setup failed'); });
    expect(await main(['run', await request(), '--executor', 'stub', '--protocol', 'v1'])).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(error()).toEqual({ error: { code: 'UNEXPECTED_ERROR', message: 'writer setup failed' } });
  });
  it('maps partial signal registration failure to UNEXPECTED_ERROR and removes owned listeners', async () => {
    const originalOn = process.on.bind(process);
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    vi.spyOn(process, 'on').mockImplementation(((name: string, listener: (...args: unknown[]) => void) => {
      originalOn(name, listener);
      if (name === 'SIGTERM') throw new Error('signal setup failed');
      return process;
    }) as typeof process.on);
    expect(await main(['run', await request(), '--executor', 'stub', '--protocol', 'v1'])).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(error()).toEqual({ error: { code: 'UNEXPECTED_ERROR', message: 'signal setup failed' } });
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });
});

describe('provider repeated signal lifetime', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('retains %s handling through repeated cancellation and finalization', async signal => {
    const signals = new EventEmitter();
    const events: Array<Record<string, unknown>> = [];
    const finalize = vi.fn(async () => {
      expect(signals.listenerCount(signal)).toBe(1);
      signals.emit(signal);
      signals.emit(signal);
      expect(signals.listenerCount(signal)).toBe(1);
      return 'flushed' as const;
    });
    const canonical = requestExecutionSample as RepositoryGoalRequest;
    expect(await runProviderV1(requestToRunInputs(canonical), canonical, {
      mode: 'provider-v1', requestPath: 'unused', executor: 'stub', yes: true,
      allowGuardrailOverride: false, timeoutMs: 1000, timeoutExplicit: true, scenario: 'success',
    }, {
      signals, writerFactory: () => ({
        failure: undefined, finalize,
        write(event) {
          events.push(event as Record<string, unknown>);
          if ((event as { type: string }).type === 'run.start') {
            signals.emit(signal);
            signals.emit(signal);
            expect(signals.listenerCount(signal)).toBe(1);
          }
        },
      }),
    })).toBe(1);
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'run.summary', payload: { status: 'cancelled', terminationReason: 'signal' } });
    expect(error()).toMatchObject({ error: { code: 'RUN_CANCELLED' } });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(signals.eventNames()).toEqual([]);
  });
  it('absorbs repeated signals during finalization after a successful terminal', async () => {
    const signals = new EventEmitter();
    const canonical = requestExecutionSample as RepositoryGoalRequest;
    const finalize = vi.fn(async () => {
      for (const signal of ['SIGINT', 'SIGTERM']) {
        expect(signals.listenerCount(signal)).toBe(1);
        signals.emit(signal);
        signals.emit(signal);
        expect(signals.listenerCount(signal)).toBe(1);
      }
      return 'flushed' as const;
    });
    expect(await runProviderV1(requestToRunInputs(canonical), canonical, {
      mode: 'provider-v1', requestPath: 'unused', executor: 'stub', yes: true,
      allowGuardrailOverride: false, timeoutMs: 1000, timeoutExplicit: true, scenario: 'success',
    }, { signals, writerFactory: () => ({ failure: undefined, write() {}, finalize }) })).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(signals.eventNames()).toEqual([]);
  });
});

it('retains both handlers while an active cancellation waits for deferred finalization', async () => {
  const signals = new EventEmitter();
  const canonical = requestExecutionSample as RepositoryGoalRequest;
  const events: Array<Record<string, unknown>> = [];
  let entered!: () => void;
  let release!: () => void;
  const finalizing = new Promise<void>(resolve => { entered = resolve; });
  const drain = new Promise<void>(resolve => { release = resolve; });
  const finalize = vi.fn(async () => { entered(); await drain; return 'flushed' as const; });
  const running = runProviderV1(requestToRunInputs(canonical), canonical, {
    mode: 'provider-v1', requestPath: 'unused', executor: 'stub', yes: true,
    allowGuardrailOverride: false, timeoutMs: 1000, timeoutExplicit: true, scenario: 'await-cancel',
  }, { signals, writerFactory: () => ({
    failure: undefined, finalize,
    write(event) {
      events.push(event as Record<string, unknown>);
      if ((event as { type: string }).type === 'stub.waiting') signals.emit('SIGTERM');
    },
  }) });
  await finalizing;
  try {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGTERM']) {
      expect(signals.listenerCount(signal)).toBe(1);
      signals.emit(signal);
    }
    expect(events.filter(e => e.type === 'run.summary')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ payload: { terminationReason: 'signal' } });
  } finally { release(); }
  expect(await running).toBe(1);
  expect(error()).toMatchObject({ error: { code: 'RUN_CANCELLED' } });
  expect(finalize).toHaveBeenCalledTimes(1);
  expect(signals.eventNames()).toEqual([]);
});
