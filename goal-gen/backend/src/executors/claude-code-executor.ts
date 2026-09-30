/**
 * `claude-code` executor adapter (v1's only executor — `.claude/specs/executor-router.md`).
 * Promoted from the de-risk spike: spawns headless `claude -p --output-format json` in the run's
 * worktree, captures the real result, and reads ground truth from the worktree (CLAUDE.md #2).
 *
 * Two oracles, never conflated (plan §"Two distinct oracles"):
 *  - The **activity oracle** here (`git status --porcelain` non-empty after noise-filtering OR a
 *    moved HEAD) only answers "did the agent change anything" → populates `AgentRun.diffRef`.
 *  - The **verify oracle** (an action's `verify.command` exit code, run by the orchestrator) is the
 *    ONLY thing that gates pass/fail. This module never touches verify.
 *
 * Ground truth MUST use porcelain/HEAD, never `git diff <sha>` — the agent creates NEW UNTRACKED
 * files and `git diff` misses them entirely (spike §5, the headline de-risking result). Every git
 * call runs through `pinnedGit` (fsmonitor and hooks off), because the agent writes the worktree.
 *
 * With `realRun` set (ADR-0020, built only by `createRealRunExecutor`) the executor is the
 * approval-gated worker: mode fixed to acceptEdits, prompt on stdin, `--tools` limited to the
 * approved filesystem tools, engine deny rules and pinned config, pre-spawn refusals, and every
 * failure classified (`AgentRun.failureClass`).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RunApprovalError } from '../cli/errors';
import { ACTION_TIMEOUT_MS, DEFAULT_MODEL, DEFAULT_NOISE_FILTER_PATHS, MAX_BUDGET_USD } from '../orchestrator/guardrails';
import type { Action, ExecutorKind } from '../planner/types';
import type { AgentRun, AgentRunFailureClass, AgentRunStatus, Executor, RunContext } from '../types';
import {
  allowedToolNames,
  assertAuthModeMatchesEnv,
  assertFilesystemToolsConfined,
  REAL_RUN_CONTROL_NAMES,
  resolveRealRunPermissionMode,
  type RealRunAuthMode,
  WRITE_TOOLS,
} from './real-run-guards';
import { GIT_ENV, type GitResult, parsePorcelainPaths, pinnedGit } from './worktree';

/** SIGKILL escalation grace after SIGTERM on cancel/timeout (plan task 2.5). */
const SIGKILL_GRACE_MS = 5_000;
/** How often, and for how long at most, a real run polls for its worker's process group to be gone. */
const GROUP_POLL_MS = 25;
const GROUP_GONE_TIMEOUT_MS = 5_000;
/** How often a live real-run worker's descendants are snapshotted (see `DescendantTracker`). */
const DESCENDANT_SNAPSHOT_MS = 200;
/** Real runs keep at most this much worker stdout (the result envelope is a few KiB); more is malformed. */
const REAL_RUN_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
/** Real runs keep only this rolling tail of worker stderr. */
const REAL_RUN_STDERR_TAIL_BYTES = 64 * 1024;
const DEFAULT_MAX_TURNS = 10;

/**
 * Permission handling is FAIL-CLOSED (guidance invariant: "unknown permission profile must be
 * rejected"; never fall back to a bypass-style mode).
 *
 * - The HOST configures the run's mode explicitly via `ClaudeCodeExecutorOptions.permissionMode`;
 *   an unknown configured value throws at construction. `bypassPermissions` is never a default —
 *   a call site that wants it must say so (ADR-0009 blast-radius posture is a host decision).
 * - An LLM-authored action payload may only *narrow* the mode: it can request a mode from
 *   `ACTION_REQUESTABLE_MODES` that is no more permissive than the configured mode. An absent
 *   payload mode uses the configured mode; an unknown payload mode or an escalation attempt fails
 *   the action closed (no spawn) instead of being coerced to anything executable.
 *
 * Mode names revalidated against `claude --help` (2026-08-22): the CLI accepts acceptEdits, auto,
 * bypassPermissions, manual, dontAsk, plan. Only the three below are meaningful for headless runs.
 */
export type ClaudePermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions';
const VALID_PERMISSION_MODES: ReadonlySet<string> = new Set(['plan', 'acceptEdits', 'bypassPermissions']);
/** Modes an action payload may request. `bypassPermissions` is deliberately absent: only explicit
 *  host configuration may select it, never LLM-authored content. */
const ACTION_REQUESTABLE_MODES: ReadonlySet<string> = new Set(['plan', 'acceptEdits']);
/** Permissiveness order for the narrowing rule (lower = stricter). */
const MODE_RANK: Readonly<Record<ClaudePermissionMode, number>> = {
  plan: 0,
  acceptEdits: 1,
  bypassPermissions: 2,
};

/**
 * The `--output-format json` result envelope, validated defensively. The real shape has ~20
 * top-level keys (spike §2); `.passthrough()` keeps the unknown ones, and only the fields we read
 * are declared — all optional where the error variant may omit them. `subtype` is an open string.
 */
