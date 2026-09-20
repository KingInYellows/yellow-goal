import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const OBSERVER_OUTPUT_LIMIT = 64 * 1024;
export const RECORDER_OUTPUT_LIMIT = 1024 * 1024;
export const SIGKILL_GRACE_MS = 250;
export const STARTUP_READY_MS = 15_000;
export const OBSERVER_READY_ENV = 'GOAL_GEN_OBSERVER_READY';

const supportsProcessGroup = process.platform !== 'win32';

export type ReadyWaitWhy = 'ready' | 'done' | 'timeout';
export type ReadyTickWhy = ReadyWaitWhy | 'continue';

/**
 * One poll of the readiness handshake. Elapsed budget wins over a marker that
 * is first observed after the deadline: a delayed parent tick must not treat a
 * late file as `ready` and arm a fresh behavioral timeout.
 */
export function classifyReadyTick(input: {
  readyPresent: boolean;
  done: boolean;
  elapsedMs: number;
  budgetMs: number;
}): ReadyTickWhy {
  if (input.elapsedMs >= input.budgetMs) return 'timeout';
  if (input.readyPresent) return 'ready';
  if (input.done) return 'done';
  return 'continue';
}

/**
 * Latch `waitForReadyFile`'s result. A timeout must not be re-derived from a
 * later ready marker: that would drop `readiness-failed` and surface the kill
 * as an ordinary signal. A timeout is not a post-ready execution deadline.
 */
export function interpretReadyWait(
  why: ReadyWaitWhy,
  readyFilePresent: boolean,
): 'arm-timeout' | 'readiness-failed' {
  if (why === 'timeout') return 'readiness-failed';
  if (why === 'ready' || (why === 'done' && readyFilePresent)) return 'arm-timeout';
  return 'readiness-failed';
}

export type BoundedRun = {
  exitStatus?: number;
  signal?: string;
  timedOut: boolean;
  readyFailed?: boolean;
  aborted?: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  spawnError?: string;
};

function attachBoundedReader(
  stream: NodeJS.ReadableStream | null,
  limit: number,
): { text: () => string; truncated: () => boolean } {
  let buf = '';
  let collectedBytes = 0;
  let truncated = false;
  const decoder = new StringDecoder('utf8');
  let decoderEnded = false;
  const appendDecoded = (next: string) => {
    if (next.length === 0) return;
    buf += next;
  };
  const finishDecoder = () => {
    if (decoderEnded) return;
    decoderEnded = true;
    appendDecoded(decoder.end());
  };
  const consume = (chunk: Buffer) => {
    if (truncated) return;
    const room = limit - collectedBytes;
    if (chunk.length > room) {
      if (room > 0) {
        collectedBytes += room;
        appendDecoded(decoder.write(chunk.subarray(0, Math.max(0, room))));
      }
      truncated = true;
      finishDecoder();
      if (stream !== null && 'destroy' in stream && typeof stream.destroy === 'function') {
        try {
          stream.destroy();
        } catch {
          /* already closed */
        }
      }
      return;
    }
    collectedBytes += chunk.length;
    appendDecoded(decoder.write(chunk));
  };
  stream?.on('data', (chunk: Buffer | string) => {
    consume(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  });
  stream?.on('error', () => {
    /* destroyed or aborted stream */
  });
  stream?.on('end', finishDecoder);
  return {
    text: () => {
      finishDecoder();
      return buf;
    },
    truncated: () => truncated,
  };
}

function waitForReadyFile(
  readyPath: string,
  isDone: () => boolean,
  budgetMs: number,
  onTimeout?: () => void,
): Promise<ReadyWaitWhy> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const why = classifyReadyTick({
        readyPresent: existsSync(readyPath),
        done: isDone(),
        elapsedMs: Date.now() - started,
        budgetMs,
      });
      if (why === 'continue') {
        setTimeout(tick, 5);
        return;
      }
      if (why === 'timeout') onTimeout?.();
      resolve(why);
    };
    tick();
  });
}

function pidsInProcessGroup(pgid: number): number[] {
  if (process.platform !== 'linux') return [];
  const pids: number[] = [];
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === pgid) continue;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      } catch {
        continue;
      }
      const after = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
      if (Number(after[2]) === pgid) pids.push(pid);
    }
  } catch {
    /* proc not available */
  }
  return pids;
}

function killOwnedTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const members = pidsInProcessGroup(pid);
  if (supportsProcessGroup) {
    try {
      process.kill(-pid, signal);
    } catch {
      /* group gone or not a leader */
    }
  }
  for (const member of members) {
    try {
      process.kill(member, signal);
    } catch {
      /* already gone */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* process already gone */
  }
}

