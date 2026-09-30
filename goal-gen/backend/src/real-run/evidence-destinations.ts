/**
 * Evidence-destination checks for a real run (AGX-R8a). The approved manifest fixes where the
 * candidate bundle and the spend ledger go. Before the approval is consumed, again once the
 * scratch worktree exists, and again just before each one is written, the engine refuses a
 * destination that could be confused with, or reached through, the worker's side of the run, or
 * whose parent another local user could swap or pre-fill. Every refusal is
 * EVIDENCE_DESTINATION_REFUSED. The bundle is then created through a held parent descriptor
 * (`persistCandidateBundleExclusive`), which closes the window after the last check.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunApprovalError } from '../cli/errors';
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

/** Refuses unless both destinations are fresh paths under a symlink-free, engine-unrelated parent. */
export function assertEvidenceDestinations(evidence: EvidenceDestinations, context: EvidenceDestinationContext = {}): void {
  assertEvidenceDestination(evidence.bundleDir, context);
  assertEvidenceDestination(evidence.spendLedgerPath, context);
}
