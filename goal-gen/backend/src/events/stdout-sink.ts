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
 */
export function createStdoutSink(stream: NodeJS.WritableStream = process.stdout): (envelope: unknown) => void {
  let broken = false;
  stream.on('error', (err: NodeJS.ErrnoException) => {
    broken = true;
    // EPIPE is the expected, benign case (the reader went away); anything else is worth a line
    // on stderr, which is never the protocol stream.
    if (err.code !== 'EPIPE') {
      process.stderr.write(`[run-event] stdout error: ${err.message}\n`);
    }
  });
  return (envelope: unknown): void => {
    if (broken) return;
    stream.write(`${JSON.stringify(envelope)}\n`);
  };
}
