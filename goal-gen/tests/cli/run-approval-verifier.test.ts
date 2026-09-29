/**
 * ADR-0020 / AGX-R4, AGX-R5, AGX-R6: each pre-spawn refusal has a distinct code, and an approval
 * is consumed exactly once — even under concurrent starts.
 */
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunApprovalError } from '../../backend/src/cli/errors';
import { fsyncDirectory, mintRunApprovalRecord, parseRunApprovalRecord, writeFileExclusive, type RunApprovalRecord } from '../../backend/src/cli/run-approval';
import {
  approvalMarkerPath,
  consumeRunApproval,
  defaultApprovalStateDir,
  newlyCreatedDirParents,
  verifyRunApproval,
} from '../../backend/src/cli/run-approval-verifier';
import { buildRunManifest, type RunManifest, type RunManifestInputs } from '../../backend/src/cli/run-manifest';
import { RepositoryGoalRequestSchema } from '../../backend/src/contracts/request';
import { requestExecutionSample as rawRequestExecutionSample } from '../contracts/support/samples';

const requestExecutionSample = RepositoryGoalRequestSchema.parse(rawRequestExecutionSample);

const MINTED_AT = new Date('2026-09-28T12:00:00.000Z');
const DURING = () => new Date('2026-09-28T12:30:00.000Z');

function manifest(overrides: Partial<RunManifestInputs> = {}): RunManifest {
  return buildRunManifest({
    engineVersion: '0.2.0',
    request: requestExecutionSample,
    profileId: 'config-repair',
    model: 'sonnet',
    allowedTools: ['Read', 'Edit'],
    disallowedTools: [],
    maxTurns: 8,
    perActionUsd: 1,
    totalUsd: 5,
    actionTimeoutMs: 300_000,
    runWallClockMs: 1_800_000,
    authMode: 'subscription',
    expiresInMinutes: 60,
    ...overrides,
  });
}

let tempDir: string;
let stateDir: string;
let approvalPath: string;
let record: RunApprovalRecord;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'goal-gen-run-verify-'));
  stateDir = path.join(tempDir, 'state');
  approvalPath = path.join(tempDir, 'approval.json');
  record = mintRunApprovalRecord(manifest(), { clock: () => MINTED_AT });
  await writeFileExclusive(approvalPath, `${JSON.stringify(record, null, 2)}\n`);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function verify(overrides: { approvalPath?: string | undefined; expectedManifest?: RunManifest; engineVersion?: string; clock?: () => Date; stateDir?: string } = {}) {
  return verifyRunApproval({
    approvalPath,
    expectedManifest: manifest(),
    engineVersion: '0.2.0',
    clock: DURING,
    stateDir,
    ...overrides,
  });
}

const consume = (verified: Awaited<ReturnType<typeof verify>>) => consumeRunApproval(verified, { clock: DURING, stateDir });

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((err: unknown) => err instanceof RunApprovalError && err.code === code);
}

async function rewrite(mutate: (value: Record<string, unknown>) => void): Promise<void> {
  const value = JSON.parse(await readFile(approvalPath, 'utf8')) as Record<string, unknown>;
  mutate(value);
  await writeFile(approvalPath, JSON.stringify(value), 'utf8');
}