const ResultEnvelope = z
  .object({
    type: z.literal('result'),
    subtype: z.string(),
    is_error: z.boolean(),
    result: z.string().optional(),
    error: z.string().optional(),
    session_id: z.string().optional(),
    num_turns: z.number().optional(),
    duration_ms: z.number().optional(),
    // A negative cost is not a meter reading: it fails parsing and ends as malformed output.
    total_cost_usd: z.number().finite().nonnegative().optional(),
    // Recorded on the success envelope (spike §2); read to classify real-run failures.
    permission_denials: z.array(z.unknown()).optional(),
    terminal_reason: z.string().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
type ResultEnvelope = z.infer<typeof ResultEnvelope>;

type KillReason = 'none' | 'timeout' | 'cancel' | 'spawn-error';

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  killReason: KillReason;
  spawnErrorMessage?: string;
  /** Real runs: stdout exceeded `REAL_RUN_STDOUT_MAX_BYTES` and was cut off. */
  stdoutTruncated?: boolean;
  /** Real runs: a process of the worker's group was still present after SIGKILL and the bounded wait. */
  processGroupSurvived?: boolean;
}

/**
 * The worker process to spawn: `file` plus leading `args`, followed by the claude argv. Settable
 * only through the executor constructor (AGX-R15) — never from environment variables or argv.
 */
export interface WorkerCommand {
  file: string;
  args: readonly string[];
}

const DEFAULT_WORKER_COMMAND: WorkerCommand = { file: 'claude', args: [] };

/**
 * The worker child's environment, built at spawn time. `GIT_ENV` is a snapshot taken at module
 * load, so a real run builds a fresh copy: the AGX-R13 auth guard must check the exact
 * environment the worker receives.
 */
function workerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  // An empty key is "no key" to the auth guard; do not hand the CLI an ambiguous empty value.
  if (env.ANTHROPIC_API_KEY === '') delete env.ANTHROPIC_API_KEY;
  return env;
}

/** What the executor reads of `/proc/<pid>/stat` (Linux only). */
interface ProcStat {
  state: string;
  ppid: number;
  pgrp: number;
  /** Field 22: clock ticks since boot at process start; with the pid it identifies a process. */
  start: string;
}

const PROC_AVAILABLE = existsSync('/proc/self/stat');

/**
 * Parse `/proc/<pid>/stat`. `comm` (field 2) may contain spaces and parentheses, so the remaining
 * fields are read after the LAST ')'. Undefined when the process is gone or unreadable.
 */
function readProcStat(pid: number): ProcStat | undefined {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  const close = text.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = text.slice(close + 2).split(' ');
  const [state, ppid, pgrp] = [fields[0], Number(fields[1]), Number(fields[2])];
  const start = fields[19];
  if (state === undefined || start === undefined || !Number.isInteger(ppid) || !Number.isInteger(pgrp)) return undefined;
  return { state, ppid, pgrp, start };
}

/** A zombie (`Z`) or dead (`X`) process can no longer execute or write anything. */
function isLiveState(state: string): boolean {
  return state !== 'Z' && state !== 'X';
}

function listProcPids(): number[] {
  try {
    return readdirSync('/proc')
      .filter((name) => /^[0-9]+$/.test(name))
      .map(Number);
  } catch {
    return [];
  }
}

/**
 * Whether process group `pgid` still has a LIVE member. A group holding only zombies (orphans
 * whose reaper is slow) does not count: they cannot run. Without `/proc`, falls back to
 * `kill(-pgid, 0)`, where EPERM means a member exists but is not ours.
 */
function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (!PROC_AVAILABLE) return true;
  for (const pid of listProcPids()) {
    const stat = readProcStat(pid);
    if (stat !== undefined && stat.pgrp === pgid && isLiveState(stat.state)) return true;
  }
  return false;
}

/**
 * Tracks the descendants of one worker, including ones that leave its process group or session,
 * which group signals cannot reach. Snapshots walk `/proc` ppid links from the worker pid while it
 * is alive (once it exits its children are reparented and the link is lost), and every process
 * records its start time so a reused pid is never signalled. A per-run token in the worker's
 * environment (inherited by descendants) additionally finds ones missed between snapshots.
 * Best effort: cgroup/container isolation is the real containment. No-op without `/proc`.
 */
class DescendantTracker {
  private readonly known = new Map<number, string>();
  /** The worker's own start time: once it is reaped its pid may belong to an unrelated process. */
  private readonly rootStart: string | undefined;
  constructor(
    private readonly rootPid: number,
    private readonly envToken: string,
  ) {
    // The tracker is built right after spawn, while the worker is alive and visible in /proc.
    if (PROC_AVAILABLE) this.rootStart = readProcStat(rootPid)?.start;
  }

  snapshot(): void {
    if (!PROC_AVAILABLE) return;
    const children = new Map<number, number[]>();
    const stats = new Map<number, ProcStat>();
    for (const pid of listProcPids()) {
      const stat = readProcStat(pid);
      if (stat === undefined) continue;
      stats.set(pid, stat);
      const siblings = children.get(stat.ppid);
      if (siblings) siblings.push(pid);
      else children.set(stat.ppid, [pid]);
    }
    // Never walk from a pid that no longer identifies the worker (reaped, possibly reused). An
    // unreadable start time at construction fails closed: scanEnvironments() still covers descendants.
    const root = stats.get(this.rootPid);
    if (this.rootStart === undefined || root === undefined || root.start !== this.rootStart) return;
    const queue = [this.rootPid];
    while (queue.length > 0) {
      for (const pid of children.get(queue.pop()!) ?? []) {
        const stat = stats.get(pid)!;
        if (isLiveState(stat.state)) this.known.set(pid, stat.start);
        queue.push(pid);
      }
    }
  }

