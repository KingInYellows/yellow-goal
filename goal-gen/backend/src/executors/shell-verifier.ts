/**
 * Real `Verifier`: runs an action's `verify.command` in the run's worktree and returns its exit
 * code — the ONLY signal that gates pass/fail and the replan trigger (plan §"Two distinct oracles").
 * The orchestrator pairs it with the activity oracle (executor-side), which only sets `diffRef`.
 *
 * The command runs through the shell (`shell: true`) so LLM-authored verify checks (`grep`, `&&`,
 * pipes, `test -f`) work as written. It executes arbitrary commands in the worktree — in v1 the host
 * is the blast radius (ADR-0009), and the operator sees every verify command at the confirm-DoD gate
 * before anything runs. (The deterministic test double is `StubVerifier` in `stub-executor.ts`.)
 */
import { spawn } from 'node:child_process';
import type { RunContext, Verifier, VerifyResult } from '../types';

const VERIFY_TIMEOUT_MS = 120_000;
const SIGKILL_GRACE_MS = 5_000;

export class ShellVerifier implements Verifier {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = VERIFY_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  run(command: string, ctx: RunContext): Promise<VerifyResult> {
    return new Promise((resolve) => {
      // Already-cancelled before we start: an 'abort' listener would never fire for an event that
      // already happened, so honour cancellation up front and never launch the verify command.
      if (ctx.signal.aborted) {
        resolve({ exitCode: 124 /* cancelled */, stdout: '', stderr: 'verify cancelled before start (signal already aborted)' });
        return;
      }
      // `detached: true` places the child in its own process group so we can
      // kill the full tree (group kill via negative pid) on timeout or abort —
      // not just the immediate shell child (POSIX SIGKILL to -pgid).
      // Wrap spawn so a synchronous throw (bad cwd, etc.) resolves as a verify FAILURE
      // instead of escaping as an unhandled exception — never throws, per the Verifier contract.
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, {
          cwd: ctx.worktreePath,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
          detached: true,
        });
      } catch (spawnErr) {
        const message = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        resolve({ exitCode: 127 /* command not found */, stdout: '', stderr: `verify spawn error: ${message}` });
        return;
      }
      // Prevent the child from keeping our event loop alive if we kill it early.
      child.unref();

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on('data', (d: Buffer) => out.push(d));
      child.stderr?.on('data', (d: Buffer) => err.push(d));

      /** Kill the full process group: SIGTERM first, then SIGKILL after grace. */
      const killGroup = (): void => {
        const pgid = child.pid;
        if (pgid == null) return;
        if (sigkillTimer) return; // already terminating — don't re-send SIGTERM or arm a second SIGKILL timer
        try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
        sigkillTimer = setTimeout(() => {
          try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
        }, SIGKILL_GRACE_MS);
      };

      let killed = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

      const timer = setTimeout(() => {
        killed = true;
        killGroup();
      }, this.timeoutMs);

      // Propagate orchestrator abort to the verify child so it doesn't become orphaned.
      const onAbort = (): void => {
        killed = true;
        killGroup();
      };
      ctx.signal.addEventListener('abort', onAbort);

      let settled = false;
      const finish = (exitCode: number, extraStderr?: string): void => {
        if (settled) return; // 'error' and 'close' can both fire (e.g. ENOENT); honour the first result only
        settled = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        const stderr = Buffer.concat(err).toString('utf8') + (extraStderr ?? '');
        resolve({ exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr });
      };
      // ENOENT / shell launch failure → a non-zero exit so verify FAILS (never a silent pass).
      // Surface the OS error reason — otherwise the 'error' event's message is lost from the evidence.
      child.on('error', (e: Error) => finish(127 /* command not found */, `verify spawn error: ${e.message}`));
      child.on('close', (code) => finish(killed ? 124 /* timeout */ : (code ?? -1)));
    });
  }
}
