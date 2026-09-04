/**
 * Provider Protocol v1's bounded stdout transport (PP-09).
 *
 * This is deliberately separate from stdout-sink.ts: that sink preserves the
 * legacy best-effort runner contract, while this writer is a fail-closed,
 * bounded transport for an admitted protocol run. Its synchronous `write`
 * method is suitable as a RunEventEmitter sink and never throws.
 */

export const PROTOCOL_STDOUT_MAX_EVENT_BYTES = 1_048_576;
export const PROTOCOL_STDOUT_MAX_QUEUED_BYTES = 4_194_304;
export const PROTOCOL_STDOUT_FINALIZE_MS = 5_000;

export type ProtocolTransportFailureKind =
  | 'serialize'
  | 'event-too-large'
  | 'queue-overflow'
  | 'write'
  | 'callback'
  | 'stream'
  | 'drain-timeout';

export interface ProtocolTransportFailure {
  code: 'RUN_STDOUT_TRANSPORT_FAILED';
  kind: ProtocolTransportFailureKind;
  cause: Error;
}

export interface ProtocolStdoutWriter {
  /** Serializes and queues an envelope. This method never throws. */
  write(envelope: unknown): void;
  /** The first transport failure, permanently latched. */
  readonly failure: ProtocolTransportFailure | undefined;
  /** Stops admission and allows one total graceful drain; overrides only shorten the deadline. */
  finalize(deadlineMs?: number): Promise<'flushed' | 'failed' | 'timed-out'>;
}

export interface ProtocolStdoutWriterOptions {
  stream?: NodeJS.WriteStream;
  /** Positive safe integers may reduce the protocol limits, never raise them. */
  maxEventBytes?: number;
  maxQueuedBytes?: number;
  /** Called once, synchronously after the first failure is latched. */
  onFailure: (failure: ProtocolTransportFailure) => void;
}

interface Entry {
  line: string;
  bytes: number;
  callbackDone: boolean;
  waitsForDrain: boolean;
  drained: boolean;
  writeReturned: boolean;
  onDrain: () => void;
}

/** Internal test overrides can only tighten the advertised protocol bounds. */
function boundedLimit(value: number | undefined, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;
}

function asError(value: unknown): Error {
  try {
    if (value instanceof Error) return value;
  } catch {
    // A hostile value can trap prototype access; preserve the sink contract.
  }
  try {
    return new Error(String(value));
  } catch {
    return new Error('unknown stdout transport error');
  }
}

/**
 * One FIFO writer with at most one stream.write in flight. `false` from
 * write() is backpressure, not failure: the next write waits for BOTH the
 * callback and drain, in either order.
 */
