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
 * files and `git diff` misses them entirely (spike §5, the headline de-risking result).
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { ACTION_TIMEOUT_MS, DEFAULT_MODEL, DEFAULT_NOISE_FILTER_PATHS } from '../orchestrator/guardrails';
import type { Action, ExecutorKind } from '../planner/types';
import type { AgentRun, AgentRunStatus, Executor, RunContext } from '../types';
import { git } from './worktree';

/** SIGKILL escalation grace after SIGTERM on cancel/timeout (plan task 2.5). */
const SIGKILL_GRACE_MS = 5_000;
const DEFAULT_MAX_TURNS = 10;
/** Permission modes the executor will honor from an LLM-authored action; anything else is ignored
 *  and forced back to bypassPermissions so a prompt-injected action can't downgrade the headless run. */
const ALLOWED_PERMISSION_MODES = new Set(['bypassPermissions', 'acceptEdits']);

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
    total_cost_usd: z.number().optional(),
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
}

/**
 * Spawn `claude` and resolve on the `close` event (all stdio flushed — NOT `exit`). Honors
 * cancellation via `signal` and a per-action timeout, both escalating SIGTERM → SIGKILL after a
 * grace period. Never rejects — a spawn error resolves with `killReason: 'spawn-error'`.
 */
function spawnClaude(
  argv: readonly string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn('claude', [...argv], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));

    let killReason: KillReason = 'none';
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const escalate = (reason: Exclude<KillReason, 'none' | 'spawn-error'>): void => {
      if (killReason !== 'none') return; // already terminating
      killReason = reason;
      child.kill('SIGTERM');
      sigkillTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
    };

    const timeoutTimer = setTimeout(() => escalate('timeout'), timeoutMs);
    const onAbort = (): void => escalate('cancel');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const finish = (res: SpawnResult): void => {
      clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      signal.removeEventListener('abort', onAbort);
      resolve(res);
    };

    child.on('error', (e) =>
      finish({
        code: null,
        signal: null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        killReason: 'spawn-error',
        spawnErrorMessage: e.message,
      }),
    );
    child.on('close', (code, sig) =>
      finish({
        code,
        signal: sig,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        killReason,
      }),
    );
  });
}

/** JSON.parse the stdout; on failure, retry the outermost `{…}` block; null if still unparseable. */
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
  // Fallback: outermost brace block (claude may prepend a banner before the JSON envelope).
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParse(stdout.slice(start, end + 1));
  return null;
}

/** Success = exit 0 AND is_error false AND subtype 'success' (exit code alone is unreliable — spike §3). */
function classify(envelope: ResultEnvelope, exitCode: number | null): AgentRunStatus {
  return exitCode === 0 && envelope.is_error === false && envelope.subtype === 'success'
    ? 'succeeded'
    : 'failed';
}

/** porcelain v1 path field, handling `R  old -> new` rename/copy entries (new path is meaningful). */
function parsePorcelainPaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const body = line.slice(3); // 2 status chars + 1 space, then the path
      const arrow = body.indexOf(' -> ');
      return arrow >= 0 ? body.slice(arrow + 4) : body;
    });
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
function activityOracle(worktreePath: string, initialSha: string, noise: readonly string[]): OracleResult {
  const statusRes = git(['status', '--porcelain'], worktreePath);
  const headRes = git(['rev-parse', 'HEAD'], worktreePath);
  if (statusRes.status !== 0 || headRes.status !== 0) return { changed: false, diffRef: undefined };

  const meaningful = parsePorcelainPaths(statusRes.stdout.trim()).filter((p) => !isNoise(p, noise));
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
}

export class ClaudeCodeExecutor implements Executor {
  readonly kind: ExecutorKind = 'claude-code';
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly noiseFilterPaths: readonly string[];
  private readonly maxTurns: number;
  private seq = 0;

  constructor(opts: ClaudeCodeExecutorOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? ACTION_TIMEOUT_MS;
    this.noiseFilterPaths = opts.noiseFilterPaths ?? DEFAULT_NOISE_FILTER_PATHS;
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  }

  async run(action: Action, ctx: RunContext): Promise<AgentRun> {
    const startedAt = new Date().toISOString();
    const base: AgentRun = {
      id: `${ctx.runId}:${action.id}:${++this.seq}`,
      planId: '', // stamped by the orchestrator
      actionId: action.id,
      executor: this.kind,
      startedAt,
      status: 'failed',
    };

    // Ground-truth baseline (CLAUDE.md #2): never trust a run whose baseline we cannot read.
    const baseline = git(['rev-parse', 'HEAD'], ctx.worktreePath);
    if (baseline.status !== 0) {
      return {
        ...base,
        endedAt: new Date().toISOString(),
        costUsd: 0,
        stderr: `[executor] worktree baseline unavailable: ${baseline.stderr.trim()}`,
      };
    }
    const initialSha = baseline.stdout.trim();

    const prompt = action.payload.prompt ?? action.name;
    const requestedMode = action.payload.permissionMode;
    const permissionMode = requestedMode && ALLOWED_PERMISSION_MODES.has(requestedMode) ? requestedMode : 'bypassPermissions';
    const argv = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--permission-mode',
      permissionMode,
      '--model',
      this.model,
      '--max-turns',
      String(this.maxTurns),
    ];

    const res = await spawnClaude(argv, ctx.worktreePath, ctx.signal, this.timeoutMs);
    const endedAt = new Date().toISOString();

    // Activity oracle runs regardless of outcome (the agent may have made partial changes).
    const oracle = activityOracle(ctx.worktreePath, initialSha, this.noiseFilterPaths);

    let status: AgentRunStatus;
    let costUsd = 0;
    let tokens: number | undefined;
    let stderr = res.stderr;

    if (res.killReason === 'cancel') {
      status = 'cancelled';
      stderr = `${stderr}\n[executor] cancelled via AbortSignal (SIGTERM→SIGKILL)`.trim();
    } else if (res.killReason === 'timeout') {
      status = 'failed';
      stderr = `${stderr}\n[executor] timed out after ${this.timeoutMs}ms (SIGTERM→SIGKILL)`.trim();
    } else if (res.killReason === 'spawn-error') {
      status = 'failed';
      stderr = `${stderr}\n[executor] claude failed to spawn: ${res.spawnErrorMessage ?? 'unknown'} (is the CLI installed and logged in?)`.trim();
    } else {
      const envelope = parseEnvelope(res.stdout);
      if (!envelope) {
        status = 'failed';
        stderr = `${stderr}\n[executor] RUN_FAIL: stdout was not a parseable result envelope (exit ${res.code})`.trim();
      } else {
        status = classify(envelope, res.code);
        costUsd = envelope.total_cost_usd ?? 0;
        tokens = envelope.usage?.output_tokens;
      }
    }

    const run: AgentRun = {
      ...base,
      endedAt,
      status,
      costUsd,
      stdout: res.stdout,
      stderr,
    };
    if (res.code !== null) run.exitCode = res.code;
    if (tokens !== undefined) run.tokens = tokens;
    if (oracle.diffRef !== undefined) run.diffRef = oracle.diffRef;
    return run;
  }
}