describe('verifyRunApproval', () => {
  it('returns the approvalId and manifest when everything matches', async () => {
    const verified = await verify();
    expect(verified).toEqual({
      approvalId: record.approvalId,
      manifestHash: record.manifestHash,
      manifest: record.manifest,
      expiresAt: record.expiresAt,
      approvalPath,
    });
  });

  it('APPROVAL_MISSING: no path, or no file', async () => {
    await expectCode(verify({ approvalPath: undefined }), 'APPROVAL_MISSING');
    await expectCode(verify({ approvalPath: path.join(tempDir, 'nope.json') }), 'APPROVAL_MISSING');
  });

  it('APPROVAL_INVALID: not JSON', async () => {
    await writeFile(approvalPath, 'not json', 'utf8');
    await expectCode(verify(), 'APPROVAL_INVALID');
  });

  it('APPROVAL_INVALID: wrong schema', async () => {
    await rewrite((value) => {
      value.schemaVersion = 'yellow-goal/run-approval/v2';
    });
    await expectCode(verify(), 'APPROVAL_INVALID');
  });

  it('APPROVAL_INVALID: manifest edited without re-hashing', async () => {
    await rewrite((value) => {
      (value.manifest as { caps: { totalUsd: number } }).caps.totalUsd = 20;
    });
    await expectCode(verify(), 'APPROVAL_INVALID');
  });

  it('APPROVAL_INVALID: a manifest that widens permissions does not parse', async () => {
    await rewrite((value) => {
      (value.manifest as { permissionMode: string }).permissionMode = 'bypassPermissions';
    });
    await expectCode(verify(), 'APPROVAL_INVALID');
  });

  it('APPROVAL_INVALID: expiresAt lengthened by hand', async () => {
    await rewrite((value) => {
      value.expiresAt = '2026-09-28T14:00:00.000Z';
    });
    await expectCode(verify({ clock: () => new Date('2026-09-28T13:30:00.000Z') }), 'APPROVAL_INVALID');
  });

  it('APPROVAL_INVALID: a record dated in the future (createdAt and expiresAt shifted together)', async () => {
    await rewrite((value) => {
      value.createdAt = '2027-09-28T12:00:00.000Z';
      value.expiresAt = '2027-09-28T13:00:00.000Z';
    });
    await expectCode(verify(), 'APPROVAL_INVALID');
  });

  it('APPROVAL_ENGINE_MISMATCH: approval from another engine version', async () => {
    await expectCode(verify({ engineVersion: '0.3.0', expectedManifest: manifest({ engineVersion: '0.3.0' }) }), 'APPROVAL_ENGINE_MISMATCH');
  });

  it('APPROVAL_HASH_MISMATCH: the invocation differs from the approved manifest', async () => {
    await expectCode(verify({ expectedManifest: manifest({ totalUsd: 6 }) }), 'APPROVAL_HASH_MISMATCH');
    await expectCode(verify({ expectedManifest: manifest({ allowedTools: ['Read', 'Edit', 'Write'] }) }), 'APPROVAL_HASH_MISMATCH');
  });

  it('APPROVAL_EXPIRED: at and after expiresAt, not before', async () => {
    await expect(verify({ clock: () => new Date('2026-09-28T12:59:59.999Z') })).resolves.toBeDefined();
    await expectCode(verify({ clock: () => new Date('2026-09-28T13:00:00.000Z') }), 'APPROVAL_EXPIRED');
  });

  it('APPROVAL_CONSUMED: a consumed approval is refused by verify', async () => {
    await consume(await verify());
    await expectCode(verify(), 'APPROVAL_CONSUMED');
  });
});

describe('consumeRunApproval', () => {
  it('creates an owner-only marker keyed by approvalId once; a second consume is APPROVAL_CONSUMED', async () => {
    const verified = await verify();
    await consume(verified);
    const marker = approvalMarkerPath(record.approvalId, { stateDir });
    expect(marker).toBe(path.join(stateDir, 'consumed', record.approvalId));
    expect((await stat(marker)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(marker))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
      approvalId: record.approvalId,
      manifestHash: record.manifestHash,
      approvalPath,
      consumedAt: DURING().toISOString(),
    });
    await expectCode(consume(verified), 'APPROVAL_CONSUMED');
  });

  it('a re-cased approvalId maps to the same marker', () => {
    expect(approvalMarkerPath(record.approvalId.toUpperCase(), { stateDir })).toBe(approvalMarkerPath(record.approvalId, { stateDir }));
  });

  it('the default state dir honours only an absolute XDG_STATE_HOME', () => {
    expect(defaultApprovalStateDir({ XDG_STATE_HOME: '/srv/state' })).toBe('/srv/state/yellow-goal');
    expect(defaultApprovalStateDir({ XDG_STATE_HOME: 'relative/state' })).toBe(path.join(homedir(), '.local', 'state', 'yellow-goal'));
    expect(defaultApprovalStateDir({})).toBe(path.join(homedir(), '.local', 'state', 'yellow-goal'));
  });

  it('a copied approval file cannot be replayed', async () => {
    await consume(await verify());
    const copyPath = path.join(tempDir, 'copy.json');
    await copyFile(approvalPath, copyPath);
    await expectCode(verify({ approvalPath: copyPath }), 'APPROVAL_CONSUMED');
  });

  it('two or more concurrent starts with one approval produce exactly one winner', async () => {
    const starts = await Promise.allSettled(
      Array.from({ length: 16 }, async () => {
        const verified = await verify();
        await consume(verified);
        return verified.approvalId;
      }),
    );
    const winners = starts.filter((start) => start.status === 'fulfilled');
    const losers = starts.filter((start): start is PromiseRejectedResult => start.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(15);
    for (const loser of losers) {
      expect(loser.reason).toBeInstanceOf(RunApprovalError);
      expect((loser.reason as RunApprovalError).code).toBe('APPROVAL_CONSUMED');
    }
  });
});

