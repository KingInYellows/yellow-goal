/**
 * Builds the real run's candidate from the scratch worktree (AGX-R17). Only the profile's allowed
 * paths are read, each through a descriptor chain rooted at an `O_NOFOLLOW` open of the worktree:
 * `lstat` classifies the entry first, so a symlink, FIFO, device, socket, directory or oversize
 * entry is never opened for reading, and the opened descriptor must be the same regular file the
 * `lstat` saw. A missing allowed path is simply absent from the candidate — the verifier decides.
 *
 * Changes outside the allowed paths are listed by name only, as evidence; they never fail the run
 * (AGX-R34 probe decision: acceptEdits does not confine in-worktree writes, allowed-paths-only
 * extraction does). Ignored files are listed too, with no global excludes file, so a worker-written
 * `.gitignore` cannot hide them.
 *
 * The descriptor chain relies on Linux `/proc/self/fd`; elsewhere it falls back to the canonical
 * worktree path, which is safe only while allowed paths stay top-level (as every profile's are).
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import {
  CANDIDATE_MAX_FILE_BYTES,
  CandidateFileContentSchemaVersion,
  type CandidateFileDocument,
  type CandidateOfflineProfile,
} from '../cli/candidate-offline-profiles';
import { DIRECTORY_NOFOLLOW_FLAGS, O_NOFOLLOW_FLAG, pathThroughFd } from '../cli/fd-path';
import { isErrnoCode } from '../cli/run-approval';
import { parsePorcelainPaths, pinnedGit } from '../executors/worktree';

export type UnsafeEntryKind =
  | 'symlink'
  | 'fifo'
  | 'device'
  | 'socket'
  | 'directory'
  | 'not-a-directory'
  | 'oversize'
  | 'swapped'
  | 'unreadable';

export type CandidateBuildResult =
  | { ok: true; candidate: CandidateFileDocument; outOfScopeChanges: string[] | null }
  | { ok: false; reason: 'unsafe-allowed-path'; evidence: { path: string; kind: UnsafeEntryKind } }
  | { ok: false; reason: 'non-utf8-candidate'; evidence: { path: string } };

type EntryRead =
  | { kind: 'missing' }
  | { kind: 'text'; text: string }
  | { kind: 'unsafe'; entry: UnsafeEntryKind }
  | { kind: 'non-utf8' };

const DIRECTORY_FLAGS = DIRECTORY_NOFOLLOW_FLAGS;
const FILE_FLAGS = fsConstants.O_RDONLY | O_NOFOLLOW_FLAG | (fsConstants.O_NONBLOCK ?? 0);

function classify(stat: Stats): UnsafeEntryKind {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isCharacterDevice() || stat.isBlockDevice()) return 'device';
  if (stat.isSocket()) return 'socket';
  if (stat.isDirectory()) return 'directory';
  return 'unreadable';
}

function lstatOrMissing(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return undefined;
    throw err;
  }
}

function readBounded(fd: number, maxBytes: number): Buffer | undefined {
  const buf = Buffer.alloc(maxBytes + 1);
  let total = 0;
  for (;;) {
    const n = readSync(fd, buf, total, buf.length - total, total);
    if (n === 0) return buf.subarray(0, total);
    total += n;
    if (total > maxBytes) return undefined;
  }
}

function readAllowedEntry(rootFd: number, rootPath: string, relative: string, maxBytes: number): EntryRead {
  const segments = relative.split('/');
  const leafName = segments.pop()!;
  const opened: number[] = [];
  try {
    let dirFd = rootFd;
    let dirPath = rootPath;
    for (const segment of segments) {
      const next = path.join(pathThroughFd(dirFd, dirPath), segment);
      const stat = lstatOrMissing(next);
      if (stat === undefined) return { kind: 'missing' };
      if (!stat.isDirectory()) return { kind: 'unsafe', entry: stat.isFile() ? 'not-a-directory' : classify(stat) };
      dirFd = openSync(next, DIRECTORY_FLAGS);
      opened.push(dirFd);
      dirPath = path.join(dirPath, segment);
    }
    const leaf = path.join(pathThroughFd(dirFd, dirPath), leafName);
    const stat = lstatOrMissing(leaf);
    if (stat === undefined) return { kind: 'missing' };
    if (!stat.isFile()) return { kind: 'unsafe', entry: classify(stat) };
    if (stat.size > maxBytes) return { kind: 'unsafe', entry: 'oversize' };
    let fd: number;
    try {
      fd = openSync(leaf, FILE_FLAGS);
    } catch (err) {
      if (isErrnoCode(err, 'ENOENT')) return { kind: 'missing' };
      if (isErrnoCode(err, 'ELOOP')) return { kind: 'unsafe', entry: 'symlink' };
      return { kind: 'unsafe', entry: 'unreadable' };
    }
    opened.push(fd);
    const held = fstatSync(fd);
    if (!held.isFile() || held.ino !== stat.ino || held.dev !== stat.dev) return { kind: 'unsafe', entry: 'swapped' };
    const bytes = readBounded(fd, maxBytes);
    if (bytes === undefined) return { kind: 'unsafe', entry: 'oversize' };
    try {
      // ignoreBOM keeps a leading BOM: the candidate must be exactly the bytes the worker wrote.
      return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch {
      return { kind: 'non-utf8' };
    }
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return { kind: 'missing' };
    if (isErrnoCode(err, 'ELOOP')) return { kind: 'unsafe', entry: 'symlink' };
    if (isErrnoCode(err, 'ENOTDIR')) return { kind: 'unsafe', entry: 'not-a-directory' };
    return { kind: 'unsafe', entry: 'unreadable' };
  } finally {
    for (const fd of opened) closeSync(fd);
  }
}

/** Changed paths outside `allowedPaths`, sorted; `null` when git cannot list them. */
function outOfScopeChanges(worktreePath: string, gitDir: string | undefined, allowedPaths: readonly string[]): string[] | null {
  const status = pinnedGit(
    ['-c', 'core.excludesFile=/dev/null', 'status', '--porcelain', '-z', '--untracked-files=all', '--ignored=traditional'],
    worktreePath,
    gitDir,
  );
  if (status.status !== 0) return null;
  const changed = parsePorcelainPaths(status.stdout).filter((changedPath) => !allowedPaths.includes(changedPath));
  return [...new Set(changed)].sort();
}

export function buildRealRunCandidate(
  worktreePath: string,
  profile: CandidateOfflineProfile,
  gitDir: string | undefined,
): CandidateBuildResult {
  const rootPath = realpathSync(worktreePath);
  const rootFd = openSync(rootPath, DIRECTORY_FLAGS);
  const files = Object.create(null) as Record<string, string>;
  // The same per-file ceiling `acceptance verify-candidate` applies to a candidate document.
  const maxFileBytes = Math.min(profile.maxFileBytes, CANDIDATE_MAX_FILE_BYTES);
  try {
    for (const relative of profile.allowedPaths) {
      const read = readAllowedEntry(rootFd, rootPath, relative, maxFileBytes);
      if (read.kind === 'missing') continue;
      if (read.kind === 'unsafe') return { ok: false, reason: 'unsafe-allowed-path', evidence: { path: relative, kind: read.entry } };
      if (read.kind === 'non-utf8') return { ok: false, reason: 'non-utf8-candidate', evidence: { path: relative } };
      files[relative] = read.text;
    }
  } finally {
    closeSync(rootFd);
  }
  return {
    ok: true,
    candidate: { schemaVersion: CandidateFileContentSchemaVersion, files },
    outOfScopeChanges: outOfScopeChanges(worktreePath, gitDir, profile.allowedPaths),
  };
}