  /** Adds every live process whose environment carries this run's token (same-user only). */
  private scanEnvironments(): void {
    const needle = Buffer.from(`YELLOW_GOAL_WORKER_TOKEN=${this.envToken}`);
    for (const pid of listProcPids()) {
      if (pid === process.pid || this.known.has(pid)) continue;
      try {
        if (!readFileSync(`/proc/${pid}/environ`).includes(needle)) continue;
      } catch {
        continue;
      }
      const stat = readProcStat(pid);
      if (stat !== undefined && isLiveState(stat.state)) this.known.set(pid, stat.start);
    }
  }

  /** SIGKILLs every recorded descendant still alive with its recorded start time; true if any is. */
  sweep(): boolean {
    if (!PROC_AVAILABLE) return false;
    this.snapshot();
    this.scanEnvironments();
    let anyAlive = false;
    for (const [pid, start] of this.known) {
      const stat = readProcStat(pid);
      if (stat === undefined || stat.start !== start || !isLiveState(stat.state)) continue;
      anyAlive = true;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    return anyAlive;
  }
}

/**
 * Worker process groups still running. If the engine process exits while one is live (an
 * uncaught error, `process.exit`), the exit hook SIGKILLs it, so a real worker never outlives the
 * engine to keep spending. Death by an unhandled signal skips exit hooks; the engine maps the
 * termination signals onto its abort signal for the attempt instead.
 */
const liveWorkerGroups = new Set<number>();
let workerExitHookInstalled = false;

function trackWorkerGroup(pgid: number): void {
  if (!workerExitHookInstalled) {
    process.on('exit', () => {
      for (const group of liveWorkerGroups) signalProcessGroup(group, 'SIGKILL');
    });
    workerExitHookInstalled = true;
  }
  liveWorkerGroups.add(pgid);
}

function signalProcessGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // ESRCH: the group is already gone.
  }
}

/**
 * Polls until process group `pgid` has no live member and every tracked descendant is dead
 * (re-killing stragglers each poll), bounded by `GROUP_GONE_TIMEOUT_MS`; true once gone.
 */