function destroyPipes(child: ReturnType<typeof spawn>): void {
  try {
    child.stdout?.destroy();
  } catch {
    /* already closed */
  }
  try {
    child.stderr?.destroy();
  } catch {
    /* already closed */
  }
}

export function runBoundedArgv(input: {
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  outputLimit: number;
  readyPath?: string;
  startupReadyMs?: number;
  signal?: AbortSignal;
}): Promise<BoundedRun> {
  return new Promise((resolve) => {
    if (input.signal?.aborted) {
      resolve({
        timedOut: false,
        aborted: true,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        spawnError: 'aborted before spawn',
      });
      return;
    }
    if (input.argv.length === 0) {
      resolve({
        timedOut: false,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        spawnError: 'empty argv',
      });
      return;
    }
    const env =
      input.readyPath === undefined
        ? input.env
        : { ...input.env, [OBSERVER_READY_ENV]: input.readyPath };
    const child = spawn(input.argv[0]!, input.argv.slice(1), {
      cwd: input.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: supportsProcessGroup,
    });
    const stdout = attachBoundedReader(child.stdout, input.outputLimit);
    const stderr = attachBoundedReader(child.stderr, input.outputLimit);
    let finished = false;
    let timedOut = false;
    let readyFailed = false;
    let readinessBudgetExpired = false;
    let aborted = false;
    let spawnError: string | undefined;
    let closeSeen = false;
    let processExited = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const missingReadyFile = (): boolean =>
      input.readyPath !== undefined && !existsSync(input.readyPath);
    const finish = (run: BoundedRun) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (onAbort !== undefined) input.signal?.removeEventListener('abort', onAbort);
      killOwnedTree(child, 'SIGKILL');
      destroyPipes(child);
      resolve(run);
    };
    const escalateKill = () => {
      if (finished || killTimer !== undefined) return;
      killOwnedTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (finished) return;
        killOwnedTree(child, 'SIGKILL');
        destroyPipes(child);
      }, SIGKILL_GRACE_MS);
    };
    const armTimeout = () => {
      if (finished || timer !== undefined) return;
      timer = setTimeout(() => {
        timedOut = true;
        escalateKill();
      }, input.timeoutMs);
    };
    const onAbort = () => {
      if (finished) return;
      aborted = true;
      escalateKill();
    };
    input.signal?.addEventListener('abort', onAbort);
    if (input.readyPath !== undefined) {
      void waitForReadyFile(
        input.readyPath,
        () => finished || spawnError !== undefined || processExited,
        input.startupReadyMs ?? STARTUP_READY_MS,
        () => {
          readinessBudgetExpired = true;
          readyFailed = true;
        },
      ).then((why) => {
        if (finished) return;
        if (why === 'timeout') {
          readyFailed = true;
          escalateKill();
          return;
        }
        if (interpretReadyWait(why, !missingReadyFile()) === 'arm-timeout') {
          armTimeout();
          return;
        }
        readyFailed = true;
        escalateKill();
      });
    } else {
      armTimeout();
    }
    child.on('exit', () => {
      processExited = true;
      if (finished || spawnError !== undefined) return;
      if (readinessBudgetExpired) readyFailed = true;
      if (missingReadyFile()) {
        readyFailed = true;
        escalateKill();
      }
    });
    child.on('error', (err) => {
      spawnError = err instanceof Error ? err.message : String(err);
      setImmediate(() => {
        if (!finished && !closeSeen) {
          finish({
            timedOut,
            readyFailed: readyFailed || undefined,
            aborted: aborted || undefined,
            stdout: stdout.text(),
            stderr: stderr.text(),
            stdoutTruncated: stdout.truncated(),
            stderrTruncated: stderr.truncated(),
            spawnError,
          });
        }
      });
    });
    child.on('close', (code, signal) => {
      closeSeen = true;
      if (readinessBudgetExpired || missingReadyFile()) readyFailed = true;
      const result: BoundedRun = {
        timedOut,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
      };
      if (readyFailed) result.readyFailed = true;
      if (aborted) result.aborted = true;
      if (spawnError !== undefined) result.spawnError = spawnError;
      if (signal) result.signal = signal;
      else if (code !== null) result.exitStatus = code;
      finish(result);
    });
  });
}

export function observerToolPath(): string {
  const dirs: string[] = [path.dirname(process.execPath)];
  const git = locateOnHostPath('git');
  if (git !== undefined) dirs.push(path.dirname(git));
  dirs.push('/usr/bin', '/bin');
  return [...new Set(dirs)].join(path.delimiter);
}

function locateOnHostPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
