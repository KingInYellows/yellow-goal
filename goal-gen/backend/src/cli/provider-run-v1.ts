import { RunEventEmitter } from '../events/run-event-emitter';
import { createProtocolStdoutWriter, type ProtocolStdoutWriter } from '../events/protocol-stdout-writer';
import { StubExecutor, StubVerifier } from '../executors/stub-executor';
import { StubExtractor } from '../extractors/stub-extractor';
import { Orchestrator, type DodConfirmer, type OrchestratorDeps, type WorktreeProvider } from '../orchestrator/orchestrator';
import type { GoalSpec } from '../planner/types';
import type { RunInputs } from '../run/request-to-run';
import type { ExtractRequest, LlmExtractor, RunSummary } from '../types';
import type { ParsedRunInvocation } from './protocol-run-options';
import { ProviderProtocolVersion } from './provider-capabilities';

type ProviderInvocation = Extract<ParsedRunInvocation, { mode: 'provider-v1' }>;
type TerminationReason = 'signal' | 'timeout' | 'gate-required';
export type ProviderEngineDeps = Pick<OrchestratorDeps, 'extractor' | 'executor' | 'verifier' | 'worktreeProvider'>;

/** Test-only seam; it is not argv or environment authority. */
export interface ProviderRunV1Options {
  writerFactory?: (onFailure: () => void) => ProtocolStdoutWriter;
  /** Deterministic signal source for tests; production uses the process signal events. */
  signals?: {
    on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  };
  /** Internal fixture seam only; never selected by argv, environment, or request data. */
  engineFactory?: (invocation: ProviderInvocation, inputs: RunInputs, onEvent: (event: Record<string, unknown>) => void) => ProviderEngineDeps;
  /** Internal fixture seam for reaching a re-confirmation gate; never selected by user input. */
  confirmFactory?: (protocolConfirm: DodConfirmer) => DodConfirmer;
}

/** Synchronous, first-wins protocol cancellation state; exported for pure race tests. */
export class FirstCauseRecorder {
  private value: TerminationReason | undefined;
  private frozen = false;
  record(next: TerminationReason): boolean {
    if (this.value !== undefined || this.frozen) return false;
    this.value = next;
    return true;
  }
  current(): TerminationReason | undefined { return this.value; }
  freeze(): void { this.frozen = true; }
}

const stubWorktreeProvider: WorktreeProvider = async (opts) => ({
  root: '(stub)', worktreePath: '(stub)', branch: opts.branch ?? 'run', initialSha: '0'.repeat(40), cleanup: async () => {},
});

function successGoal(goalText: string): GoalSpec {
  return {
    goalText, initialState: { done: false }, goalState: { done: true }, constraints: [], completionPolicy: 'verify-only',
    actions: [{
      id: 'stub-action', name: 'stub-action', cost: 1, preconditions: { done: false }, effects: { done: true },
      executor: 'claude-code', payload: {}, verify: { command: 'stub-verify' },
    }],
  };
}

class AwaitCancelExtractor implements LlmExtractor {
  constructor(private readonly onEvent: (event: Record<string, unknown>) => void) {}
  async extract(_req: ExtractRequest, signal?: AbortSignal): Promise<{ goalSpec: GoalSpec; costUsd: number }> {
    this.onEvent({ ev: 'stub.waiting' });
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('stub await-cancel aborted'));
        return;
      }
      const abort = (): void => {
        signal?.removeEventListener('abort', abort);
        reject(new Error('stub await-cancel aborted'));
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
    throw new Error('unreachable');
  }
  async expand(): Promise<{ actions: []; costUsd: number }> { return { actions: [], costUsd: 0 }; }
}

