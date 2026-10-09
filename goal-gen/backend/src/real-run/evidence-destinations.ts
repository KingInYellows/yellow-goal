/**
 * Evidence-destination checks for a real run (AGX-R8a). The approved manifest fixes where the
 * candidate bundle and the spend ledger go. Before the approval is consumed, again once the
 * scratch worktree exists, and again just before each one is written, the engine refuses a
 * destination that could be confused with, or reached through, the worker's side of the run, or
 * whose parent another local user could swap or pre-fill. Every refusal is
 * EVIDENCE_DESTINATION_REFUSED. The ledger and the bundle are then created through the
 * reservation's held parent descriptor, which closes the window after the last check.
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
 * nothing for the operator to inspect. The same collision exists across runs: a destination whose
 * own path ends with `.goal-gen-reserved` is some other run's sentinel. That name is refused before
 * consumption, not only when it aliases the sibling in this manifest. A destination basename at the
 * file-name limit can itself be created, but the sentinel sibling cannot (`ENAMETOOLONG`). That name
 * is refused before consumption too, so a retry does not spend the approval. The sentinel is created
 * and removed through a parent directory opened `O_DIRECTORY|O_NOFOLLOW` and held until release, the
 * same way the evidence files are written, so swapping an ancestor for a symlink cannot redirect the
 * reservation. The approved path is checked against that held directory again before spawn and
 * before each evidence write: a replacement directory at the same pathname is not the one reserved,
 * so this run does not spawn into it or write there. A crash leaves the sentinels in place; the next run consumes its approval and then
 * fails the reservation without spawning until the operator removes them.
 */
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunApprovalError } from '../cli/errors';
import { DIRECTORY_NOFOLLOW_FLAGS, O_NOFOLLOW_FLAG, pathThroughFd } from '../cli/fd-path';
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

/** Refuses unless both destinations are fresh paths under a symlink-free, engine-unrelated parent, neither is a reservation name, and neither reservation path is the other destination. */
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

/**
 * One sentinel this run created. `parentFd` is the approved parent, held until release so create
 * and unlink stay on that directory after an ancestor is renamed. Only these may be removed.
 */
type HeldSentinel = {
  readonly parentFd: number;
  readonly parent: string;
  readonly name: string;
  readonly destination: string;
};

/** Sentinels this run created. A peer's sentinel must be left alone. */
export type EvidenceReservation = { readonly held: readonly HeldSentinel[] };

function sentinelPath(destination: string): string {
  return `${destination}${RESERVATION_SUFFIX}`;
}

/**
 * The manifest rejects equal or nested paths only, so one destination can be named the other's
 * sentinel. Refuse before creating anything: an exclusive create at that path is the other
 * evidence file, and releasing the sentinel would unlink it. A destination that merely ends with
 * the reservation suffix is the same collision against some other run, so it is refused even when
 * this manifest's other path is unrelated. Also refuse a sentinel basename over `NAME_MAX`: the
 * destination itself can still be created, and discovering `ENAMETOOLONG` only inside
 * `reserveEvidenceDestinations` would spend the approval with nothing spawned.
 */
function assertSentinelDoesNotAliasDestination(evidence: EvidenceDestinations): void {
  const destinations = new Set([evidence.bundleDir, evidence.spendLedgerPath]);
  // The pair check first: one path being the other's sentinel has the more specific refusal.
  for (const destination of destinations) {
    const sentinel = sentinelPath(destination);
    if (destinations.has(sentinel)) {
      refuse(destination, `its reservation path ${sentinel} is the other evidence destination`);
    }
  }
  for (const destination of destinations) {
    if (destination.endsWith(RESERVATION_SUFFIX)) {
      refuse(destination, `it ends with the reservation suffix ${RESERVATION_SUFFIX}, so it is another run's sentinel path`);
    }
    const bytes = Buffer.byteLength(path.basename(sentinelPath(destination)));
    if (bytes > SENTINEL_NAME_MAX_BYTES) {
      refuse(destination, `its reservation name is ${bytes} bytes, over the ${SENTINEL_NAME_MAX_BYTES}-byte file-name limit`);
    }
  }
}

function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed, or never a live descriptor. Release must not mask the outcome.
  }
}

/** Opens `dirname(destination)` and refuses unless that descriptor is still the approved parent. */
function openReservationParent(destination: string): number {
  const parent = path.dirname(destination);
  let parentFd: number;
  try {
    parentFd = openSync(parent, DIRECTORY_NOFOLLOW_FLAGS);
  } catch (err) {
    if (isErrnoCode(err, 'ELOOP') || isErrnoCode(err, 'ENOTDIR')) {
      refuse(destination, 'its parent resolves through a symlink');
    }
    throw err;
  }
  try {
    const held = realpathSync(pathThroughFd(parentFd, parent));
    if (held !== parent) refuse(destination, `its parent now resolves to ${held}`);
    return parentFd;
  } catch (err) {
    closeQuiet(parentFd);
    throw err;
  }
}