async function waitForProcessGroupGone(pgid: number, tracker: DescendantTracker): Promise<boolean> {
  const deadline = Date.now() + GROUP_GONE_TIMEOUT_MS;
  while (processGroupAlive(pgid) || tracker.sweep()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
  return true;
}

/**
 * Spawn the worker and resolve on the `close` event (all stdio flushed — NOT `exit`). Honors
 * cancellation via `signal` and a per-action timeout, both escalating SIGTERM → SIGKILL after a
 * grace period. Never rejects — a spawn error resolves with `killReason: 'spawn-error'`.
 *
 * With `processGroup` (real runs, AGX-R14) the worker leads its own process group: every signal
 * goes to the whole group, so a descendant that ignores SIGTERM is still killed, and once the
 * worker exits any descendant it left behind is killed at once. Zombie-only groups count as gone.
 * A descendant that leaves the group (a new session) is out of signal reach, so, while the worker
 * lives, its descendants are snapshotted (every ~200 ms and on output, via /proc ppid links with
 * start times against pid reuse, plus an environment token inherited by descendants) and, after
 * the worker exits, each one still alive is SIGKILLed. This is best effort: a descendant that
 * escapes and re-parents between snapshots and scrubs its environment is missed, so cgroup or
 * container isolation is the real containment. The promise resolves only after the group and
 * all tracked descendants are gone, or with `processGroupSurvived` when the bounded wait gives up.
 * Output is bounded too: stdout is capped and stderr keeps a rolling tail.
 */
function spawnClaude(
  command: WorkerCommand,
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
  stdinText?: string,
  processGroup = false,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const envToken = randomBytes(16).toString('hex');
    if (processGroup) env = { ...env, YELLOW_GOAL_WORKER_TOKEN: envToken };
    // Fix 2: wrap spawn so a synchronous throw (bad cwd, ENOENT, etc.) resolves as spawn-error
    // rather than rejecting or escaping as an unhandled exception.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.file, [...command.args, ...argv], {
        cwd,
        env,
        stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: processGroup,
      });
      if (stdinText !== undefined) {
        // A worker that exits without reading stdin must not crash the engine with EPIPE.
        child.stdin?.on('error', () => {});
        child.stdin?.end(stdinText);
      }
    } catch (spawnErr) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        killReason: 'spawn-error',
        spawnErrorMessage: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
      });
      return;
    }

    let out: Buffer[] = [];
    let err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let stdoutTruncated = false;
    child.stdout?.on('data', (d: Buffer) => {
      if (processGroup && outBytes + d.length > REAL_RUN_STDOUT_MAX_BYTES) {
        stdoutTruncated = true;
        return;
      }
      outBytes += d.length;
      out.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      err.push(d);
      errBytes += d.length;
      if (processGroup && errBytes > 2 * REAL_RUN_STDERR_TAIL_BYTES) {
        const tail = Buffer.concat(err).subarray(-REAL_RUN_STDERR_TAIL_BYTES);
        err = [tail];
        errBytes = tail.length;
      }
    });
    const stdoutText = (): string => Buffer.concat(out).toString('utf8');
    const stderrText = (): string => {
      const all = Buffer.concat(err);
      return (processGroup ? all.subarray(-REAL_RUN_STDERR_TAIL_BYTES) : all).toString('utf8');
    };

    let killReason: KillReason = 'none';
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    // Fix 3: settled guard — 'error' and 'close' can both fire; first one wins.
    let settled = false;

    const pgid = processGroup ? child.pid : undefined;
    const sendSignal = (sig: NodeJS.Signals): void => {
      if (pgid !== undefined) signalProcessGroup(pgid, sig);
      else child.kill(sig);
    };

    const escalate = (reason: Exclude<KillReason, 'none' | 'spawn-error'>): void => {
      if (killReason !== 'none') return; // already terminating
      killReason = reason;
      sendSignal('SIGTERM');
      sigkillTimer = setTimeout(() => sendSignal('SIGKILL'), SIGKILL_GRACE_MS);
    };

    // A worker that has exited has no legitimate descendants: kill any it left behind (they may
    // hold its stdout open, which would otherwise delay 'close' until the timeout). A descendant
    // that left the group (a new session) is out of reach; if it still holds the pipes once the
    // bounded wait is over, they are destroyed so 'close' fires, and the run fails as untrusted.
    let pipesHeld = false;
    let pipeTimer: ReturnType<typeof setTimeout> | undefined;
    const tracker = new DescendantTracker(child.pid ?? -1, envToken);
    let snapshotTimer: ReturnType<typeof setInterval> | undefined;
    if (pgid !== undefined) {
      trackWorkerGroup(pgid);
      tracker.snapshot();
      snapshotTimer = setInterval(() => tracker.snapshot(), DESCENDANT_SNAPSHOT_MS);
      let lastOutputSnapshot = 0;
      const snapshotOnOutput = (): void => {
        const now = Date.now();
        if (now - lastOutputSnapshot < 50) return;
        lastOutputSnapshot = now;
        tracker.snapshot();
      };
      child.stdout?.on('data', snapshotOnOutput);
      child.stderr?.on('data', snapshotOnOutput);
      child.once('exit', () => {
        if (snapshotTimer) clearInterval(snapshotTimer);
        tracker.sweep();
        if (processGroupAlive(pgid)) signalProcessGroup(pgid, 'SIGKILL');
        pipeTimer = setTimeout(() => {
          pipesHeld = true;
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, GROUP_GONE_TIMEOUT_MS);
      });
    }

    const timeoutTimer = setTimeout(() => escalate('timeout'), timeoutMs);
    const onAbort = (): void => escalate('cancel');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const finish = (res: SpawnResult): void => {
      if (settled) return; // idempotent — 'error' + 'close' can both fire
      settled = true;
      clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (pipeTimer) clearTimeout(pipeTimer);
      if (snapshotTimer) clearInterval(snapshotTimer);
      if (pgid !== undefined) liveWorkerGroups.delete(pgid);
      signal.removeEventListener('abort', onAbort);
      resolve(res);
    };

    child.on('error', (e) =>
      finish({
        code: null,
        signal: null,
        stdout: stdoutText(),
        stderr: stderrText(),
        killReason: 'spawn-error',
        spawnErrorMessage: e.message,
      }),
    );
    child.on('close', (code, sig) => {
      // Captured now: the timers below are disarmed before the group wait, so a worker that
      // exited on its own is never relabelled timeout/cancel while its descendants are reaped.
      const reasonAtClose = killReason;
      const result = (groupSurvived = false): SpawnResult => ({
        code,
        signal: sig,
        stdout: stdoutText(),
        stderr: stderrText(),
        killReason: reasonAtClose,
        ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
        ...(groupSurvived ? { processGroupSurvived: true } : {}),
      });
      if (pgid === undefined) {
        finish(result());
        return;
      }
      clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (pipeTimer) clearTimeout(pipeTimer);
      if (snapshotTimer) clearInterval(snapshotTimer);
      signal.removeEventListener('abort', onAbort);
      // Only a group that still has members is signalled: an empty group's id may be reused.
      tracker.sweep();
      if (processGroupAlive(pgid)) signalProcessGroup(pgid, 'SIGKILL');
      void waitForProcessGroupGone(pgid, tracker).then((gone) => finish(result(!gone || pipesHeld)));
    });
  });
}

/** JSON.parse the stdout; on failure, retry fallback strategies; null if still unparseable. */
function parseEnvelope(stdout: string): ResultEnvelope | null {
  const tryParse = (text: string): ResultEnvelope | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    const v = ResultEnvelope.safeParse(parsed);
    return v.success ? v.data : null;
  };
  const direct = tryParse(stdout);
  if (direct) return direct;

  // Fix 6: Fallback strategy — claude may prepend a banner or emit multiple JSON objects.
  // First try the last non-empty line (the result envelope is typically the final line).
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length > 0) {
      const fromLine = tryParse(line);
      if (fromLine) return fromLine;
      break; // only try the last non-empty line before falling back to brace-scan
    }
  }

  // Last resort: find the last balanced top-level {...} block in stdout.
  // Scan backwards from the final '}' to find its matching '{', respecting nesting.
  let end = stdout.lastIndexOf('}');
  while (end >= 0) {
    let depth = 0;
    let start = -1;
    for (let i = end; i >= 0; i--) {
      if (stdout[i] === '}') depth++;
      else if (stdout[i] === '{') {
        depth--;
        if (depth === 0) { start = i; break; }
      }
    }
    if (start >= 0) {
      const candidate = tryParse(stdout.slice(start, end + 1));
      if (candidate) return candidate;
    }
    end = stdout.lastIndexOf('}', end - 1);
  }
  return null;
}