function stubEngine(invocation: ProviderInvocation, inputs: RunInputs, onEvent: (event: Record<string, unknown>) => void): ProviderEngineDeps {
  if (invocation.scenario === 'await-cancel') {
    return { extractor: new AwaitCancelExtractor(onEvent), executor: new StubExecutor(), verifier: new StubVerifier(), worktreeProvider: stubWorktreeProvider };
  }
  if (invocation.scenario === 'failed') {
    return {
      extractor: new StubExtractor({ goalSpec: successGoal(inputs.goalText), extractError: new Error('deterministic stub failure') }),
      executor: new StubExecutor(), verifier: new StubVerifier(), worktreeProvider: stubWorktreeProvider,
    };
  }
  return {
    extractor: new StubExtractor({
      goalSpec: successGoal(inputs.goalText),
      ...(invocation.scenario === 'budget-exhausted' ? { extractCostUsd: inputs.runConfig.maxBudgetUsd } : {}),
    }),
    executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0 } }),
    verifier: new StubVerifier(), worktreeProvider: stubWorktreeProvider,
  };
}

function errorEnvelope(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/** Normalize even hostile thrown values without allowing error reporting to throw. */
function normalizedError(value: unknown): Error {
  try {
    return new Error(value instanceof Error ? value.message : String(value));
  } catch {
    return new Error('unknown provider protocol failure');
  }
}

function summaryError(summary: RunSummary): { error: { code: string; message: string } } | undefined {
  if (summary.status === 'succeeded') return undefined;
  if (summary.status === 'failed') return errorEnvelope('RUN_FAILED', summary.reason);
  if (summary.status === 'budget-exhausted') return errorEnvelope('RUN_BUDGET_EXHAUSTED', summary.reason);
  if (summary.status === 'cancelled') {
    const codes = { signal: 'RUN_CANCELLED', timeout: 'RUN_TIMEOUT', 'gate-required': 'RUN_GATE_REQUIRED' } as const;
    if (summary.terminationReason === undefined) throw new Error('cancelled protocol summary has no termination reason');
    return errorEnvelope(codes[summary.terminationReason], summary.reason);
  }
  throw new Error('provider protocol returned a nonterminal summary');
}

/** Complete provider-v1 lifecycle. This accepts no executor selector and never imports a real executor. */
export async function runProviderV1(
  inputs: RunInputs,
  request: { target: { repository: string } },
  invocation: ProviderInvocation,
  options: ProviderRunV1Options = {},
): Promise<number> {
  const causes = new FirstCauseRecorder();
  const controller = new AbortController();
  const signals = options.signals ?? process;
  const state: { started: boolean; summary?: RunSummary } = { started: false };
  let writer: ProtocolStdoutWriter | undefined;
  let emitter: RunEventEmitter | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sigintInstalled = false;
  let sigtermInstalled = false;
  let transportFailed = false;
  let transportError: Error | undefined;
  let preStartError: Error | undefined;

  const recordCause = (next: TerminationReason): boolean => {
    if (!causes.record(next)) return false;
    controller.abort();
    return true;
  };
  const signalAbort = (): void => { recordCause('signal'); };
  const onWriterFailure = (): void => {
    transportFailed = true;
    controller.abort();
  };
  const emitFallback = (reason: string): void => {
    if (state.summary !== undefined || emitter === undefined || transportFailed) return;
    const terminationReason = causes.current();
    const summary: RunSummary = {
      status: terminationReason === undefined ? 'failed' : 'cancelled',
      goalText: inputs.goalText, costUsd: 0, replans: 0, reextractions: 0, actions: [], reason,
      ...(terminationReason === undefined ? {} : { terminationReason }),
    };
    emitter.next('run.summary', { ...summary });
  };

  try {
    const activeWriter = options.writerFactory?.(onWriterFailure)
      ?? createProtocolStdoutWriter({ onFailure: onWriterFailure });
    writer = activeWriter;
    // Mark ownership before registration so partial setup failures are cleaned up.
    sigintInstalled = true;
    signals.on('SIGINT', signalAbort);
    sigtermInstalled = true;
    signals.on('SIGTERM', signalAbort);
    timer = setTimeout(() => { recordCause('timeout'); }, invocation.timeoutMs);

    const events = new RunEventEmitter({
      sink: (envelope) => {
        if (envelope.type === 'run.start') state.started = true;
        if (envelope.type === 'run.summary' && state.summary === undefined) {
          state.summary = envelope.payload as unknown as RunSummary;
          causes.freeze();
        }
        // Keep the canonical emitter's plaintext catch unreachable even for a
        // misbehaving injected writer. Observation never rewrites the envelope.
        try { activeWriter.write(envelope); }
        catch (error) { transportError ??= normalizedError(error); onWriterFailure(); }
      },
    });
    emitter = events;
    const autoConfirm = invocation.yes || inputs.autoConfirm;
    const confirm: DodConfirmer = async (_dod, signal, kind) => {
      if (controller.signal.aborted || signal?.aborted) return false;
      if (autoConfirm) {
        events.handle({ ev: 'gate.autoConfirm', kind });
        return !controller.signal.aborted;
      }
      if (recordCause('gate-required')) events.handle({ ev: 'gate.required', kind });
      return false;
    };
    const acceptanceGate = async (): Promise<'reject'> => {
      if (recordCause('gate-required')) events.handle({ ev: 'gate.required', kind: 'acceptance' });
      return 'reject';
    };
    const configuredConfirm = options.confirmFactory?.(confirm) ?? confirm;
    events.next('run.start', {
      goalText: inputs.goalText, executor: 'stub', autoConfirm, allowGuardrailOverride: invocation.allowGuardrailOverride,
      runConfig: inputs.runConfig, targetRepository: request.target.repository, targetRepositoryHonored: false,
      protocolVersion: ProviderProtocolVersion, stubScenario: invocation.scenario, simulation: true,
    });
    if (!transportFailed && activeWriter.failure === undefined) {
      if (controller.signal.aborted) {
        emitFallback('cancelled before engine construction');
      } else {
        const engine = (options.engineFactory ?? stubEngine)(invocation, inputs, events.handle);
        if (controller.signal.aborted) {
          emitFallback('cancelled before extraction');
        } else {
          const orchestrator = new Orchestrator({
            ...engine, config: inputs.runConfig, events, confirm: configuredConfirm, acceptanceGate,
            signal: controller.signal, terminationReason: () => causes.current(),
          });
          const summary = await orchestrator.run({ goalText: inputs.goalText });
          // Defensive against an internal return that failed to mint its terminal.
          if (state.summary === undefined) events.next('run.summary', { ...summary });
        }
      }
    }
  } catch (error) {
    const failure = normalizedError(error);
    if (!state.started) preStartError = failure;
    else emitFallback(`run aborted by unexpected error: ${failure.message}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Retain signal handlers while stdout drains: repeated signals remain
    // first-cause observations, never Node's default process termination.
    try {
      // This is the sole finalization call, including setup and catch paths.
      if (writer !== undefined) {
        try { await writer.finalize(); }
        catch (error) { transportError ??= normalizedError(error); onWriterFailure(); }
      }
    } finally {
      if (sigintInstalled) signals.off('SIGINT', signalAbort);
      if (sigtermInstalled) signals.off('SIGTERM', signalAbort);
    }
  }

  if (transportFailed || writer?.failure !== undefined) {
    const failure = writer?.failure?.cause ?? transportError ?? new Error('stdout transport failed');
    process.stderr.write(`${JSON.stringify(errorEnvelope('RUN_STDOUT_TRANSPORT_FAILED', normalizedError(failure).message))}\n`);
    return 1;
  }
  if (preStartError !== undefined) throw preStartError;
  if (state.summary === undefined) throw new Error('provider protocol completed without a terminal summary');
  const failure = summaryError(state.summary);
  if (failure !== undefined) {
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    return 1;
  }
  return 0;
}
