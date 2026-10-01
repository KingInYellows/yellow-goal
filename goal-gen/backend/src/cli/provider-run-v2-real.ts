/**
 * Provider protocol v2 real run (ADR-0020, AGX-R24/R25): the approval-gated engine behind a
 * run-event/v1 JSON Lines stream. It calls `runRealRun` only — never the Orchestrator, the
 * `ClaudeCodeExecutor`, or `run-command.ts`'s engines (AGX-R26) — and turns the engine's observer
 * hooks and final outcome into events:
 *
 *   run.start  — once the approval is consumed (so a refusal produces no events at all)
 *   run.spend  — one per metered worker attempt
 *   run.summary — the terminal event, with an `outcome` discriminator
 *
 * There are no `gate.*` events: the approval replaces the DoD confirmation (AGX-R25). Exit codes
 * keep the ADR-0016 contract: 0 verified (awaiting a human, AGX-R20), 1 any failure, 2 usage.
 */
import { RunEventEmitter } from '../events/run-event-emitter';
import { createProtocolStdoutWriter, type ProtocolStdoutWriter } from '../events/protocol-stdout-writer';
import type { EngineErrorEvidence, RealRunOutcome } from '../real-run/outcome';
import { runRealRun, type RealRunInput, type RealRunStarted } from '../real-run/real-run-engine';
import type { ParsedRunInvocation } from './protocol-run-options';
import { ProviderProtocolV2 } from './provider-capabilities';

type RealInvocation = Extract<ParsedRunInvocation, { mode: 'provider-v2-real' }>;