export function createProtocolStdoutWriter(options: ProtocolStdoutWriterOptions): ProtocolStdoutWriter {
  const stream = options.stream ?? process.stdout;
  const maxEventBytes = boundedLimit(options.maxEventBytes, PROTOCOL_STDOUT_MAX_EVENT_BYTES);
  const maxQueuedBytes = boundedLimit(options.maxQueuedBytes, PROTOCOL_STDOUT_MAX_QUEUED_BYTES);
  const queue: Entry[] = [];
  let active: Entry | undefined;
  let queuedBytes = 0;
  let accepting = true;
  let failure: ProtocolTransportFailure | undefined;
  let finalizing = false;
  let finalization: Promise<'flushed' | 'failed' | 'timed-out'> | undefined;
  let settleFinalization: ((result: 'flushed' | 'failed' | 'timed-out') => void) | undefined;
  let finalizationTimer: NodeJS.Timeout | undefined;
  let healthySettlementScheduled = false;
  let pumping = false;
  let destroyed = false;
  let closed = false;

  const removeDrain = (entry: Entry | undefined): void => {
    if (entry?.waitsForDrain) stream.off('drain', entry.onDrain);
  };

  const removeGuards = (): void => {
    stream.off('error', onStreamError);
    stream.off('close', onClose);
    removeDrain(active);
  };

  const settle = (result: 'flushed' | 'failed' | 'timed-out'): void => {
    if (finalizationTimer !== undefined) {
      clearTimeout(finalizationTimer);
      finalizationTimer = undefined;
    }
    const resolve = settleFinalization;
    settleFinalization = undefined;
    resolve?.(result);
  };

  const clearBuffered = (): void => {
    removeDrain(active);
    active = undefined;
    queue.splice(0, queue.length);
    queuedBytes = 0;
  };

  const destroyProtocolStdout = (): void => {
    if (destroyed) return;
    destroyed = true;
    try {
      stream.destroy();
    } catch {
      // The transport failure is already latched; destruction is best effort.
    }
  };

  const reportFailure = (
    kind: ProtocolTransportFailureKind,
    cause: unknown,
    finalizationResult: 'failed' | 'timed-out' = 'failed',
  ): void => {
    if (failure !== undefined) return;
    failure = { code: 'RUN_STDOUT_TRANSPORT_FAILED', kind, cause: asError(cause) };
    accepting = false;
    clearBuffered();
    // Once the v1 writer has failed, its CLI-owned stdout cannot recover into
    // a trustworthy event stream. Stop any native write that was still pending.
    destroyProtocolStdout();
    // The cancellation owner must not make an emitter-facing sink throw.
    try {
      options.onFailure(failure);
    } catch {
      // The original transport failure remains authoritative.
    }
    if (finalizing) settle(finalizationResult);
  };

  const finishActive = (entry: Entry): void => {
    if (failure !== undefined || active !== entry || !entry.writeReturned || !entry.callbackDone) return;
    if (entry.waitsForDrain && !entry.drained) return;
    removeDrain(entry);
    active = undefined;
    queuedBytes -= entry.bytes;
    pump();
  };

  const onStreamError = (error: Error): void => {
    reportFailure('stream', error);
  };

  const onClose = (): void => {
    closed = true;
    if (failure === undefined) {
      reportFailure('stream', new Error('stdout closed before healthy finalization'));
    }
    // After close, no later stream error can be emitted by this stream.
    removeGuards();
  };

  const maybeFinishFinalization = (): void => {
    if (!finalizing || failure !== undefined || active !== undefined || queue.length > 0) return;
    if (healthySettlementScheduled) return;
    // Writable errors can be delivered after a write callback. Keep the guard
    // through one macrotask before declaring a healthy stream quiescent.
    healthySettlementScheduled = true;
    setImmediate(() => {
      healthySettlementScheduled = false;
      if (!finalizing || failure !== undefined || active !== undefined || queue.length > 0) return;
      removeGuards();
      settle('flushed');
    });
  };

  const pump = (): void => {
    if (pumping || failure !== undefined || active !== undefined) {
      maybeFinishFinalization();
      return;
    }
    pumping = true;
    try {
      while (failure === undefined && active === undefined) {
        const entry = queue.shift();
        if (entry === undefined) break;
        active = entry;
        try {
          const accepted = stream.write(entry.line, (error?: Error | null) => {
            if (failure !== undefined || active !== entry) return;
            if (error) {
              reportFailure('callback', error);
              return;
            }
            entry.callbackDone = true;
            finishActive(entry);
          });
          entry.writeReturned = true;
          // A fake or unusual Writable may synchronously invoke its callback
          // (or emit error) before write() returns. Failure clears active, so
          // do not attach a drain listener to an entry that no longer exists.
          if (failure !== undefined || active !== entry) continue;
          if (!accepted) {
            entry.waitsForDrain = true;
            stream.once('drain', entry.onDrain);
          }
          finishActive(entry);
        } catch (error) {
          reportFailure('write', error);
        }
      }
    } finally {
      pumping = false;
      maybeFinishFinalization();
    }
  };

  const timeoutFinalization = (): void => {
    if (failure === undefined) {
      reportFailure('drain-timeout', new Error('stdout finalization timed out'), 'timed-out');
    }
    // PP-09: this is an escalation attempt. The process owner must not wait
    // for close, but the error guard stays installed until close/process exit.
    destroyProtocolStdout();
    settle('timed-out');
  };

  stream.on('error', onStreamError);
  stream.once('close', onClose);

  return {
    write(envelope: unknown): void {
      if (!accepting || failure !== undefined || closed) return;
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(envelope);
      } catch (error) {
        reportFailure('serialize', error);
        return;
      }
      if (serialized === undefined) {
        reportFailure('serialize', new Error('event did not serialize to JSON'));
        return;
      }
      const line = `${serialized}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > maxEventBytes) {
        reportFailure('event-too-large', new Error(`event is ${bytes} bytes; maximum is ${maxEventBytes}`));
        return;
      }
      if (queuedBytes + bytes > maxQueuedBytes) {
        reportFailure('queue-overflow', new Error(`stdout queue exceeds ${maxQueuedBytes} bytes`));
        return;
      }
      const entry: Entry = {
        line,
        bytes,
        callbackDone: false,
        waitsForDrain: false,
        drained: false,
        writeReturned: false,
        onDrain: () => {
          if (failure !== undefined || active !== entry) return;
          entry.drained = true;
          finishActive(entry);
        },
      };
      queuedBytes += bytes;
      queue.push(entry);
      pump();
    },
    get failure(): ProtocolTransportFailure | undefined {
      return failure;
    },
    finalize(deadlineMs = PROTOCOL_STDOUT_FINALIZE_MS): Promise<'flushed' | 'failed' | 'timed-out'> {
      if (finalization !== undefined) return finalization;
      accepting = false;
      finalizing = true;
      finalization = new Promise((resolve) => {
        settleFinalization = resolve;
      });
      if (failure !== undefined) {
        settle('failed');
        return finalization;
      }
      finalizationTimer = setTimeout(timeoutFinalization, boundedLimit(deadlineMs, PROTOCOL_STDOUT_FINALIZE_MS));
      pump();
      maybeFinishFinalization();
      return finalization;
    },
  };
}
