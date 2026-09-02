/**
 * RR6–RR8 (plans/specs/request-to-run-pipeline.md): the single per-run run-event/v1 mint.
 * Every envelope must validate against BOTH the zod contract and the vendored JSON Schema —
 * the same dual-oracle rule the compat gate applies to the other contracts.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { RunEventSchema } from '../../backend/src/contracts/run-event';
import { RunEventEmitter } from '../../backend/src/events/run-event-emitter';
import { createStdoutSink } from '../../backend/src/events/stdout-sink';
import { validateAgainstJsonSchema } from '../contracts/support/json-schema-checker';
import { loadVendoredSchema } from '../contracts/support/load-schema';

const FIXED_CLOCK = () => new Date('2026-08-26T12:00:00.000Z');

function collect() {
  const envelopes: unknown[] = [];
  const emitter = new RunEventEmitter({ runId: 'run-emitter-test', sink: (e) => envelopes.push(e), clock: FIXED_CLOCK });
  return { envelopes, emitter };
}

describe('RunEventEmitter', () => {
  it('mints envelopes that validate against zod AND the vendored JSON Schema (RR6)', () => {
    const { envelopes, emitter } = collect();
    emitter.handle({ ev: 'run.start', goalText: 'demo', autoConfirm: true });
    emitter.next('AwaitingAcceptance', { goalState: { built: true } });

    const vendored = loadVendoredSchema('run-event');
    for (const envelope of envelopes) {
      expect(RunEventSchema.safeParse(envelope).success).toBe(true);
      const jsonResult = validateAgainstJsonSchema(vendored, envelope);
      expect(jsonResult.valid, jsonResult.errors.join('; ')).toBe(true);
    }
  });

  it('mints a monotonic sequence starting at 0 across all sources (RR7)', () => {
    const { envelopes, emitter } = collect();
    // Interleave the two entry styles the way extractor (handle) + orchestrator (handle) +
    // gate-entry persistence (next) do in production — one counter serves them all.
    emitter.handle({ ev: 'a' });
    emitter.next('b');
    emitter.handle({ ev: 'c' });
    expect((envelopes as Array<{ sequence: number }>).map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it('maps ad-hoc {ev, ...rest} onto type/payload and returns the minted envelope (RR8)', () => {
    const { emitter } = collect();
    const envelope = emitter.handle({ ev: 'step.pass', actionId: 'a1', attempts: 2 });
    expect(envelope).toMatchObject({
      schemaVersion: 'yellow-goal/run-event/v1',
      runId: 'run-emitter-test',
      sequence: 0,
      timestamp: '2026-08-26T12:00:00.000Z',
      type: 'step.pass',
      payload: { actionId: 'a1', attempts: 2 },
    });
  });

  it('keeps a malformed emit visible instead of dropping it', () => {
    const { emitter } = collect();
    const envelope = emitter.handle({ message: 'no ev field' });
    expect(envelope.type).toBe('unknown');
    expect(envelope.payload).toEqual({ message: 'no ev field' });

    const invalidType = emitter.handle({ ev: 42, message: 'non-string ev field' });
    expect(invalidType.type).toBe('unknown');
    expect(invalidType.payload).toEqual({ ev: 42, message: 'non-string ev field' });
  });

  it('contains a throwing sink: nothing propagates and the mint still counts', () => {
    const emitter = new RunEventEmitter({
      runId: 'run-emitter-test',
      sink: () => {
        throw new Error('broken pipe');
      },
    });
    expect(() => emitter.next('step.pass')).not.toThrow();
    // The failed delivery still consumed its minted sequence. A recovered transport can observe
    // the gap, which is safer than reusing a sequence that persistence may already have recorded.
    expect(emitter.next('step.fail').sequence).toBe(1);
  });

  it('mints its own runId when none is given', () => {
    const emitter = new RunEventEmitter({ sink: () => {} });
    expect(emitter.runId.length).toBeGreaterThan(0);
    expect(emitter.next('x').runId).toBe(emitter.runId);
  });
});

// `process.stdout.write()` reports a broken pipe (EPIPE) asynchronously via the stream's 'error'
// event rather than a throw, so the emitter's synchronous try/catch above cannot contain it —
// `createStdoutSink` (events/stdout-sink.ts) handles it at the stream boundary instead. These tests drive a
// fake stream to prove that boundary actually survives an async stream error.
describe('createStdoutSink (async stream-error containment, events/stdout-sink.ts)', () => {
  function fakeStream() {
    const written: string[] = [];
    const stream = Object.assign(new EventEmitter(), { write: (chunk: string) => (written.push(chunk), true) });
    return { stream: stream as unknown as NodeJS.WritableStream, written };
  }

  it('writes one JSON-lines envelope per call', () => {
    const { stream, written } = fakeStream();
    const sink = createStdoutSink(stream);
    sink({ type: 'run.start' });
    expect(written).toEqual([`${JSON.stringify({ type: 'run.start' })}\n`]);
  });

  it('does not crash on an async stream error and degrades quietly afterward', () => {
    const { stream, written } = fakeStream();
    const sink = createStdoutSink(stream);
    sink({ type: 'run.start' });
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    // A stream `emit('error', ...)` with no listener throws synchronously in Node — this asserts
    // createStdoutSink's own listener is what prevents that process-killing crash.
    expect(() => stream.emit('error', epipe)).not.toThrow();
    sink({ type: 'run.summary', status: 'failed' });
    // The post-error write is dropped, not retried against a pipe that cannot un-close.
    expect(written).toEqual([`${JSON.stringify({ type: 'run.start' })}\n`]);
  });

  it('records a non-EPIPE stream error as transportError — no throw, nothing on stderr', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { stream, written } = fakeStream();
    const sink = createStdoutSink(stream);
    const err = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    expect(sink.transportError).toBeUndefined();
    expect(() => stream.emit('error', err)).not.toThrow();
    expect(sink.transportError).toBe(err);
    // stderr is reserved for the entry point's single-line structured envelope.
    expect(stderrSpy).not.toHaveBeenCalled();
    sink({ type: 'run.summary' });
    expect(written).toEqual([]);
    stderrSpy.mockRestore();
  });

  it('dispose() detaches the stream error listener so per-run sinks do not accumulate', () => {
    const { stream } = fakeStream();
    const before = (stream as unknown as EventEmitter).listenerCount('error');
    const sink = createStdoutSink(stream);
    expect((stream as unknown as EventEmitter).listenerCount('error')).toBe(before + 1);
    sink.dispose();
    expect((stream as unknown as EventEmitter).listenerCount('error')).toBe(before);
  });
});
