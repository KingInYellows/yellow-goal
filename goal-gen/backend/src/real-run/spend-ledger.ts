/**
 * The real-run spend ledger (AGX-R16): JSON Lines, one entry per worker spawn, written to the
 * approved `evidence.spendLedgerPath`. Under the single-attempt policy (AGX-R10) a run spawns once,
 * so its ledger is created with that one entry: exclusive create, no-follow, owner-only, fsynced.
 * A pre-existing file or a symlink at the path is refused rather than appended to.
 *
 * The parent directory is opened and held `O_DIRECTORY|O_NOFOLLOW`, its canonical path is checked
 * against the approved parent through that descriptor, and the file is created relative to the
 * descriptor — so renaming the parent and putting a symlink in its place cannot redirect the write.
 * A same-UID process that swaps the parent after the final check can still race; the approved parent
 * is owner-controlled and not group/world-writable, so only same-UID processes can.
 */
import { closeSync, constants as fsConstants, fchmodSync, fsyncSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** Creates the ledger holding `entry`. Throws the raw errno error (`EEXIST`, `ELOOP`, …) on failure. */
export async function createSpendLedger(ledgerPath: string, entry: SpendLedgerEntry): Promise<void> {
  writeLedgerThroughParent(ledgerPath, `${JSON.stringify(entry)}\n`);
}

function writeLedgerThroughParent(ledgerPath: string, data: string): void {
  const parent = path.dirname(ledgerPath);
  const parentFd = openSync(parent, DIRECTORY_NOFOLLOW_FLAGS);
  try {
    const parentPath = pathThroughFd(parentFd, parent);
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
    closeSync(parentFd);
  }
}