describe('verifyRunApproval — review hardening', () => {
  it('an empty approval path is APPROVAL_MISSING; a directory is APPROVAL_INVALID with the errno', async () => {
    await expectCode(verify({ approvalPath: '' }), 'APPROVAL_MISSING');
    await expect(verify({ approvalPath: tempDir })).rejects.toMatchObject({ code: 'APPROVAL_INVALID', details: { errno: 'EISDIR' } });
  });

  it('tolerates createdAt up to 5 minutes ahead of the clock, not beyond', async () => {
    await expect(verify({ clock: () => new Date('2026-09-28T11:55:01.000Z') })).resolves.toBeDefined();
    await expectCode(verify({ clock: () => new Date('2026-09-28T11:54:59.000Z') }), 'APPROVAL_INVALID');
  });

  it('refusal order: hash mismatch before expiry, expiry before consumption', async () => {
    const late = () => new Date('2026-09-28T13:30:00.000Z');
    await expectCode(verify({ expectedManifest: manifest({ totalUsd: 6 }), clock: late }), 'APPROVAL_HASH_MISMATCH');
    await consume(await verify());
    await expectCode(verify({ clock: late }), 'APPROVAL_EXPIRED');
  });

  it('an unreadable consumed/ path refuses APPROVAL_STATE_UNAVAILABLE rather than guessing absent', async () => {
    await writeFile(path.join(tempDir, 'not-a-dir'), 'x', 'utf8');
    await expectCode(verify({ stateDir: path.join(tempDir, 'not-a-dir') }), 'APPROVAL_STATE_UNAVAILABLE');
  });
});

describe('consumeRunApproval — review hardening', () => {
  it('re-checks expiry at consume time and leaves no marker', async () => {
    const verified = await verify();
    await expect(consumeRunApproval(verified, { stateDir, clock: () => new Date('2026-09-28T13:00:00.000Z') })).rejects.toMatchObject({
      code: 'APPROVAL_EXPIRED',
    });
    await expect(stat(approvalMarkerPath(record.approvalId, { stateDir }))).rejects.toThrow();
  });

  it('a state dir that cannot be created is APPROVAL_STATE_UNAVAILABLE and consumes nothing', async () => {
    const blocker = path.join(tempDir, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    await expect(consumeRunApproval(await verify(), { stateDir: blocker, clock: DURING })).rejects.toMatchObject({
      code: 'APPROVAL_STATE_UNAVAILABLE',
    });
    await expect(consume(await verify())).resolves.toBeUndefined();
  });

  it('a re-cased approvalId cannot replay a consumed approval', async () => {
    const id = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const upperPath = path.join(tempDir, 'upper.json');
    const lowerPath = path.join(tempDir, 'lower.json');
    const upper = mintRunApprovalRecord(manifest(), { clock: () => MINTED_AT, newId: () => id.toUpperCase() });
    const lower = mintRunApprovalRecord(manifest(), { clock: () => MINTED_AT, newId: () => id });
    await writeFileExclusive(upperPath, JSON.stringify(upper));
    await writeFileExclusive(lowerPath, JSON.stringify(lower));
    await consume(await verify({ approvalPath: upperPath }));
    await expectCode(verify({ approvalPath: lowerPath }), 'APPROVAL_CONSUMED');
  });
});

describe('parseRunApprovalRecord', () => {
  const invalid = (mutate: (value: Record<string, unknown>) => void) => {
    const value = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    mutate(value);
    let thrown: unknown;
    try {
      parseRunApprovalRecord(JSON.stringify(value));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RunApprovalError);
    expect((thrown as RunApprovalError).code).toBe('APPROVAL_INVALID');
  };

  it('rejects a non-UUID approvalId (it becomes a marker file name)', () => invalid((v) => (v.approvalId = '../../evil')));
  it('rejects a record engineVersion that disagrees with its manifest', () => invalid((v) => (v.engineVersion = '9.9.9')));
  it('rejects unknown top-level keys', () => invalid((v) => (v.extra = true)));
  it('rejects a non-lowercase or short manifestHash', () => {
    invalid((v) => (v.manifestHash = String(v.manifestHash).toUpperCase()));
    invalid((v) => (v.manifestHash = String(v.manifestHash).slice(0, 63)));
  });
});

describe('fsyncDirectory', () => {
  it('syncs an existing directory and rejects a missing one', async () => {
    await expect(fsyncDirectory(tempDir)).resolves.toBeUndefined();
    await expect(fsyncDirectory(path.join(tempDir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('consume syncs the consumed/ directory and its parent (marker durable before spawn)', async () => {
    await consume(await verify());
    await expect(fsyncDirectory(path.join(stateDir, 'consumed'))).resolves.toBeUndefined();
  });
});

describe('newlyCreatedDirParents', () => {
  it('lists the parent of every directory mkdir -p created, leaf first', () => {
    expect(newlyCreatedDirParents('/s/a/b/consumed', '/s/a')).toEqual(['/s/a/b', '/s/a', '/s']);
    expect(newlyCreatedDirParents('/s/consumed', '/s/consumed')).toEqual(['/s']);
    expect(newlyCreatedDirParents('/s/consumed', undefined)).toEqual([]);
  });

  it('consume into a brand-new nested state dir creates and persists the whole chain', async () => {
    const nested = path.join(tempDir, 'fresh', 'yellow-goal');
    await consumeRunApproval(await verify({ stateDir: nested }), { stateDir: nested, clock: DURING });
    expect((await stat(approvalMarkerPath(record.approvalId, { stateDir: nested }))).isFile()).toBe(true);
  });
});
