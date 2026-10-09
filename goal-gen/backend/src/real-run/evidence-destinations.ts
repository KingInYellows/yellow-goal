/**
 * Evidence-destination checks for a real run (AGX-R8a). The approved manifest fixes where the
 * candidate bundle and the spend ledger go. Before the approval is consumed, again once the
 * scratch worktree exists, and again just before each one is written, the engine refuses a
 * destination that could be confused with, or reached through, the worker's side of the run, or
 * whose parent another local user could swap or pre-fill. Every refusal is
 * EVIDENCE_DESTINATION_REFUSED. The bundle is then created through a held parent descriptor
 * (`persistCandidateBundleExclusive`), which closes the window after the last check.
 *
 * The existence check does not itself hold the path. After consumption and before spawn, the
 * engine exclusively creates a `<destination>.goal-gen-reserved` sentinel beside each destination
 * (sorted path order) and releases those sentinels when the run finishes. A second approval of the
 * same manifest loses that reservation and does not spawn. The sentinels are not the evidence
 * files: those are still exclusive-created later, so a held reservation must not be the bundle
 * directory or the ledger. The manifest only rejects equal or nested destinations, so one path
 * may be the other's `<destination>.goal-gen-reserved` sentinel. That pair is refused before the
 * approval is consumed and again before any sentinel is created: reserving it would exclusive-create
 * the other destination, the post-seed check would report that the path already exists, and
 * releasing the sentinel would unlink it. A retry would otherwise burn another approval and leave
 * nothing for the operator to inspect. A destination basename at the file-name limit can itself be
 * created, but the sentinel sibling cannot (`ENAMETOOLONG`). That name is refused before consumption
 * too, so a retry does not spend the approval. A crash leaves the sentinels in place; the next run
 * consumes its approval and then fails the reservation without spawning until the operator removes them.
 */
import { closeSync, constants as fsConstants, fchmodSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunApprovalError } from '../cli/errors';
import { O_NOFOLLOW_FLAG } from '../cli/fd-path';
import { isErrnoCode } from '../cli/run-approval';
import { isSameOrInside } from '../cli/run-manifest';

/** The tmpdir prefix of every real-run scratch worktree; no destination may live under one. */
export const REAL_RUN_WORKTREE_PREFIX = 'goal-gen-real-run-';

export type EvidenceDestinations = { bundleDir: string; spendLedgerPath: string };

export type EvidenceDestinationContext = {
  /** The request's `target.repository`; compared as a local path resolved from the cwd. */
  targetRepository?: string;
  /** The scratch repo root, once it exists (the post-seed re-check). */
  worktreeRoot?: string;
};

function refuse(destination: string, reason: string): never {
  throw new RunApprovalError('EVIDENCE_DESTINATION_REFUSED', `evidence destination ${destination} is refused: ${reason}`, {
    path: destination,
    reason,
  });
}

function errnoCode(err: unknown): string {
  return err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : 'unknown error';
}

/** `realpath` when the path exists, else its lexical absolute form. */
function resolveExisting(target: string): string {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Refuses one destination unless it is a fresh path under a symlink-free, operator-owned parent. */
export function assertEvidenceDestination(destination: string, context: EvidenceDestinationContext = {}): void {
  const parent = path.dirname(destination);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch (err) {
    refuse(destination, `its parent directory cannot be resolved (${isErrnoCode(err, 'ENOENT') ? 'missing' : errnoCode(err)})`);
  }
  // The manifest stored the canonical parent; a mismatch now means a symlink was put in the path.
  if (realParent !== parent) refuse(destination, `its parent resolves through a symlink to ${realParent}`);
  // Another local user who can write the parent could swap or pre-create the destination.
  const parentStat = lstatSync(parent);
  if (typeof process.getuid === 'function' && parentStat.uid !== process.getuid()) {
    refuse(destination, 'its parent directory is owned by another user');
  }
  if ((parentStat.mode & 0o022) !== 0) refuse(destination, 'its parent directory is group- or world-writable');
  let exists = true;
  try {
    lstatSync(destination);
  } catch (err) {
    if (!isErrnoCode(err, 'ENOENT')) refuse(destination, `it cannot be inspected (${errnoCode(err)})`);
    exists = false;
  }
  if (exists) refuse(destination, 'it already exists');
  if (context.targetRepository !== undefined && isSameOrInside(destination, resolveExisting(context.targetRepository))) {
    refuse(destination, 'it is inside the request target repository');
  }
  if (context.worktreeRoot !== undefined && isSameOrInside(destination, resolveExisting(context.worktreeRoot))) {
    refuse(destination, 'it is inside the scratch worktree');
  }
  const relativeToTmp = path.relative(resolveExisting(tmpdir()), destination);
  const outsideTmp = relativeToTmp === '..' || relativeToTmp.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToTmp);
  const firstSegment = relativeToTmp.split(path.sep)[0] ?? '';
  if (!outsideTmp && firstSegment.startsWith(REAL_RUN_WORKTREE_PREFIX)) {
    refuse(destination, 'it is inside a real-run scratch worktree directory');
  }
}

