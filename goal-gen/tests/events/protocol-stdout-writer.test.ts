import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProtocolStdoutWriter,
  PROTOCOL_STDOUT_MAX_EVENT_BYTES,
  type ProtocolTransportFailure,
} from '../../backend/src/events/protocol-stdout-writer';

class ControllableWriteStream extends EventEmitter {
  readonly writes: string[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  readonly destroy = vi.fn(() => this);
  nextReturn = true;
  synchronousCallbacks = false;
  throwOnWrite: Error | undefined;

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    if (this.throwOnWrite) throw this.throwOnWrite;
    this.writes.push(chunk);
    if (callback) {
      if (this.synchronousCallbacks) callback();
      else this.callbacks.push(callback);
    }
    return this.nextReturn;
  }

  callback(index = 0, error?: Error | null): void {
    this.callbacks.splice(index, 1)[0]?.(error);
  }
}

function asStream(stream: ControllableWriteStream): NodeJS.WriteStream {
  return stream as unknown as NodeJS.WriteStream;
}

function makeWriter(stream = new ControllableWriteStream(), limits: Partial<{ maxEventBytes: number; maxQueuedBytes: number }> = {}) {
  const failures: ProtocolTransportFailure[] = [];
  const writer = createProtocolStdoutWriter({ stream: asStream(stream), onFailure: (failure) => failures.push(failure), ...limits });
  return { stream, writer, failures };
}

function eventWithJsonLineBytes(bytes: number): { payload: string } {
  const overhead = Buffer.byteLength(`${JSON.stringify({ payload: '' })}\n`, 'utf8');
  const payloadBytes = bytes - overhead;
  if (payloadBytes < 0) throw new Error('requested JSON line is too small');
  // Exercise UTF-8 accounting as well as ASCII accounting: each emoji is four
  // bytes and the remainder is filled with single-byte characters.
  return { payload: '😀'.repeat(Math.floor(payloadBytes / 4)) + 'x'.repeat(payloadBytes % 4) };
}

afterEach(() => vi.useRealTimers());

