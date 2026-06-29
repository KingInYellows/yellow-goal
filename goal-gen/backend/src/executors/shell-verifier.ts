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
      const child = spawn(command, {
        cwd: ctx.worktreePath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on('data', (d: Buffer) => out.push(d));
      child.stderr?.on('data', (d: Buffer) => err.push(d));
      let killed = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        sigkillTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
      }, this.timeoutMs);
      const finish = (exitCode: number): void => {
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        resolve({ exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      };
      // ENOENT / shell launch failure → a non-zero exit so verify FAILS (never a silent pass).
      child.on('error', () => finish(127 /* command not found */));
      child.on('close', (code) => finish(killed ? 124 /* timeout */ : (code ?? -1)));
    });
  }
}
