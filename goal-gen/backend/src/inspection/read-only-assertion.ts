/**
 * Read-only invariant proof (packet-compiler.md invariant 1: "inspect, analyze, compile, packet
 * verify leave the target's branch, HEAD, status, tracked hashes, and untracked set unchanged.
 * Proven by tests."). Captures a snapshot before and after an operation and diffs them.
 *
 * Exported specifically so worker C's AC-3 test (proving `analyze`/`compile` are equally
 * read-only) can reuse the exact same capture/diff logic rather than re-implementing it.
 */
import { lsTree, revParse, statusPorcelain, symbolicRef } from './git';

export interface ReadOnlyState {
  /** Current branch short name, or null when HEAD is detached. */
  branch: string | null;
  headSha: string | null;
  status: { code: string; path: string }[];
  /** path -> blob hash, from `git ls-tree -r HEAD`, sorted by path for stable comparison. */
  trackedHashes: { path: string; hash: string }[];
}

export function captureReadOnlyState(cwd: string): ReadOnlyState {
  const headRef = symbolicRef(cwd, 'HEAD');
  const branch = headRef ? headRef.replace(/^refs\/heads\//, '') : null;
  const headSha = revParse(cwd, 'HEAD');
  const status = statusPorcelain(cwd);
  const trackedHashes = lsTree(cwd, 'HEAD')
    .filter((e) => e.type === 'blob')
    .map((e) => ({ path: e.path, hash: e.hash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { branch, headSha, status, trackedHashes };
}

export interface ReadOnlyViolation {
  field: 'branch' | 'headSha' | 'status' | 'trackedHashes';
  message: string;
}

function statusKey(s: { code: string; path: string }): string {
  return `${s.code}:${s.path}`;
}

/** Order-insensitive set comparison for status entries (untracked/modified paths can legitimately
 *  be reported by git in a different order between two invocations). */
function statusSetsEqual(a: ReadOnlyState['status'], b: ReadOnlyState['status']): boolean {
  const aKeys = new Set(a.map(statusKey));
  const bKeys = new Set(b.map(statusKey));
  if (aKeys.size !== bKeys.size) return false;
  for (const k of aKeys) if (!bKeys.has(k)) return false;
  return true;
}

export function diffReadOnlyState(before: ReadOnlyState, after: ReadOnlyState): ReadOnlyViolation[] {
  const violations: ReadOnlyViolation[] = [];
  if (before.branch !== after.branch) {
    violations.push({ field: 'branch', message: `branch changed: "${before.branch}" -> "${after.branch}"` });
  }
  if (before.headSha !== after.headSha) {
    violations.push({ field: 'headSha', message: `HEAD changed: ${before.headSha} -> ${after.headSha}` });
  }
  if (!statusSetsEqual(before.status, after.status)) {
    violations.push({ field: 'status', message: 'working tree status (tracked changes + untracked set) changed' });
  }
  if (JSON.stringify(before.trackedHashes) !== JSON.stringify(after.trackedHashes)) {
    violations.push({ field: 'trackedHashes', message: 'tracked blob hashes changed' });
  }
  return violations;
}

/** Throws with all violations listed if `before`/`after` differ in any read-only-relevant way. */
export function assertReadOnly(before: ReadOnlyState, after: ReadOnlyState): void {
  const violations = diffReadOnlyState(before, after);
  if (violations.length > 0) {
    throw new Error(`read-only invariant violated: ${violations.map((v) => v.message).join('; ')}`);
  }
}