/** Test-only seams; none is argv or environment authority and production passes none. */
export interface ProviderRunV2RealOptions {
  executorFactory?: RealRunInput['executorFactory'];
  writerFactory?: (onFailure: () => void) => ProtocolStdoutWriter;
  /** Deterministic signal source for tests; production uses the process signal events. */
  signals?: {
    on(signal: 'SIGHUP' | 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    off(signal: 'SIGHUP' | 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  };
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
}

type ErrorBody = { code: string; message: string; approvalId?: string };

function writeError(error: ErrorBody): void {
  process.stderr.write(`${JSON.stringify({ error })}\n`);
}

function normalizedMessage(value: unknown): string {
  try {
    return value instanceof Error ? value.message : String(value);
  } catch {
    return 'unknown provider protocol failure';
  }
}

function startPayload(info: RealRunStarted): Record<string, unknown> {
  const { manifest } = info;
  return {
    protocolVersion: ProviderProtocolV2,
    executor: 'agx-claude-code',
    simulation: false,
    targetRepository: info.targetRepository,
    targetRepositoryHonored: false,
    approvalId: info.approvalId,
    manifestHash: info.manifestHash,
    profile: manifest.profile,
    caps: manifest.caps,
  };
}

/** The terminal payload for an outcome that got past consumption; spend rides on `run.spend`. */
function summaryPayload(outcome: Exclude<RealRunOutcome, { kind: 'refused' }>): Record<string, unknown> {
  const common = { outcome: outcome.kind, approvalId: outcome.approvalId, targetRepositoryHonored: false };
  switch (outcome.kind) {
    case 'worker-failed':
      return { ...common, reason: outcome.reason, evidence: outcome.evidence };
    case 'verification-rejected':
      return { ...common, bundleDir: outcome.bundleDir, reasons: outcome.reasons, ...boundedPaths(outcome.outOfScopeChanges) };
    case 'verified':
      return { ...common, bundleDir: outcome.bundleDir, ...boundedPaths(outcome.outOfScopeChanges) };
  }
}

/** The stream carries a bounded sample of out-of-scope paths; the full list is not an event (1 MiB cap). */
const MAX_OUT_OF_SCOPE_IN_EVENT = 200;
function boundedPaths(paths: string[] | null): Record<string, unknown> {
  if (paths === null) return { outOfScopeChanges: null };
  return {
    outOfScopeChanges: paths.slice(0, MAX_OUT_OF_SCOPE_IN_EVENT),
    outOfScopeChangesCount: paths.length,
    ...(paths.length > MAX_OUT_OF_SCOPE_IN_EVENT ? { outOfScopeChangesTruncated: true } : {}),
  };
}

function failureOf(outcome: Exclude<RealRunOutcome, { kind: 'refused' }>): ErrorBody | undefined {
  switch (outcome.kind) {
    case 'worker-failed':
      return { code: 'RUN_WORKER_FAILED', message: `worker run failed: ${outcome.reason}`, approvalId: outcome.approvalId };
    case 'verification-rejected':
      return { code: 'RUN_VERIFICATION_REJECTED', message: `verification rejected the candidate: ${outcome.reasons.join('; ')}`, approvalId: outcome.approvalId };
    case 'verified':
      return undefined;
  }
}

export async function runProviderV2Real(invocation: RealInvocation, options: ProviderRunV2RealOptions = {}): Promise<number> {
  const controller = new AbortController();
  const signals = options.signals ?? process;
  const abort = (): void => controller.abort();
  let transportFailed = false;
  let transportError: Error | undefined;
  const onWriterFailure = (): void => {
    transportFailed = true;
    controller.abort();
  };
  let writer: ProtocolStdoutWriter | undefined;
  let installed = false;
  let started: RealRunStarted | undefined;
  let outcome: RealRunOutcome | undefined;
  let thrown: unknown;
  let emitter: RunEventEmitter | undefined;
  let terminal = false;

  const emitSummary = (payload: Record<string, unknown>): void => {
    if (terminal || emitter === undefined || started === undefined) return;
    terminal = true;
    emitter.next('run.summary', payload);
  };

  try {
    const activeWriter = options.writerFactory?.(onWriterFailure) ?? createProtocolStdoutWriter({ onFailure: onWriterFailure });
    writer = activeWriter;
    installed = true;
    signals.on('SIGHUP', abort);
    signals.on('SIGINT', abort);
    signals.on('SIGTERM', abort);
    emitter = new RunEventEmitter({
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      sink: (envelope) => {
        // Keep the emitter's plaintext catch unreachable even for a misbehaving injected writer.
        try {
          activeWriter.write(envelope);
        } catch (error) {
          transportError ??= new Error(normalizedMessage(error));
          onWriterFailure();
        }
      },
    });
    const events = emitter;
    try {
      outcome = await runRealRun({
        requestPath: invocation.requestPath,
        manifestFlags: invocation.manifestFlags,
        approvalPath: invocation.approvalPath,
        signal: controller.signal,
        ...(options.executorFactory === undefined ? {} : { executorFactory: options.executorFactory }),
        ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        onStarted: (info) => {
          started = info;
          events.next('run.start', startPayload(info));
        },
        onSpend: (spend) => {
          events.next('run.spend', { approvalId: started?.approvalId, ...spend });
        },
      });
    } catch (error) {
      thrown = error;
    }
    if (outcome !== undefined && outcome.kind !== 'refused') emitSummary(summaryPayload(outcome));
    // An unexpected throw after consumption still ends the stream with a terminal event.
    if (outcome === undefined && started !== undefined) {
      emitSummary({
        outcome: 'worker-failed', approvalId: started.approvalId, targetRepositoryHonored: false,
        reason: 'engine-error', evidence: { stage: 'protocol', message: normalizedMessage(thrown) } satisfies EngineErrorEvidence,
      });
    }
  } catch (error) {
    thrown ??= error;
  } finally {
    // Retain signal handlers while stdout drains: a repeated signal must not kill the process.
    try {
      if (writer !== undefined) {
        try {
          await writer.finalize();
        } catch (error) {
          transportError ??= new Error(normalizedMessage(error));
          onWriterFailure();
        }
      }
    } finally {
      if (installed) {
        signals.off('SIGHUP', abort);
        signals.off('SIGINT', abort);
        signals.off('SIGTERM', abort);
      }
    }
  }

  if (transportFailed || writer?.failure !== undefined) {
    const failure = writer?.failure?.cause ?? transportError ?? new Error('stdout transport failed');
    writeError({
      code: 'RUN_STDOUT_TRANSPORT_FAILED', message: normalizedMessage(failure),
      ...(started === undefined ? {} : { approvalId: started.approvalId }),
    });
    return 1;
  }
  if (outcome === undefined) {
    // No outcome: usage/request errors before the approval was read, or an unexpected engine throw.
    if (started === undefined) throw thrown ?? new Error('real run produced no outcome');
    writeError({ code: 'RUN_WORKER_FAILED', message: `worker run failed: engine-error: ${normalizedMessage(thrown)}`, approvalId: started.approvalId });
    return 1;
  }
  if (outcome.kind === 'refused') {
    writeError({ code: outcome.code, message: outcome.message, ...(outcome.approvalId === undefined ? {} : { approvalId: outcome.approvalId }) });
    return 1;
  }
  const failure = failureOf(outcome);
  if (failure !== undefined) {
    writeError(failure);
    return 1;
  }
  return 0;
}
