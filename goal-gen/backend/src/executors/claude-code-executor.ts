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
import { GIT_ENV, git } from './worktree';

/** SIGKILL escalation grace after SIGTERM on cancel/timeout (plan task 2.5). */
const SIGKILL_GRACE_MS = 5_000;
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
    // Fix 2: wrap spawn so a synchronous throw (bad cwd, ENOENT, etc.) resolves as spawn-error
    // rather than rejecting or escaping as an unhandled exception.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('claude', [...argv], { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
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

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));

    let killReason: KillReason = 'none';
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    // Fix 3: settled guard — 'error' and 'close' can both fire; first one wins.
    let settled = false;

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
      if (settled) return; // idempotent — 'error' + 'close' can both fire
      settled = true;
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
 * Fix 4: Parse NUL-delimited `git status --porcelain -z` output.
 * With -z, entries are NUL-terminated (not newline), paths are never C-quoted, and rename entries
 * are two NUL-separated tokens: `XY SP <old> NUL <new> NUL`. We want the destination (new) path
 * for renames/copies, and the single path for all other entries.
 *
 * Layout per entry: [2-char XY][SP][path][NUL]
 * For R/C (rename/copy): [2-char XY][SP][old-path][NUL][new-path][NUL]
 */
function parsePorcelainPaths(nulDelimited: string): string[] {
  if (!nulDelimited) return [];
  // Split on NUL; trailing NUL produces an empty last token — filter empties at the end.
  const tokens = nulDelimited.split('\0');
  const paths: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.length === 0) { i++; continue; }
    // Each entry starts with 2 status chars + 1 space (total 3 chars) then the path.
    const xy = token.slice(0, 2);
    const path = token.slice(3);
    const isRename = xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C';
    if (isRename) {
      // Next token is the destination path.
      const dest = tokens[i + 1];
      if (dest && dest.length > 0) {
        paths.push(dest);
        i += 2;
        continue;
      }
    }
    paths.push(path);
    i++;
  }
  return paths;
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
  // Fix 4: use -z (NUL-delimited) so paths with spaces/unicode are never C-quoted.
  const statusRes = git(['status', '--porcelain', '-z'], worktreePath);
  const headRes = git(['rev-parse', 'HEAD'], worktreePath);
  // Fix 5: git failure must NOT return changed:false (false-clean). Return changed:true so the
  // orchestrator treats it as unknown/changed rather than silently treating the run as clean.
  if (statusRes.status !== 0 || headRes.status !== 0) return { changed: true, diffRef: undefined };

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
  /**
   * Explicit host-configured `--permission-mode` (default `acceptEdits`). `bypassPermissions` must
   * be opted into explicitly by the call site — it is never a fallback. Unknown values throw.
   */
  permissionMode?: ClaudePermissionMode;
}

export class ClaudeCodeExecutor implements Executor {
  readonly kind: ExecutorKind = 'claude-code';
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly noiseFilterPaths: readonly string[];
  private readonly maxTurns: number;
  private readonly permissionMode: ClaudePermissionMode;
  private seq = 0;

  constructor(opts: ClaudeCodeExecutorOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? ACTION_TIMEOUT_MS;
    this.noiseFilterPaths = opts.noiseFilterPaths ?? DEFAULT_NOISE_FILTER_PATHS;
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    // Fail closed at construction: an unknown configured mode is a host config error, not
    // something to coerce. The default is acceptEdits, never bypassPermissions.
    const configured = opts.permissionMode ?? 'acceptEdits';
    if (!VALID_PERMISSION_MODES.has(configured)) {
      throw new Error(
        `[executor] unknown permissionMode '${String(configured)}' — valid: ${[...VALID_PERMISSION_MODES].join(', ')} (fail-closed; bypassPermissions is never a fallback)`,
      );
    }
    this.permissionMode = configured;
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
    // Fail-closed permission resolution (see module doc above): absent → the explicit
    // host-configured mode; a payload may only narrow within ACTION_REQUESTABLE_MODES; anything
    // unknown, or an attempt to escalate above the configured mode, fails the action WITHOUT
    // spawning — it is never coerced to bypassPermissions (or any other executable mode).
    const requestedMode = action.payload.permissionMode;
    let permissionMode: ClaudePermissionMode;
    if (requestedMode === undefined) {
      permissionMode = this.permissionMode;
    } else if (
      ACTION_REQUESTABLE_MODES.has(requestedMode) &&
      MODE_RANK[requestedMode as ClaudePermissionMode] <= MODE_RANK[this.permissionMode]
    ) {
      permissionMode = requestedMode as ClaudePermissionMode;
    } else {
      return {
        ...base,
        endedAt: new Date().toISOString(),
        costUsd: 0,
        stderr: `[executor] rejected action permissionMode '${String(requestedMode)}' (fail-closed: unknown or more permissive than configured '${this.permissionMode}'; never coerced to bypassPermissions)`,
      };
    }
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
