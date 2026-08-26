/**
 * The single per-run mint for `run-event/v1` envelopes (RR6–RR8,
 * plans/specs/request-to-run-pipeline.md). One instance exists per run; every event source
 * feeding that run — orchestrator `onEvent`, extractor `onEvent`, entry-point wrapper — routes
 * through it, so `sequence` is monotonic (0, 1, 2, …) across the whole stream and nothing else
 * ever mints one (RR7).
 *
 * Internal call sites keep their terse `{ ev: 'step.pass', ...rest }` objects; `handle` maps
 * them to envelopes as `type = ev`, `payload = rest` at this boundary (RR8).
 */
import { randomUUID } from 'node:crypto';
import { RunEventSchemaVersion, type RunEvent } from '../contracts/run-event';

export interface RunEventEmitterOptions {
  /** Minted here when absent — entry points pass the same id to `Orchestrator.run()`. */
  runId?: string;
  /** Receives every minted envelope, in sequence order (e.g. a JSON-lines stdout writer). */
  sink: (envelope: RunEvent) => void;
  /** Injectable for deterministic tests; defaults to wall clock. */
  clock?: () => Date;
}

export class RunEventEmitter {
  readonly runId: string;
  private sequenceCounter = 0;
  private readonly sink: (envelope: RunEvent) => void;
  private readonly clock: () => Date;

  constructor(opts: RunEventEmitterOptions) {
    this.runId = opts.runId ?? randomUUID();
    this.sink = opts.sink;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** Ad-hoc `{ ev, ...rest }` handler (RR8) — bound so it can be passed bare as an `onEvent`
   *  callback. Events missing a string `ev` keep their fields as payload under type `unknown`
   *  rather than being dropped: a malformed emit must stay visible in the stream. */
  handle = (event: Record<string, unknown>): RunEvent => {
    const { ev, ...rest } = event;
    const type = typeof ev === 'string' && ev !== '' ? ev : 'unknown';
    return this.next(type, rest);
  };

  /** Mint, sink, and return the next envelope. */
  next(type: string, payload: Record<string, unknown> = {}): RunEvent {
    const envelope: RunEvent = {
      schemaVersion: RunEventSchemaVersion,
      runId: this.runId,
      sequence: this.sequenceCounter++,
      timestamp: this.clock().toISOString(),
      type,
      payload,
    };
    try {
      this.sink(envelope);
    } catch (e) {
      // A telemetry sink must never fail the run it describes (broken stdout pipe when output is
      // piped to `head`, a future disconnected SSE client). The mint still counts — the sequence
      // stays gapless for consumers — and the failure is surfaced on stderr, not thrown through
      // Orchestrator.run()'s documented never-throws contract.
      const message = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[run-event-emitter] sink failed for sequence ${envelope.sequence}: ${message}\n`);
    }
    return envelope;
  }
}