describe('Protocol stdout writer (PP-09)', () => {
  it.each([Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'never raises event, queue or finalization bounds with override %s', async (override) => {
      vi.useFakeTimers();
      const eventCase = makeWriter(undefined, { maxEventBytes: override });
      eventCase.writer.write({ payload: 'x'.repeat(PROTOCOL_STDOUT_MAX_EVENT_BYTES) });
      expect(eventCase.failures[0]?.kind).toBe('event-too-large');

      const queueCase = makeWriter(undefined, { maxQueuedBytes: override });
      const oneMiB = 'x'.repeat(PROTOCOL_STDOUT_MAX_EVENT_BYTES - 3);
      for (let i = 0; i < 4; i++) queueCase.writer.write(oneMiB);
      expect(queueCase.failures).toHaveLength(0);
      queueCase.writer.write(0);
      expect(queueCase.failures[0]?.kind).toBe('queue-overflow');

      const deadlineCase = makeWriter();
      deadlineCase.writer.write(0);
      const finalization = deadlineCase.writer.finalize(override);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(finalization).resolves.toBe('timed-out');
      expect(deadlineCase.stream.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps callback reentrancy FIFO and serial', () => {
    const stream = new ControllableWriteStream();
    stream.write = (chunk, callback) => {
      stream.writes.push(chunk);
      callback?.();
      return true;
    };
    const { writer, failures } = makeWriter(stream);
    writer.write({ sequence: 0 });
    writer.write({ sequence: 1 });
    expect(stream.writes).toEqual(['{"sequence":0}\n', '{"sequence":1}\n']);
    expect(failures).toEqual([]);
  });

  it.each(['callback-first', 'drain-first'] as const)('waits for callback and drain when backpressured (%s)', (order) => {
    const { stream, writer } = makeWriter();
    stream.nextReturn = false;
    writer.write({ sequence: 0 });
    writer.write({ sequence: 1 });
    expect(stream.writes).toHaveLength(1);
    if (order === 'callback-first') {
      stream.callback();
      expect(stream.writes).toHaveLength(1);
      stream.emit('drain');
    } else {
      stream.emit('drain');
      expect(stream.writes).toHaveLength(1);
      stream.callback();
    }
    expect(stream.writes).toEqual(['{"sequence":0}\n', '{"sequence":1}\n']);
  });

  it('counts UTF-8 bytes including the line feed', () => {
    const { stream, writer, failures } = makeWriter(undefined, { maxEventBytes: 7 });
    writer.write('😀'); // JSON is six bytes, plus LF is seven.
    expect(stream.writes).toEqual(['"😀"\n']);
    stream.callback();
    writer.write('😀😀');
    expect(failures[0]).toMatchObject({ kind: 'event-too-large' });
  });

  it('accepts an exactly 1 MiB UTF-8 JSON line at the default event limit', () => {
    const { stream, writer, failures } = makeWriter();
    writer.write(eventWithJsonLineBytes(PROTOCOL_STDOUT_MAX_EVENT_BYTES));
    expect(Buffer.byteLength(stream.writes[0]!, 'utf8')).toBe(PROTOCOL_STDOUT_MAX_EVENT_BYTES);
    expect(failures).toEqual([]);
  });

  it('accepts exactly 4 MiB across the active write and queued records', () => {
    const { writer, failures } = makeWriter();
    const event = eventWithJsonLineBytes(PROTOCOL_STDOUT_MAX_EVENT_BYTES);
    for (let index = 0; index < 4; index++) writer.write(event);
    expect(failures).toEqual([]);
  });

  it('fails when records totaling 4 MiB minus one byte receive a two-byte JSON line', () => {
    const { writer, failures } = makeWriter();
    const maxEvent = eventWithJsonLineBytes(PROTOCOL_STDOUT_MAX_EVENT_BYTES);
    for (let index = 0; index < 3; index++) writer.write(maxEvent);
    writer.write(eventWithJsonLineBytes(PROTOCOL_STDOUT_MAX_EVENT_BYTES - 1));
    writer.write(0); // JSON "0" plus LF is two bytes, exceeding the queue by one.
    expect(failures[0]).toMatchObject({ kind: 'queue-overflow' });
  });

  it('includes the blocked active write in the queue bound and latches overflow once', () => {
    const { stream, writer, failures } = makeWriter(undefined, { maxQueuedBytes: 16 });
    writer.write({ a: 1 }); // eight bytes including LF
    writer.write({ b: 2 }); // eight bytes including LF
    writer.write({ c: 3 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'queue-overflow' });
    expect(stream.writes).toHaveLength(1);
    stream.callback();
    expect(stream.writes).toHaveLength(1);
  });

  it('destroys a blocked stream on fatal overflow, retains its error guard, and finalizes failed', async () => {
    const { stream, writer, failures } = makeWriter(undefined, { maxQueuedBytes: 8 });
    writer.write({ a: 1 }); // eight bytes including LF; callback remains blocked
    writer.write({ b: 2 });
    expect(failures[0]?.kind).toBe('queue-overflow');
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(() => stream.emit('error', new Error('late error'))).not.toThrow();
    await expect(writer.finalize()).resolves.toBe('failed');
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    stream.emit('close');
    expect(stream.listenerCount('error')).toBe(0);
  });

  it.each(['callback', 'stream'] as const)('does not leak drain after a synchronous %s failure and false write result', (source) => {
    const stream = new ControllableWriteStream();
    stream.write = (chunk, callback) => {
      stream.writes.push(chunk);
      if (source === 'callback') callback?.(new Error('synchronous callback failure'));
      else stream.emit('error', new Error('synchronous stream failure'));
      return false;
    };
    const { writer, failures } = makeWriter(stream);
    writer.write({ sequence: 0 });
    expect(failures[0]?.kind).toBe(source === 'callback' ? 'callback' : 'stream');
    expect(stream.listenerCount('drain')).toBe(0);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });

  it('drains a large queued batch with synchronous callbacks without recursive pump growth', () => {
    const { stream, writer, failures } = makeWriter(undefined, { maxQueuedBytes: 1_000_000 });
    writer.write({ sequence: 0 }); // Hold the first write so subsequent writes queue.
    for (let sequence = 1; sequence <= 20_000; sequence++) writer.write({ sequence });
    stream.synchronousCallbacks = true;
    stream.callback();
    expect(stream.writes).toHaveLength(20_001);
    expect(failures).toEqual([]);
  });

  it('latches the first failure for serialization, write, callback and stream errors', () => {
    const { stream, writer, failures } = makeWriter();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    writer.write(cyclic);
    stream.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'serialize', code: 'RUN_STDOUT_TRANSPORT_FAILED' });

    const writeFailure = makeWriter();
    writeFailure.stream.throwOnWrite = new Error('write failure');
    writeFailure.writer.write({ x: 1 });
    expect(writeFailure.failures[0]?.kind).toBe('write');

    const callbackFailure = makeWriter();
    callbackFailure.writer.write({ x: 1 });
    callbackFailure.stream.callback(0, new Error('callback failure'));
    expect(callbackFailure.failures[0]?.kind).toBe('callback');

    const streamFailure = makeWriter();
    streamFailure.stream.emit('error', Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    expect(streamFailure.failures[0]?.kind).toBe('stream');
  });

  it('normalizes a hostile non-Error stream failure without throwing', () => {
    const { stream, failures } = makeWriter();
    const hostile = { toString: () => { throw new Error('hostile toString'); } };
    expect(() => stream.emit('error', hostile)).not.toThrow();
    expect(failures[0]).toMatchObject({ kind: 'stream', cause: { message: 'unknown stdout transport error' } });
  });

  it.each(['EPIPE', 'ENOSPC', 'EIO'])('preserves first stream-error code %s', (code) => {
    const { stream, failures } = makeWriter();
    const error = Object.assign(new Error(code), { code });
    stream.emit('error', error);
    expect(failures[0]).toMatchObject({ kind: 'stream', cause: error });
    expect(failures[0]?.cause).toBe(error);
  });

  it('does not let an onFailure exception escape the synchronous sink', () => {
    const stream = new ControllableWriteStream();
    const writer = createProtocolStdoutWriter({
      stream: asStream(stream),
      onFailure: () => {
        throw new Error('cancellation owner failed');
      },
      maxEventBytes: 1,
    });
    expect(() => writer.write({ x: 1 })).not.toThrow();
    expect(writer.failure?.kind).toBe('event-too-large');
  });

  it.each([undefined, () => {}, Symbol('event')])('treats non-JSON values as serialization failures', (value) => {
    const { stream, writer, failures } = makeWriter();
    expect(() => writer.write(value)).not.toThrow();
    expect(failures[0]?.kind).toBe('serialize');
    expect(stream.writes).toEqual([]);
  });

  it('uses one finalization deadline, destroys stdout, and retains the error guard until close', async () => {
    vi.useFakeTimers();
    const { stream, writer, failures } = makeWriter();
    writer.write({ sequence: 0 });
    const finalization = writer.finalize(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(finalization).resolves.toBe('timed-out');
    expect(failures[0]?.kind).toBe('drain-timeout');
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    const beforeClose = failures.length;
    stream.emit('error', new Error('late error'));
    expect(failures).toHaveLength(beforeClose);
    stream.emit('close');
    expect(stream.listenerCount('error')).toBe(0);
  });

  it('removes guards only after a healthy write has settled', async () => {
    const { stream, writer } = makeWriter();
    const baselineErrorListeners = stream.listenerCount('error') - 1;
    writer.write({ sequence: 0 });
    const finalization = writer.finalize();
    expect(stream.listenerCount('error')).toBe(baselineErrorListeners + 1);
    stream.callback();
    await expect(finalization).resolves.toBe('flushed');
    expect(stream.listenerCount('error')).toBe(baselineErrorListeners);
  });

  it('captures an error queued after a write callback before healthy cleanup', async () => {
    const stream = new ControllableWriteStream();
    stream.write = (chunk, callback) => {
      stream.writes.push(chunk);
      callback?.();
      setImmediate(() => stream.emit('error', new Error('late callback error')));
      return true;
    };
    const { writer, failures } = makeWriter(stream);
    writer.write({ sequence: 0 });
    await expect(writer.finalize()).resolves.toBe('failed');
    expect(failures[0]?.kind).toBe('stream');
  });

  it('treats an idle close before the first write as transport failure', async () => {
    const { stream, writer, failures } = makeWriter();
    stream.emit('close');
    writer.write({ sequence: 0 });
    await expect(writer.finalize()).resolves.toBe('failed');
    expect(failures[0]?.kind).toBe('stream');
    expect(stream.writes).toEqual([]);
  });

  it('treats a close between otherwise healthy writes as transport failure', async () => {
    const { stream, writer, failures } = makeWriter();
    writer.write({ sequence: 0 });
    stream.callback();
    stream.emit('close');
    writer.write({ sequence: 1 });
    await expect(writer.finalize()).resolves.toBe('failed');
    expect(failures[0]?.kind).toBe('stream');
    expect(stream.writes).toEqual(['{"sequence":0}\n']);
  });

  it('releases finalization on a stream error without inventing a terminal event', async () => {
    const { stream, writer, failures } = makeWriter();
    writer.write({ sequence: 0 });
    const finalization = writer.finalize();
    stream.emit('error', new Error('EIO'));
    await expect(finalization).resolves.toBe('failed');
    expect(failures[0]?.kind).toBe('stream');
  });

  it('shares one finalization promise and deadline across repeated calls', async () => {
    vi.useFakeTimers();
    const { stream, writer } = makeWriter();
    writer.write({ sequence: 0 });
    const first = writer.finalize(5_000);
    const second = writer.finalize(1);
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    await expect(first).resolves.toBe('timed-out');
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not permit an event above the protocol maximum', () => {
    const { writer, failures } = makeWriter();
    writer.write({ payload: 'x'.repeat(PROTOCOL_STDOUT_MAX_EVENT_BYTES) });
    expect(failures[0]?.kind).toBe('event-too-large');
  });
});
