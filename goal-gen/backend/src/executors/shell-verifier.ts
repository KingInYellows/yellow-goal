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
      // `detached: true` places the child in its own process group so we can
      // kill the full tree (group kill via negative pid) on timeout or abort —
      // not just the immediate shell child (POSIX SIGKILL to -pgid).
      const child = spawn(command, {
        cwd: ctx.worktreePath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        detached: true,
      });
      // Prevent the child from keeping our event loop alive if we kill it early.
      child.unref();

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on('data', (d: Buffer) => out.push(d));
      child.stderr?.on('data', (d: Buffer) => err.push(d));

      /** Kill the full process group: SIGTERM first, then SIGKILL after grace. */
      const killGroup = (): void => {
        if (child.pid == null) return;
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
        sigkillTimer = setTimeout(() => {
          if (child.pid == null) return;
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
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

      const finish = (exitCode: number): void => {
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve({ exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      };
      // ENOENT / shell launch failure → a non-zero exit so verify FAILS (never a silent pass).
      child.on('error', () => finish(127 /* command not found */));
      child.on('close', (code) => finish(killed ? 124 /* timeout */ : (code ?? -1)));
    });
  }
}
