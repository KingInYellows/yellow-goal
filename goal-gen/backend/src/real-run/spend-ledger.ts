/**
 * The real-run spend ledger (AGX-R16): JSON Lines, one entry per worker spawn, written to the
 * approved `evidence.spendLedgerPath`. Under the single-attempt policy (AGX-R10) a run spawns once,
 * so its ledger is created with that one entry: exclusive create, no-follow, owner-only, fsynced.
 * A pre-existing file or a symlink at the path is refused rather than appended to.
 *
 * The parent is the reservation's already-held descriptor when the caller has one, and this
 * function does not close that descriptor. Otherwise the parent is opened `O_DIRECTORY|O_NOFOLLOW`.
 * Its canonical path is checked through that descriptor, and the file is created relative to it, so
 * a renamed parent with a new directory at the approved path is not written. A caller-supplied
 * descriptor fails closed where `/proc/self/fd` is absent rather than reopening the pathname.
 */
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fsyncSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DIRECTORY_NOFOLLOW_FLAGS, O_NOFOLLOW_FLAG, pathThroughFd } from '../cli/fd-path';
import type { SpendExitClass } from './outcome';

export const SpendLedgerSchemaVersion = 'yellow-goal/real-run-spend/v1' as const;

export type SpendLedgerEntry = {
  schemaVersion: typeof SpendLedgerSchemaVersion;
  approvalId: string;
  model: string;
  /** `null` when the worker produced no cost figure — never defaulted to 0 (AGX-R12). */
  costUsd: number | null;
  turns: number | null;
  durationMs: number;
  exitClass: SpendExitClass;
  startedAt: string;
  endedAt: string;
};

/**
 * Creates the ledger holding `entry`. `heldParentFd` is the reservation's parent descriptor and is
 * not closed here. Throws the raw errno error (`EEXIST`, `ELOOP`, …) on failure.
 */
export async function createSpendLedger(ledgerPath: string, entry: SpendLedgerEntry, heldParentFd?: number): Promise<void> {
  writeLedgerThroughParent(ledgerPath, `${JSON.stringify(entry)}\n`, heldParentFd);
}

function parentPathForWrite(parentFd: number, parent: string, descriptorRequired: boolean): string {
  const proc = `/proc/self/fd/${parentFd}`;
  if (descriptorRequired) {
    if (!existsSync(proc)) throw new Error(`ledger parent ${parent} cannot be written through its held descriptor`);
    return proc;
  }
  return pathThroughFd(parentFd, parent);
}

function writeLedgerThroughParent(ledgerPath: string, data: string, heldParentFd?: number): void {
  const parent = path.dirname(ledgerPath);
  const ownsParent = heldParentFd === undefined;
  const parentFd = heldParentFd ?? openSync(parent, DIRECTORY_NOFOLLOW_FLAGS);
  try {
    const parentPath = parentPathForWrite(parentFd, parent, !ownsParent);
    const held = realpathSync(parentPath);
    if (held !== parent) throw new Error(`ledger parent ${parent} now resolves to ${held}`);
    const target = path.join(parentPath, path.basename(ledgerPath));
    const fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW_FLAG, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, data, 'utf8');
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      try {
        unlinkSync(target);
      } catch (cleanupErr) {
        throw new Error(`write to ${ledgerPath} failed and the partial file could not be removed`, {
          cause: new AggregateError([err, cleanupErr]),
        });
      }
      throw err;
    }
    closeSync(fd);
    fsyncSync(parentFd);
  } finally {
    if (ownsParent) closeSync(parentFd);
  }
}