/**
 * Exclusive-creates one sentinel through the held parent. On a failure after the create, removes
 * it through that descriptor and rethrows. The caller closes `parentFd` unless it is returned.
 */
function createSentinelSync(destination: string): HeldSentinel {
  const parent = path.dirname(destination);
  const name = `${path.basename(destination)}${RESERVATION_SUFFIX}`;
  const parentFd = openReservationParent(destination);
  const parentPath = pathThroughFd(parentFd, parent);
  const target = path.join(parentPath, name);
  try {
    const fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW_FLAG, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, RESERVATION_BODY, 'utf8');
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      try {
        unlinkSync(target);
      } catch (cleanupErr) {
        throw new Error(`write to ${path.join(parent, name)} failed and the partial file could not be removed`, {
          cause: new AggregateError([err, cleanupErr]),
        });
      }
      throw err;
    }
    closeSync(fd);
    try {
      fsyncSync(parentFd);
    } catch (err) {
      try {
        unlinkSync(target);
      } catch {
        // A leftover sentinel fails closed on the next run; the original error still surfaces.
      }
      throw err;
    }
    return { parentFd, parent, name, destination };
  } catch (err) {
    closeQuiet(parentFd);
    throw err;
  }
}

function releaseSentinels(sentinels: readonly HeldSentinel[]): void {
  for (const sentinel of [...sentinels].reverse()) {
    try {
      const parentPath = pathThroughFd(sentinel.parentFd, sentinel.parent);
      unlinkSync(path.join(parentPath, sentinel.name));
    } catch (err) {
      if (!isErrnoCode(err, 'ENOENT')) {
        // Leave the sentinel. The next run fails closed, and release must not mask the outcome.
      }
    } finally {
      closeQuiet(sentinel.parentFd);
    }
  }
}

/**
 * Holds both destinations before spawn. Lock order is the sorted destination path, so two runs
 * cannot each take one sentinel and both lose. `EEXIST` / `ELOOP` on the sentinel means another
 * run (or a leftover sentinel) already holds the path. A partial hold is released before the
 * refusal. A sentinel that is either destination, or a destination that is itself a sentinel name,
 * is refused before any create, so an evidence path is never written or unlinked as a reservation.
 */
export function reserveEvidenceDestinations(evidence: EvidenceDestinations): EvidenceReservation {
  assertSentinelDoesNotAliasDestination(evidence);
  const destinations = [evidence.bundleDir, evidence.spendLedgerPath].slice().sort();
  const sentinels: HeldSentinel[] = [];
  for (const destination of destinations) {
    try {
      sentinels.push(createSentinelSync(destination));
    } catch (err) {
      releaseSentinels(sentinels);
      if (err instanceof RunApprovalError) throw err;
      const held = isErrnoCode(err, 'EEXIST') || isErrnoCode(err, 'ELOOP');
      refuse(destination, held ? 'it is reserved by another real run' : `it could not be reserved (${errnoCode(err)})`);
    }
  }
  return { held: sentinels };
}

/**
 * The held parent must still be the directory at the approved path. A rename plus a new real
 * directory at that path leaves the sentinel in the old directory while later pathname checks and
 * writers would use the replacement, so a second approval could reserve it and both workers would
 * spawn. Call before spawn and before each evidence write.
 */
export function assertReservationStillBound(reservation: EvidenceReservation | undefined): void {
  if (reservation === undefined) throw new Error('evidence reservation is missing');
  for (const sentinel of reservation.held) {
    let pathFd: number | undefined;
    try {
      pathFd = openSync(sentinel.parent, DIRECTORY_NOFOLLOW_FLAGS);
      const heldStat = fstatSync(sentinel.parentFd);
      const pathStat = fstatSync(pathFd);
      if (heldStat.dev !== pathStat.dev || heldStat.ino !== pathStat.ino) {
        refuse(sentinel.destination, 'its parent no longer names the directory this run reserved');
      }
    } catch (err) {
      if (err instanceof RunApprovalError) throw err;
      if (isErrnoCode(err, 'ENOENT') || isErrnoCode(err, 'ELOOP') || isErrnoCode(err, 'ENOTDIR')) {
        refuse(sentinel.destination, 'its parent no longer names the directory this run reserved');
      }
      throw err;
    } finally {
      if (pathFd !== undefined) closeQuiet(pathFd);
    }
  }
}

/**
 * The parent descriptor held for `destination`. Release closes it; a writer must not.
 * Creating the ledger or bundle through this descriptor keeps a replaced pathname from receiving them.
 */
export function reservationParentFd(reservation: EvidenceReservation, destination: string): number {
  const held = reservation.held.find((entry) => entry.destination === destination);
  if (held === undefined) throw new Error(`evidence reservation is missing ${destination}`);
  return held.parentFd;
}

/** Drops a hold this run created. A missing sentinel is already released. Never throws. */
export function releaseEvidenceReservation(reservation: EvidenceReservation | undefined): void {
  if (reservation === undefined) return;
  releaseSentinels(reservation.held);
}
