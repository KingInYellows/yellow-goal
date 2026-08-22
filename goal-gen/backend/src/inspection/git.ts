/**
 * Safe, metadata-only git plumbing for repository inspection (05_REPOSITORY_INSPECTION_AND_RESEARCH.md,
 * 06_SECURITY_PERMISSIONS_AND_HUMAN_GATES.md). Mirrors the isolated-env / arg-array / bounded-output
 * pattern in `backend/src/executors/worktree.ts`'s `git()` helper, with one deliberate structural
 * difference:
 *
 * INVARIANT: this module exposes ONLY named operations that can never print blob content —
 * `ls-files`, `ls-tree -l` (path/size/hash metadata), `cat-file -s`/`-t` (size/type, not content),
 * `rev-parse`, `symbolic-ref`, `status --porcelain`, `log` (hash/author/date/subject only, never
 * `-p`), `diff --name-status` (paths + change kind, never a patch), `branch`, and `remote get-url`.
 * There is deliberately NO exported wrapper for `cat-file -p`, `show`, `diff` (unqualified), `log -p`,
 * `archive`, or any other content-revealing subcommand, and the low-level spawn primitive
 * (`spawnGitRaw`) is NOT exported. A caller cannot use this module to read the contents of a
 * protected path (`.env`, `*.pem`, etc.) even by accident — the capability simply isn't in the
 * module's surface. Detectors that must read the contents of ordinary (non-protected) tracked files
 * should read them off the worktree filesystem directly, not through this module.
 *
 * All repository-supplied text (paths, branch names, commit subjects, remote URLs) is untrusted
 * input (06 §"Target repository content is untrusted") — it is only ever parsed as data, never
 * interpolated into a shell string (spawnSync is always called with an argument array; there is no
 * shell involved anywhere in this file).
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';

/** Isolated from host git config/hooks/GPG — same posture as executors/worktree.ts's GIT_ENV. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
/** Caps a single blocking git call so a hung git (credential helper, stalled mount) can't stall inspection. */
const GIT_TIMEOUT_MS = 30_000;
/** Buffer handed to spawnSync itself; generous so spawnSync never chokes before our own char-cap slices it. */
const GIT_SPAWN_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** Hard cap on stdout/stderr we ever return to a caller — evidence excerpts must stay bounded regardless
 *  of how large a repository's untrusted metadata (e.g. thousands of tracked paths) happens to be.
 *  Exported (it's just a size constant, not a content-reading capability) so tests can assert against
 *  the real cap instead of a hardcoded magic number. */
export const OUTPUT_CHAR_CAP = 1_000_000;

export interface GitResult {
  /** Process exit status; -1 when the process failed to spawn or was killed/timed out. */
  status: number;
  stdout: string;
  stderr: string;
  /** True when stdout and/or stderr were cut at OUTPUT_CHAR_CAP. */
  truncated: boolean;
}

function boundedCapture(s: string): { text: string; truncated: boolean } {
  if (s.length <= OUTPUT_CHAR_CAP) return { text: s, truncated: false };
  return { text: s.slice(0, OUTPUT_CHAR_CAP), truncated: true };
}

/**
 * Low-level, NOT exported: every caller of this must be a named metadata-safe operation defined
 * below in this same file. Keeping this private (rather than exporting a generic "run any git argv"
 * escape hatch) is what makes the content-read invariant structural rather than a convention.
 */
function spawnGitRaw(args: readonly string[], cwd: string): GitResult {
  let r: SpawnSyncReturns<string>;
  try {
    r = spawnSync('git', args, {
      cwd,
      env: GIT_ENV,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_SPAWN_MAX_BUFFER_BYTES,
    });
  } catch (e) {
    // spawnSync throws synchronously when the binary is missing (ENOENT) or the arg list exceeds
    // the OS limit (E2BIG). Surface as a non-zero result so callers never see an unhandled exception.
    const msg = e instanceof Error ? e.message : String(e);
    return { status: -1, stdout: '', stderr: msg, truncated: false };
  }
  // On timeout/kill/maxBuffer overrun, status is null; surface r.error so a caller never sees a
  // silent empty result.
  const rawStderr = r.stderr ?? '';
  const stderrText = r.error ? `${rawStderr}${r.error.message}`.trim() : rawStderr;
  const stdout = boundedCapture(r.stdout ?? '');
  const stderr = boundedCapture(stderrText);
  return {
    status: r.status ?? -1,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
  };
}

/** NUL-delimited split that drops the trailing empty element `-z` output leaves after the final NUL. */
function splitNul(s: string): string[] {
  const parts = s.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Named metadata-safe operations
// ---------------------------------------------------------------------------------------------

/** `git rev-parse <ref>` → resolved SHA, or null if the ref doesn't resolve (e.g. no commits yet). */
export function revParse(cwd: string, ref = 'HEAD'): string | null {
  const r = spawnGitRaw(['rev-parse', ref], cwd);
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

/** `git symbolic-ref <ref>` → the ref it points at (e.g. `refs/heads/main`), or null if not symbolic. */
export function symbolicRef(cwd: string, ref = 'HEAD'): string | null {
  const r = spawnGitRaw(['symbolic-ref', ref], cwd);
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

/** Best-effort default branch name: prefers the tracked `origin/HEAD` symlink, falls back to the
 *  current branch. Returns null if neither resolves (detached HEAD with no remote). */
export function defaultBranch(cwd: string): string | null {
  const originHead = symbolicRef(cwd, 'refs/remotes/origin/HEAD');
  if (originHead) return originHead.replace(/^refs\/remotes\/origin\//, '');
  const head = symbolicRef(cwd, 'HEAD');
  if (head) return head.replace(/^refs\/heads\//, '');
  return null;
}

/** Tracked file paths (optionally scoped by pathspec), via `git ls-files -z`. Never reads content. */
export function lsFiles(cwd: string, opts?: { paths?: readonly string[] }): string[] {
  const args = ['ls-files', '-z'];
  if (opts?.paths && opts.paths.length > 0) args.push('--', ...opts.paths);
  const r = spawnGitRaw(args, cwd);
  if (r.status !== 0) return [];
  return splitNul(r.stdout);
}

export interface LsTreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit' | string;
  hash: string;
  /** Blob byte size; null for tree/commit entries (git prints "-"). */
  size: number | null;
  path: string;
}

const LS_TREE_LINE_RE = /^(\d+) (\S+) ([0-9a-f]+)\s+(\d+|-)\t([\s\S]*)$/;

/** Recursive tree listing with sizes (`git ls-tree -l -r -z <ref>`) — path, mode, type, hash, size.
 *  This is the primitive for protected-path metadata: it records size/hash without ever reading
 *  blob content. Optionally scoped by pathspec. */
export function lsTree(cwd: string, ref: string, opts?: { paths?: readonly string[] }): LsTreeEntry[] {
  const args = ['ls-tree', '-l', '-r', '-z', ref];
  if (opts?.paths && opts.paths.length > 0) args.push('--', ...opts.paths);
  const r = spawnGitRaw(args, cwd);
  if (r.status !== 0) return [];
  const entries: LsTreeEntry[] = [];
  for (const line of splitNul(r.stdout)) {
    const m = LS_TREE_LINE_RE.exec(line);
    if (!m) continue;
    const [, mode, type, hash, sizeRaw, path] = m;
    entries.push({
      mode: mode as string,
      type: type as string,
      hash: hash as string,
      size: sizeRaw === '-' ? null : Number(sizeRaw),
      path: path as string,
    });
  }
  return entries;
}

/** `git cat-file -s <object>` → blob/tree byte size, or null if the object doesn't resolve. Never
 *  reads content — this is the size-only sibling of `cat-file -p`, which this module never wraps. */
export function catFileSize(cwd: string, objectId: string): number | null {
  const r = spawnGitRaw(['cat-file', '-s', objectId], cwd);
  if (r.status !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

/** `git cat-file -t <object>` → object type ("blob"/"tree"/"commit"/"tag"), or null if unresolved. */
export function catFileType(cwd: string, objectId: string): string | null {
  const r = spawnGitRaw(['cat-file', '-t', objectId], cwd);
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

export interface StatusEntry {
  /** Two-char porcelain status code, e.g. "M ", "??", " D". */
  code: string;
  path: string;
}

/** `git status --porcelain=v1 -z` parsed into entries. Read-only; used by the pre/post-inspection
 *  assertion helper (worker C's reuse target) to prove inspection never mutates the worktree. */
export function statusPorcelain(cwd: string): StatusEntry[] {
  const r = spawnGitRaw(['status', '--porcelain=v1', '-z'], cwd);
  if (r.status !== 0) return [];
  const entries: StatusEntry[] = [];
  const parts = splitNul(r.stdout);
  for (const part of parts) {
    if (part.length < 3) continue;
    entries.push({ code: part.slice(0, 2), path: part.slice(3) });
  }
  return entries;
}

export interface CommitSummary {
  hash: string;
  authorName: string;
  authorDate: string;
  subject: string;
}

const LOG_FIELD_SEP = '\x1f';
const LOG_RECORD_SEP = '\x1e';

/** `git log --format=... -z`-style summary — hash/author/date/subject only, NEVER `-p` (no patch
 *  content). Bounded by `opts.maxCount` (default 50) to keep evidence excerpts small. */
export function logSummary(cwd: string, opts?: { ref?: string; maxCount?: number }): CommitSummary[] {
  const maxCount = opts?.maxCount ?? 50;
  const format = `%H${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%aI${LOG_FIELD_SEP}%s${LOG_RECORD_SEP}`;
  const args = ['log', `--max-count=${maxCount}`, `--format=${format}`];
  if (opts?.ref) args.push(opts.ref);
  const r = spawnGitRaw(args, cwd);
  if (r.status !== 0) return [];
  const records = r.stdout.split(LOG_RECORD_SEP).filter((s) => s.trim().length > 0);
  const out: CommitSummary[] = [];
  for (const rec of records) {
    const [hash, authorName, authorDate, subject] = rec.replace(/^\n/, '').split(LOG_FIELD_SEP);
    if (!hash) continue;
    out.push({ hash, authorName: authorName ?? '', authorDate: authorDate ?? '', subject: subject ?? '' });
  }
  return out;
}

export interface DiffEntry {
  /** Single-letter status: A/M/D/R/C/T/U/X plus optional similarity suffix for R/C (e.g. "R100"). */
  status: string;
  path: string;
}

/** `git diff --name-status -z` between two refs — paths and change kind ONLY, never a patch/content. */
export function diffNameStatus(cwd: string, refA: string, refB: string): DiffEntry[] {
  const r = spawnGitRaw(['diff', '--name-status', '-z', refA, refB], cwd);
  if (r.status !== 0) return [];
  const parts = splitNul(r.stdout);
  const entries: DiffEntry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i];
    if (!status) continue;
    // Renames/copies emit an extra path field (old, new); treat the last field as the current path.
    const extra = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    const path = parts[i + extra];
    if (path !== undefined) entries.push({ status, path });
    i += extra - 1;
  }
  return entries;
}

/** `git branch -a --format=%(refname:short)` → local + remote branch short names. */
export function branchList(cwd: string): string[] {
  const r = spawnGitRaw(['branch', '-a', '--format=%(refname:short)'], cwd);
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** `git remote get-url <name>` → the remote URL, or null if the remote doesn't exist. */
export function remoteGetUrl(cwd: string, remote = 'origin'): string | null {
  const r = spawnGitRaw(['remote', 'get-url', remote], cwd);
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}