/** Success = exit 0 AND is_error false AND subtype 'success' (exit code alone is unreliable — spike §3). */
function classify(envelope: ResultEnvelope, exitCode: number | null): AgentRunStatus {
  return exitCode === 0 && envelope.is_error === false && envelope.subtype === 'success'
    ? 'succeeded'
    : 'failed';
}

/**
 * Why a non-successful envelope failed (AGX-R19 `worker-failed` reasons). The max-turns and
 * budget-stop subtypes are the ones the AGX-R34 probe recorded on 2.1.285
 * (`tests/spikes/permission-probe-findings.md`). Any other error envelope is `error-result` —
 * never success.
 */
function classifyFailure(envelope: ResultEnvelope): AgentRunFailureClass {
  if (envelope.subtype === 'error_max_turns') return 'max-turns';
  if (envelope.subtype === 'error_max_budget_usd') return 'budget';
  if ((envelope.permission_denials?.length ?? 0) > 0) return 'permission-denied';
  return 'error-result';
}

/** A path is noise if any noise entry equals it, prefixes it, or appears as one of its segments. */
function isNoise(path: string, noise: readonly string[]): boolean {
  const segments = path.split('/');
  return noise.some((n) => path === n || path.startsWith(`${n}/`) || segments.includes(n));
}

interface OracleResult {
  changed: boolean;
  diffRef: string | undefined;
}

/**
 * Activity oracle (CLAUDE.md #2): did the agent change the worktree, ignoring known agent-env noise
 * (`ruvector.db`, `.claude/`, …)? A FAILED git query must never masquerade as "no change" — we
 * report unknown (`diffRef` undefined) rather than a false "clean". This does NOT gate pass/fail.
 */
function activityOracle(
  runGit: (args: readonly string[]) => GitResult,
  initialSha: string,
  noise: readonly string[],
): OracleResult {
  // Fix 4: use -z (NUL-delimited) so paths with spaces/unicode are never C-quoted.
  const statusRes = runGit(['status', '--porcelain', '-z']);
  const headRes = runGit(['rev-parse', 'HEAD']);
  // Fix 5: git failure must NOT return changed:false (false-clean). Return changed:true so the
  // orchestrator treats it as unknown/changed rather than silently treating the run as clean.
  if (statusRes.status !== 0 || headRes.status !== 0) return { changed: true, diffRef: undefined };

  // No trim(): with -z the first entry of an unstaged change starts with a space (` M path`), and
  // trimming it would shift the path by one character. The parser already skips empty tokens.
  const meaningful = parsePorcelainPaths(statusRes.stdout).filter((p) => !isNoise(p, noise));
  const headSha = headRes.stdout.trim();
  const headMoved = headSha !== initialSha;
  const changed = meaningful.length > 0 || headMoved;
  if (!changed) return { changed: false, diffRef: undefined };
  return { changed: true, diffRef: headMoved ? `commit:${headSha.slice(0, 12)}` : `dirty:${meaningful.length}` };
}

export interface ClaudeCodeExecutorOptions {
  /** Claude model alias passed via `--model` (default from guardrails). */
  model?: string;
  /** Per-action timeout in ms (default `ACTION_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Activity-oracle noise filter (default from guardrails). */
  noiseFilterPaths?: readonly string[];
  /** `--max-turns` cap (default 10). */
  maxTurns?: number;
  /**
   * Explicit host-configured `--permission-mode` (default `acceptEdits`). `bypassPermissions` must
   * be opted into explicitly by the call site — it is never a fallback. Unknown values throw.
   */
  permissionMode?: ClaudePermissionMode;
  /** The worker process (default `claude`). Constructor-only by design (AGX-R15). */
  workerCommand?: WorkerCommand;
  /**
   * Approval-gated real-run configuration (ADR-0020). When present the executor only ever uses
   * `acceptEdits` (an action may not request any other mode, not even a narrower one), emits the
   * approved tool lists, `--tools`, the budget flag, the pinned config flags and the engine deny
   * rules, and sends the prompt on stdin. Construction validates the allowlist, budget, turns and
   * deny-rule shape; before spawning it refuses a mismatched credential, a worktree that holds
   * worker config, or a git dir inside the worktree. A missing cost is a failure.
   */
  realRun?: RealRunExecutorConfig;
}

export interface RealRunExecutorConfig {
  /** `--allowedTools`, one rule per flag; must pass `assertFilesystemToolsConfined` (AGX-R11). */
  allowedTools: readonly string[];
  /** `--disallowedTools`, one rule per flag. */
  disallowedTools: readonly string[];
  /** `--max-budget-usd`: the manifest's per-action cap, `0 < cap <= MAX_BUDGET_USD` (AGX-R12). */
  maxBudgetUsd: number;
  /** Must match the worker environment's credential (AGX-R13). */
  authMode: RealRunAuthMode;
}

