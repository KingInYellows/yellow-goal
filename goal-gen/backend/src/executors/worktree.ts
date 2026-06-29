/**
 * Per-run git worktree lifecycle — collision-avoidance, NOT a sandbox (ADR-0009, CLAUDE.md #5).
 * Promoted from the de-risk spike (`tests/spikes/executor-spike.ts` §6) which proved this exact
 * sequence runs `claude -p` end-to-end with zero leaked worktrees/temp dirs.
 *
 * v1 runs each action against a *throwaway scratch repo* in `os.tmpdir()` (the walking skeleton
 * proves loop mechanics, not persistent repo work — see plan task 2.1 + probe 5.3); pointing the
 * worktree at the operator's real repo is a later milestone.
 *
 * Teardown ordering is load-bearing (documented data-loss hazard): `git worktree remove --force`
 * → `git worktree prune` → `rm` the scratch root. NEVER `rm -rf` the root before removing the
 * worktree.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Git env fully isolated from the host — no global hooks / GPG signing / `includeIf` (spike §6). */
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const GIT_IDENT = ['-c', 'user.name=goal-gen', '-c', 'user.email=goal-gen@local'] as const;
/** Cap each synchronous git call so a hung git (gpg-agent, credential helper, stalled mount) can't
 *  deadlock the event loop — the per-action claude timeout does not cover these blocking git calls. */
const GIT_TIMEOUT_MS = 30_000;

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Synchronous git in `cwd` with isolated config + a timeout. `status` is -1 when killed/timed out. */
export function git(args: readonly string[], cwd: string): GitResult {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  // On timeout/kill, status is null; surface r.error (e.g. ETIMEDOUT) so a caller never sees a silent "".
  const stderr = r.stderr ?? '';
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.error ? `${stderr}${r.error.message}`.trim() : stderr };
}

function gitOrThrow(args: readonly string[], cwd: string): string {
  const r = git(args, cwd);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr.trim()}`);
  }
  return r.stdout;
}

export interface WorktreeHandle {
  /** Scratch repo root (in `os.tmpdir()`). */
  root: string;
  /** The isolated worktree the agent runs in (the executor's `ctx.worktreePath`). */
  worktreePath: string;
  /** Branch checked out in the worktree. */
  branch: string;
  /** HEAD sha at creation — the activity oracle's baseline. */
  initialSha: string;
  /** Idempotent teardown: worktree remove --force → prune → rm scratch root. */
  cleanup(): Promise<void>;
}

export interface CreateWorktreeOptions {
  /** Branch name for the worktree (default `run`; the fresh scratch repo makes collisions impossible). */
  branch?: string;
  /** Optional seed files (relative path → contents) committed into the scratch repo before the worktree. */
  seedFiles?: Record<string, string>;
  /** tmp-dir prefix for the scratch repo (default `goal-gen-run-`). */
  prefix?: string;
}

/** ORDER MATTERS — remove the worktree before deleting the root (data-loss hazard). Best-effort. */
async function teardown(root: string, worktreePath: string): Promise<void> {
  if (worktreePath) {
    // A non-zero remove (already gone / never fully created) is non-fatal. Prune ALWAYS runs after
    // remove — matching the documented invariant — so a stale entry left by a crashed prior run is
    // reconciled; on the happy path it's a cheap no-op on the about-to-be-deleted scratch repo.
    git(['worktree', 'remove', worktreePath, '--force'], root);
    git(['worktree', 'prune'], root);
  }
  await rm(root, { recursive: true, force: true });
}

/**
 * Create a fresh scratch repo + an isolated worktree off an empty initial commit. Returns a handle
 * whose `cleanup()` tears everything down. On partial failure the scratch dir is best-effort removed
 * so a failed creation never leaks.
 */
export async function createWorktree(opts: CreateWorktreeOptions = {}): Promise<WorktreeHandle> {
  const branch = opts.branch ?? 'run';
  const root = await mkdtemp(join(tmpdir(), opts.prefix ?? 'goal-gen-run-'));
  let worktreePath = '';
  try {
    gitOrThrow(['init', '-q'], root);
    git(['worktree', 'prune'], root); // crash backstop (no-op on a fresh repo; safe if root is reused)
    for (const [rel, content] of Object.entries(opts.seedFiles ?? {})) {
      await writeFile(join(root, rel), content, 'utf8');
    }
    gitOrThrow(['add', '-A'], root); // worktree needs >=1 commit; --allow-empty covers the no-seed case
    gitOrThrow([...GIT_IDENT, 'commit', '-q', '--allow-empty', '-m', 'init'], root);
    const initialSha = gitOrThrow(['rev-parse', 'HEAD'], root).trim();
    worktreePath = join(root, 'wt');
    gitOrThrow(['worktree', 'add', worktreePath, '-b', branch], root);
    return { root, worktreePath, branch, initialSha, cleanup: () => teardown(root, worktreePath) };
  } catch (e) {
    await teardown(root, worktreePath).catch(() => {});
    throw e;
  }
}

/** Create a worktree, run `fn`, and ALWAYS tear it down (crash-safe; never `process.exit()` mid-run). */
export async function withWorktree<T>(
  opts: CreateWorktreeOptions,
  fn: (handle: WorktreeHandle) => Promise<T>,
): Promise<T> {
  const handle = await createWorktree(opts);
  try {
    return await fn(handle);
  } finally {
    await handle.cleanup();
  }
}
