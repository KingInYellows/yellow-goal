/**
 * Full diff (tracked + untracked) capture before worktree teardown (R6). Called from inside
 * `executeStep()`'s try block — BEFORE `handle.cleanup()` destroys the git objects — and reuses
 * `worktree.ts`'s isolated `git()` so this never touches host git config either.
 *
 * `git diff <initialSha>` diffs the working tree against the worktree's STORED BASELINE, not bare
 * `HEAD` — this is what makes the capture correct even when `activityOracle` reports `headMoved`
 * (the agent ran `git commit`): a bare `git diff` after a commit shows nothing (there's no
 * uncommitted delta left), but diffing against `initialSha` still shows everything from creation
 * to now, committed or not.
 *
 * `git add -N .` (intent-to-add) stages untracked files as empty blobs so they appear as full
 * additions in that diff. This mutates the index, which is normally unsafe to do carelessly, but
 * the worktree is torn down immediately after this call (see `worktree.ts`'s documented teardown
 * ordering) — no caller ever observes the mutated index.
 */
import { git } from './worktree';

/**
 * Full diff of `worktreePath` against `initialSha`, or `undefined` if nothing changed or the git
 * calls themselves failed (fail-open — mirrors the activity oracle's `diffRef` contract; this
 * never throws).
 */
export function captureDiff(worktreePath: string, initialSha: string): string | undefined {
  const add = git(['add', '-N', '.'], worktreePath);
  if (add.status !== 0) return undefined;
  // --no-ext-diff/--no-textconv: the agent can write repo-local .git/config + .gitattributes
  // during its turn (GIT_ENV only pins the GLOBAL/SYSTEM config, not this worktree's own), and a
  // planted diff driver would otherwise execute inside the orchestrator process on this call.
  const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--binary', initialSha], worktreePath);
  if (diff.status !== 0 || diff.stdout.length === 0) return undefined;
  return diff.stdout;
}