/**
 * Engine-constant real-run flags, covered by the manifest's `engineVersion`. The worker loads only
 * project settings — the scratch worktree is seeded with profile base files and has none — and no
 * MCP servers, so the operator's user settings, plugins, hooks and MCP servers cannot widen the
 * approved allowlist (operator decision, 2026-09-29; to be verified headless by the AGX-R34 probe).
 */
export const REAL_RUN_CONFIG_FLAGS: readonly string[] = ['--setting-sources', 'project', '--strict-mcp-config'];

/**
 * Engine-constant deny rules, emitted after the approved `--disallowedTools`; a deny rule beats both
 * acceptEdits and any allow rule. Project settings are the only settings a real-run worker loads,
 * so it must never write them, MCP config or git metadata — at the worktree root or nested, since
 * Claude Code discovers `.claude/` (skills, commands) in subdirectories too. `--tools` already
 * removes the command-running and network tools; denying them too is a second layer.
 */
export const REAL_RUN_DENY_RULES: readonly string[] = [
  ...WRITE_TOOLS.flatMap((tool) =>
    REAL_RUN_CONTROL_NAMES.flatMap((name) =>
      [`./${name}`, `./${name}/**`, `./**/${name}`, `./**/${name}/**`].map((pattern) => `${tool}(${pattern})`),
    ),
  ),
  'Bash',
  'WebFetch',
  'WebSearch',
];

/**
 * Control paths that must not exist before a real run: they would feed the worker settings, MCP
 * servers or instructions. `.git` is excluded — the worktree's own gitfile is expected there.
 */
const PREEXISTING_CONFIG_PATHS: readonly string[] = REAL_RUN_CONTROL_NAMES.filter((name) => name !== '.git');

/** A tool rule never starts with `-`, so it cannot be read as a CLI flag. */
const TOOL_RULE_START = /^[A-Za-z]/;

function validateRealRunConfig(config: RealRunExecutorConfig, maxTurns: number): void {
  assertFilesystemToolsConfined(config.allowedTools);
  const badDisallowed = config.disallowedTools.filter((rule) => !TOOL_RULE_START.test(rule));
  if (badDisallowed.length > 0) {
    throw new RunApprovalError('MANIFEST_INVALID', `invalid disallowed tool rule(s): ${badDisallowed.join(', ')}`, {
      disallowedTools: badDisallowed,
    });
  }
  if (!Number.isFinite(config.maxBudgetUsd) || config.maxBudgetUsd <= 0 || config.maxBudgetUsd > MAX_BUDGET_USD) {
    throw new RunApprovalError(
      'MANIFEST_INVALID',
      `per-action budget must be > 0 and <= ${MAX_BUDGET_USD} USD (ADR-0010); got ${String(config.maxBudgetUsd)}`,
      { maxBudgetUsd: config.maxBudgetUsd },
    );
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new RunApprovalError('MANIFEST_INVALID', `maxTurns must be a positive integer; got ${String(maxTurns)}`, {
      maxTurns,
    });
  }
}

/** Real-run flags appended after the base argv (AGX-R11/R12). */
function realRunArgv(config: RealRunExecutorConfig): string[] {
  // `--allowedTools` only adds approvals (read-only Bash commands are auto-approved regardless), so
  // `--tools` restricts the available built-in set to the approved filesystem tools.
  const argv: string[] = ['--tools', allowedToolNames(config.allowedTools).join(',')];
  for (const rule of config.allowedTools) argv.push('--allowedTools', rule);
  for (const rule of [...config.disallowedTools, ...REAL_RUN_DENY_RULES]) argv.push('--disallowedTools', rule);
  argv.push('--max-budget-usd', String(config.maxBudgetUsd));
  argv.push(...REAL_RUN_CONFIG_FLAGS);
  return argv;
}

/** Whether anything — a dangling symlink included — sits at `target`. Fails closed on odd errors. */
function entryExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

type WorktreePreflight = { ok: true; gitDir: string } | { ok: false; reason: string };

/**
 * Pre-spawn worktree checks for a real run: no pre-existing config the worker would load, and a
 * git dir that lives outside the worktree (a worker-written `.git` gitfile would point inside it).
 * The git dir comes from the caller when it recorded one at worktree creation (`ctx.gitDir`), and
 * is resolved here otherwise. Never throws: every failure is a refusal.
 */
