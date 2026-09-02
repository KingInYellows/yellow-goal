/**
 * Stream-level run-event/v1 sink, shared by both protocol entry points (the M1 runner and the
 * `run` verb) so neither has to re-derive broken-pipe handling.
 *
 * Node reports a broken pipe (EPIPE — e.g. stdout piped to `head`, or a disconnected reader)
 * asynchronously via the stream's 'error' event, not as a throw from `write()`; left unlistened,
 * Node's default is to throw and kill the process before the terminal `run.summary` envelope can
 * be produced, and the emitter's synchronous try/catch (run-event-emitter.ts) never sees it
 * either. Handled once here, at the stream boundary: after any stream error the sink degrades
 * quietly (drops further writes) rather than retrying a pipe that cannot un-close.
 *
 * EPIPE is benign (the reader went away). Any OTHER stream error (ENOSPC on a redirected file,
 * EIO, …) means envelopes — possibly the terminal `run.summary` — were lost while the run itself
 * may have succeeded; the sink records it as `transportError` and the entry point turns that into
 * a structured stderr envelope + exit 1 instead of a silently truncated stream with exit 0.
 * Nothing is written to stderr from here: stderr is reserved for the single-line JSON envelope.
 */
export interface StdoutSink {
  (envelope: unknown): void;
  /** The first non-EPIPE stream error, if any — envelopes after it were dropped. */
  readonly transportError: NodeJS.ErrnoException | undefined;
  /** Detach the stream 'error' listener. In-process callers that create a sink per run (tests,
   *  an embedded CLI) must call this so listeners don't accumulate on `process.stdout`. */
  dispose(): void;
}

export function createStdoutSink(stream: NodeJS.WritableStream = process.stdout): StdoutSink {
  let broken = false;
  let transportError: NodeJS.ErrnoException | undefined;
  const onError = (err: NodeJS.ErrnoException): void => {
    broken = true;
    if (err.code !== 'EPIPE' && transportError === undefined) transportError = err;
  };
  stream.on('error', onError);
  const sink = ((envelope: unknown): void => {
    if (broken) return;
    stream.write(`${JSON.stringify(envelope)}\n`);
  }) as StdoutSink;
  Object.defineProperty(sink, 'transportError', { get: () => transportError, enumerable: true });
  sink.dispose = () => {
    stream.off('error', onError);
  };
  return sink;
}

/** RR11 stderr envelope for a lost-output run — shared by both entry points. */
export function transportFailureEnvelope(err: NodeJS.ErrnoException): { error: { code: string; message: string } } {
  return {
    error: {
      code: 'RUN_STDOUT_TRANSPORT_FAILED',
      message: `stdout transport failed (${err.code ?? 'unknown'}): ${err.message} — run-event stream truncated; treat the run as failed`,
    },
  };
}