/** Refuses unless both destinations are fresh paths under a symlink-free, engine-unrelated parent, and neither reservation path is the other destination. */
export function assertEvidenceDestinations(evidence: EvidenceDestinations, context: EvidenceDestinationContext = {}): void {
  assertSentinelDoesNotAliasDestination(evidence);
  assertEvidenceDestination(evidence.bundleDir, context);
  assertEvidenceDestination(evidence.spendLedgerPath, context);
}

/** Sibling of an evidence path. Not the path itself — the bundle and ledger are created later. */
const RESERVATION_SUFFIX = '.goal-gen-reserved';

/** `NAME_MAX` on common local filesystems. The reservation sibling is one directory entry. */
const SENTINEL_NAME_MAX_BYTES = 255;

const RESERVATION_BODY = 'yellow-goal/evidence-reservation/v1\n';

/** Sentinels this run created. Only these may be removed; a peer's sentinel must be left alone. */
export type EvidenceReservation = { readonly sentinels: readonly string[] };

function sentinelPath(destination: string): string {
  return `${destination}${RESERVATION_SUFFIX}`;
}

/**
 * The manifest rejects equal or nested paths only, so one destination can be named the other's
 * sentinel. Refuse before creating anything: an exclusive create at that path is the other
 * evidence file, and releasing the sentinel would unlink it. Also refuse a sentinel basename over
 * `NAME_MAX`: the destination itself can still be created, and discovering `ENAMETOOLONG` only
 * inside `reserveEvidenceDestinations` would spend the approval with nothing spawned.
 */
function assertSentinelDoesNotAliasDestination(evidence: EvidenceDestinations): void {
  const destinations = new Set([evidence.bundleDir, evidence.spendLedgerPath]);
  for (const destination of destinations) {
    const sentinel = sentinelPath(destination);
    if (destinations.has(sentinel)) {
      refuse(destination, `its reservation path ${sentinel} is the other evidence destination`);
    }
    const bytes = Buffer.byteLength(path.basename(sentinel));
    if (bytes > SENTINEL_NAME_MAX_BYTES) {
      refuse(destination, `its reservation name is ${bytes} bytes, over the ${SENTINEL_NAME_MAX_BYTES}-byte file-name limit`);
    }
  }
}

function fsyncDirectorySync(dirPath: string): void {
  const fd = openSync(dirPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | O_NOFOLLOW_FLAG);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Exclusive-creates one sentinel. On a failure after the create, removes it and rethrows the raw error. */
function createSentinelSync(sentinel: string): void {
  const fd = openSync(sentinel, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW_FLAG, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, RESERVATION_BODY, 'utf8');
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(sentinel);
    } catch (cleanupErr) {
      throw new Error(`write to ${sentinel} failed and the partial file could not be removed`, {
        cause: new AggregateError([err, cleanupErr]),
      });
    }
    throw err;
  }
  closeSync(fd);
  try {
    fsyncDirectorySync(path.dirname(sentinel));
  } catch (err) {
    try {
      unlinkSync(sentinel);
    } catch {
      // A leftover sentinel fails closed on the next run; the original error still surfaces.
    }
    throw err;
  }
}

function releaseSentinels(sentinels: readonly string[]): void {
  for (const sentinel of [...sentinels].reverse()) {
    try {
      unlinkSync(sentinel);
    } catch (err) {
      if (!isErrnoCode(err, 'ENOENT')) {
        // Leave the sentinel. The next run fails closed, and release must not mask the outcome.
      }
    }
  }
}

/**
 * Holds both destinations before spawn. Lock order is the sorted destination path, so two runs
 * cannot each take one sentinel and both lose. `EEXIST` / `ELOOP` means another run (or a leftover
 * sentinel) already holds the path. A partial hold is released before the refusal. A sentinel that
 * is either destination is refused before any create, so the other evidence path is never written.
 */
export function reserveEvidenceDestinations(evidence: EvidenceDestinations): EvidenceReservation {
  assertSentinelDoesNotAliasDestination(evidence);
  const destinations = [evidence.bundleDir, evidence.spendLedgerPath].slice().sort();
  const sentinels: string[] = [];
  for (const destination of destinations) {
    const sentinel = sentinelPath(destination);
    try {
      createSentinelSync(sentinel);
    } catch (err) {
      releaseSentinels(sentinels);
      const held = isErrnoCode(err, 'EEXIST') || isErrnoCode(err, 'ELOOP');
      refuse(destination, held ? 'it is reserved by another real run' : `it could not be reserved (${errnoCode(err)})`);
    }
    sentinels.push(sentinel);
  }
  return { sentinels };
}

/** Drops a hold this run created. A missing sentinel is already released. Never throws. */
export function releaseEvidenceReservation(reservation: EvidenceReservation | undefined): void {
  if (reservation === undefined) return;
  releaseSentinels(reservation.sentinels);
}