function preflightRealRunWorktree(worktreePath: string, knownGitDir: string | undefined): WorktreePreflight {
  const present = PREEXISTING_CONFIG_PATHS.filter((rel) => entryExists(path.join(worktreePath, rel)));
  if (present.length > 0) return { ok: false, reason: `worktree already contains worker config: ${present.join(', ')}` };
  let gitDir: string;
  let worktree: string;
  try {
    let candidate = knownGitDir;
    if (candidate === undefined) {
      const resolved = pinnedGit(['rev-parse', '--absolute-git-dir'], worktreePath);
      if (resolved.status !== 0) return { ok: false, reason: `worktree git dir unavailable: ${resolved.stderr.trim()}` };
      candidate = resolved.stdout.trim();
    }
    gitDir = realpathSync(candidate);
    worktree = realpathSync(worktreePath);
  } catch (err) {
    return { ok: false, reason: `worktree git dir unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (gitDir === worktree || gitDir.startsWith(worktree + path.sep)) {
    return { ok: false, reason: `worktree git dir ${gitDir} is inside the worktree` };
  }
  return { ok: true, gitDir };
}

/** Legacy (non-real-run) mode resolution: fail closed on an unknown configured mode. */
function legacyPermissionMode(configured: string): ClaudePermissionMode {
  // An unknown configured mode is a host config error, not something to coerce. The default is
  // acceptEdits, never bypassPermissions.
  if (!VALID_PERMISSION_MODES.has(configured)) {
    throw new Error(
      `[executor] unknown permissionMode '${configured}' — valid: ${[...VALID_PERMISSION_MODES].join(', ')} (fail-closed; bypassPermissions is never a fallback)`,
    );
  }
  return configured as ClaudePermissionMode;
}

export class ClaudeCodeExecutor implements Executor {
  readonly kind: ExecutorKind = 'claude-code';
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly noiseFilterPaths: readonly string[];
  private readonly maxTurns: number;
  private readonly permissionMode: ClaudePermissionMode;
  private readonly workerCommand: WorkerCommand;
  private readonly realRun: RealRunExecutorConfig | undefined;
  private seq = 0;

  constructor(opts: ClaudeCodeExecutorOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? ACTION_TIMEOUT_MS;
    this.noiseFilterPaths = opts.noiseFilterPaths ?? DEFAULT_NOISE_FILTER_PATHS;
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.workerCommand = opts.workerCommand ?? DEFAULT_WORKER_COMMAND;
    this.realRun = opts.realRun;
    // Fail closed at construction. A real run resolves through the acceptEdits-only resolver,
    // never the legacy mode set.
    this.permissionMode = this.realRun
      ? resolveRealRunPermissionMode(opts.permissionMode ?? 'acceptEdits')
      : legacyPermissionMode(opts.permissionMode ?? 'acceptEdits');
    if (this.realRun) validateRealRunConfig(this.realRun, this.maxTurns);
  }

  async run(action: Action, ctx: RunContext): Promise<AgentRun> {
    const startedAt = new Date().toISOString();
    const base: AgentRun = {
      id: `${ctx.runId}:${action.id}:${++this.seq}`,
      planId: '', // stamped by the orchestrator
      stepId: '', // stamped by the orchestrator
      actionId: action.id,
      executor: this.kind,
      startedAt,
      status: 'failed',
    };

    // A real run never spawns on these paths, so it reports a failure class and no cost; the
    // legacy path keeps its historical `costUsd: 0` shape.
    const refuse = (stderr: string, failureClass: AgentRunFailureClass): AgentRun =>
      this.realRun
        ? { ...base, endedAt: new Date().toISOString(), failureClass, stderr: `${stderr} (nothing spawned)` }
        : { ...base, endedAt: new Date().toISOString(), costUsd: 0, stderr };

    // The agent writes this worktree, so every engine git call here — on both paths — runs with
    // fsmonitor and hooks off, pinned to a git dir resolved before the agent ran when one is known.
    let pinnedDir = ctx.gitDir;
    if (this.realRun) {
      const preflight = preflightRealRunWorktree(ctx.worktreePath, ctx.gitDir);
      if (!preflight.ok) return refuse(`[executor] ${preflight.reason}`, 'worktree-refused');
      pinnedDir = preflight.gitDir;
    }
    const runGit = (args: readonly string[]): GitResult => pinnedGit(args, ctx.worktreePath, pinnedDir);

    // Ground-truth baseline (CLAUDE.md #2): never trust a run whose baseline we cannot read.
    const baseline = runGit(['rev-parse', 'HEAD']);
    if (baseline.status !== 0) {
      return refuse(`[executor] worktree baseline unavailable: ${baseline.stderr.trim()}`, 'worktree-refused');
    }
    const initialSha = baseline.stdout.trim();

    const prompt = action.payload.prompt ?? action.name;
    // Fail-closed permission resolution (see module doc above): absent → the explicit
    // host-configured mode; a payload may only narrow within ACTION_REQUESTABLE_MODES; anything
    // unknown, or an attempt to escalate above the configured mode, fails the action WITHOUT
    // spawning — it is never coerced to bypassPermissions (or any other executable mode).
    const requestedMode = action.payload.permissionMode;
    if (this.realRun && requestedMode !== undefined && requestedMode !== this.permissionMode) {
      // The approved manifest fixes the mode; a real-run action cannot change it, even to narrow.
      return refuse(
        `[executor] rejected action permissionMode '${String(requestedMode)}' (real run: the approved mode is fixed)`,
        'mode-rejected',
      );
    }
    let permissionMode: ClaudePermissionMode;
    if (requestedMode === undefined) {
      permissionMode = this.permissionMode;
    } else if (
      ACTION_REQUESTABLE_MODES.has(requestedMode) &&
      MODE_RANK[requestedMode as ClaudePermissionMode] <= MODE_RANK[this.permissionMode]
    ) {
      permissionMode = requestedMode as ClaudePermissionMode;
    } else {
      return refuse(
        `[executor] rejected action permissionMode '${String(requestedMode)}' (fail-closed: unknown or more permissive than configured '${this.permissionMode}'; never coerced to bypassPermissions)`,
        'mode-rejected',
      );
    }
    // A real run sends the prompt on stdin, so no prompt text can be parsed as a CLI flag or
    // subcommand; the legacy path keeps it as the positional argument.
    const argv = [
      '-p',
      ...(this.realRun ? [] : [prompt]),
      '--output-format',
      'json',
      '--permission-mode',
      permissionMode,
      '--model',
      this.model,
      '--max-turns',
      String(this.maxTurns),
      ...(this.realRun ? realRunArgv(this.realRun) : []),
    ];

    let env: NodeJS.ProcessEnv = GIT_ENV;
    if (this.realRun) {
      env = workerEnv();
      try {
        assertAuthModeMatchesEnv(this.realRun.authMode, env);
      } catch (err) {
        return refuse(
          `[executor] AUTH_MODE_MISMATCH: ${err instanceof Error ? err.message : String(err)}`,
          'auth-mode-mismatch',
        );
      }
    }

    const res = await spawnClaude(
      this.workerCommand,
      argv,
      ctx.worktreePath,
      env,
      ctx.signal,
      this.timeoutMs,
      this.realRun ? prompt : undefined,
      this.realRun !== undefined,
    );
    const endedAt = new Date().toISOString();

    // Activity oracle runs regardless of outcome (the agent may have made partial changes).
    const oracle = activityOracle(runGit, initialSha, this.noiseFilterPaths);

    let status: AgentRunStatus;
    // Real runs never default a missing cost to 0 (AGX-R12): unmetered stays undefined.
    let costUsd: number | undefined = this.realRun ? undefined : 0;
    let failureClass: AgentRunFailureClass | undefined;
    let tokens: number | undefined;
    let turns: number | undefined;
    let durationMs: number | undefined;
    let stderr = res.stderr;

    if (res.processGroupSurvived) {
      // The worker's processes may still be writing the worktree: nothing read from it is
      // trustworthy, so the run fails whatever the envelope says (AGX-R14).
      status = 'failed';
      failureClass = 'worker-not-terminated';
      stderr = `${stderr}\n[executor] worker process group still present after SIGKILL`.trim();
    } else if (res.killReason === 'cancel') {
      status = 'cancelled';
      failureClass = 'cancel';
      stderr = `${stderr}\n[executor] cancelled via AbortSignal (SIGTERM→SIGKILL)`.trim();
    } else if (res.killReason === 'timeout') {
      status = 'failed';
      failureClass = 'timeout';
      stderr = `${stderr}\n[executor] timed out after ${this.timeoutMs}ms (SIGTERM→SIGKILL)`.trim();
    } else if (res.killReason === 'spawn-error') {
      status = 'failed';
      failureClass = 'spawn-error';
      stderr = `${stderr}\n[executor] claude failed to spawn: ${res.spawnErrorMessage ?? 'unknown'} (is the CLI installed and logged in?)`.trim();
    } else {
      const envelope = res.stdoutTruncated ? null : parseEnvelope(res.stdout);
      if (!envelope) {
        status = 'failed';
        failureClass = 'malformed-output';
        stderr = res.stdoutTruncated
          ? `${stderr}\n[executor] RUN_FAIL: stdout exceeded ${REAL_RUN_STDOUT_MAX_BYTES} bytes`.trim()
          : `${stderr}\n[executor] RUN_FAIL: stdout was not a parseable result envelope (exit ${res.code})`.trim();
      } else {
        status = classify(envelope, res.code);
        if (status === 'failed') failureClass = classifyFailure(envelope);
        if (this.realRun && status === 'succeeded' && (envelope.permission_denials?.length ?? 0) > 0) {
          // A real-run worker that hit a denied tool attempted something outside its approved
          // allowlist; that is a worker failure (AGX-R19), never a success handed to the verifier.
          status = 'failed';
          failureClass = 'permission-denied';
        }
        tokens = envelope.usage?.output_tokens;
        turns = envelope.num_turns;
        durationMs = envelope.duration_ms;
        if (!this.realRun) {
          costUsd = envelope.total_cost_usd ?? 0;
        } else if (typeof envelope.total_cost_usd === 'number') {
          costUsd = envelope.total_cost_usd;
        } else if (status === 'succeeded') {
          // A result without a cost figure cannot be metered, so it cannot succeed (AGX-R12).
          status = 'failed';
          failureClass = 'cost-unmetered';
          stderr = `${stderr}\n[executor] cost-unmetered: result envelope has no total_cost_usd`.trim();
        }
      }
    }

    const run: AgentRun = {
      ...base,
      endedAt,
      status,
      stdout: res.stdout,
      stderr,
    };
    if (costUsd !== undefined) run.costUsd = costUsd;
    if (this.realRun && failureClass !== undefined) run.failureClass = failureClass;
    if (res.code !== null) run.exitCode = res.code;
    if (tokens !== undefined) run.tokens = tokens;
    // Real-run metering for the spend ledger (AGX-R16); legacy runs keep their historical shape.
    if (this.realRun && turns !== undefined) run.turns = turns;
    if (this.realRun && durationMs !== undefined) run.durationMs = durationMs;
    if (oracle.diffRef !== undefined) run.diffRef = oracle.diffRef;
    return run;
  }
}
