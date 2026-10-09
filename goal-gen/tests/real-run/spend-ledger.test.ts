/**
 * AGX-R16: one `yellow-goal/real-run-spend/v1` JSON Lines entry per worker spawn, whatever the
 * spawn's outcome; none for a refusal. The ledger is created exclusively and never follows or
 * appends to an existing path.
 */
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseEvidenceReservation, reservationParentFd, reserveEvidenceDestinations } from '../../backend/src/real-run/evidence-destinations';
import { createSpendLedger, SpendLedgerSchemaVersion, type SpendLedgerEntry } from '../../backend/src/real-run/spend-ledger';
import {
  createFixture,
  invocations,
  ledgerEntries,
  manifestArgs,
  mintApproval,
  removeFixture,
  runEngine,
  stubCleanCredentials,
  type Fixture,
} from './support';

let fx: Fixture;

beforeEach(async () => {
  stubCleanCredentials();
  fx = await createFixture();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeFixture(fx);
});

describe('spend ledger entries (AGX-R16)', () => {
  it.each<[string, string, boolean]>([
    ['success', 'success', true],
    ['budget-stop', 'budget', true],
    ['max-turns', 'max-turns', true],
    ['missing-cost', 'cost-unmetered', false],
  ])('%s: exactly one entry with exitClass %s', async (scenario, exitClass, metered) => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    await runEngine(fx, scenario, args);
    const entries = ledgerEntries(fx);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toMatchObject({ schemaVersion: SpendLedgerSchemaVersion, approvalId, model: 'sonnet', exitClass });
    expect(Object.keys(entry!).sort()).toEqual(
      ['approvalId', 'costUsd', 'durationMs', 'endedAt', 'exitClass', 'model', 'schemaVersion', 'startedAt', 'turns'].sort(),
    );
    if (metered) expect(entry!.costUsd).toEqual(expect.any(Number));
    else expect(entry!.costUsd).toBeNull();
    expect(entry!.durationMs).toEqual(expect.any(Number));
    expect(Date.parse(entry!.endedAt as string)).toBeGreaterThanOrEqual(Date.parse(entry!.startedAt as string));
    // Owner-only, like the approval files.
    expect((await stat(fx.ledgerPath)).mode & 0o777).toBe(0o600);
  });

  it('records turns from the envelope when present', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    await runEngine(fx, 'max-turns', args);
    expect(ledgerEntries(fx)[0]!.turns).toEqual(expect.any(Number));
  });

  it('a cancelled spawn is still metered once', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const controller = new AbortController();
    // Abort only once the worker has recorded its invocation, so the spawn really happened.
    const abortWhenSpawned = async (): Promise<void> => {
      while (invocations(fx).length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
    };
    await Promise.all([runEngine(fx, 'hang', args, { signal: controller.signal }), abortWhenSpawned()]);
    expect(ledgerEntries(fx)).toEqual([expect.objectContaining({ exitClass: 'cancel', costUsd: null })]);
  });

  it('a refusal writes no ledger', async () => {
    const outcome = await runEngine(fx, 'success', manifestArgs(fx), { approvalPath: undefined });
    expect(outcome.kind).toBe('refused');
    expect(() => lstatSync(fx.ledgerPath)).toThrow();
    expect(invocations(fx)).toHaveLength(0);
  });

  it.each<[string, (ledger: string, dir: string) => Promise<void>]>([
    ['a pre-existing ledger file', (ledger) => writeFile(ledger, '{"prior":true}\n', 'utf8')],
    ['a dangling symlink at the ledger path', (ledger, dir) => symlink(path.join(dir, 'elsewhere.jsonl'), ledger)],
  ])('%s is refused before consumption', async (_label, plant) => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    await plant(fx.ledgerPath, fx.dir);
    const outcome = await runEngine(fx, 'success', args);
    expect(outcome).toMatchObject({ kind: 'refused', code: 'EVIDENCE_DESTINATION_REFUSED' });
    expect(invocations(fx)).toHaveLength(0);
  });
});

describe('createSpendLedger', () => {
  const entry: SpendLedgerEntry = {
    schemaVersion: SpendLedgerSchemaVersion,
    approvalId: '00000000-0000-4000-8000-000000000001',
    model: 'sonnet',
    costUsd: null,
    turns: null,
    durationMs: 0,
    exitClass: 'cancel',
    startedAt: '2026-09-29T00:00:00.000Z',
    endedAt: '2026-09-29T00:00:00.000Z',
  };

  it('refuses an existing file and a symlink instead of appending or following', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'goal-gen-ledger-unit-'));
    try {
      const existing = path.join(dir, 'existing.jsonl');
      await writeFile(existing, 'prior\n', 'utf8');
      await expect(createSpendLedger(existing, entry)).rejects.toMatchObject({ code: 'EEXIST' });
      const link = path.join(dir, 'link.jsonl');
      await symlink(path.join(dir, 'target.jsonl'), link);
      await expect(createSpendLedger(link, entry)).rejects.toMatchObject({ code: expect.stringMatching(/^(EEXIST|ELOOP)$/) as unknown as string });
      await expect(stat(path.join(dir, 'target.jsonl'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a parent swapped for a symlink and writes nothing at the symlink target', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'goal-gen-ledger-parent-'));
    try {
      const real = path.join(dir, 'evidence-real');
      await mkdir(real);
      const parent = path.join(dir, 'evidence');
      await symlink(real, parent);
      await expect(createSpendLedger(path.join(parent, 'ledger.jsonl'), entry)).rejects.toThrow();
      await expect(stat(path.join(real, 'ledger.jsonl'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a held parent descriptor is not redirected into a replacement directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'goal-gen-ledger-held-'));
    const parent = path.join(dir, 'evidence');
    const moved = `${parent}-moved`;
    const ledgerPath = path.join(parent, 'spend.jsonl');
    await mkdir(parent);
    const reservation = reserveEvidenceDestinations({ bundleDir: path.join(parent, 'bundle'), spendLedgerPath: ledgerPath });
    try {
      await rename(parent, moved);
      await mkdir(parent);
      await expect(createSpendLedger(ledgerPath, entry, reservationParentFd(reservation, ledgerPath))).rejects.toThrow(/now resolves to/);
      expect(existsSync(path.join(parent, 'spend.jsonl'))).toBe(false);
      expect(existsSync(path.join(moved, 'spend.jsonl'))).toBe(false);
      releaseEvidenceReservation(reservation);
      expect(existsSync(path.join(moved, 'spend.jsonl.goal-gen-reserved'))).toBe(false);
      expect(existsSync(path.join(parent, 'spend.jsonl.goal-gen-reserved'))).toBe(false);
    } finally {
      releaseEvidenceReservation(reservation);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
