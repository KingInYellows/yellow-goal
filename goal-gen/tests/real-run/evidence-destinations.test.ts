/**
 * AGX-R8a: evidence destinations are approved with the manifest and re-checked before the approval
 * is consumed. Every refusal happens before consumption: no marker, no worker invocation.
 */
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, openSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_RUN_WORKTREE_PREFIX, assertEvidenceDestinations } from '../../backend/src/real-run/evidence-destinations';
import { requestExecutionSample } from '../contracts/support/samples';
import {
  createFixture,
  invocations,
  manifestArgs,
  markerExists,
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

async function expectRefusedBeforeConsume(
  fixture: Fixture,
  args: string[],
  approvalId: string,
  reason: RegExp,
  code = 'EVIDENCE_DESTINATION_REFUSED',
): Promise<void> {
  const outcome = await runEngine(fixture, 'success', args);
  expect(outcome).toMatchObject({ kind: 'refused', code });
  if (outcome.kind === 'refused') expect(outcome.message).toMatch(reason);
  expect(markerExists(fixture, approvalId)).toBe(false);
  expect(invocations(fixture)).toHaveLength(0);
}

describe('evidence destinations are refused before consumption (AGX-R8a)', () => {
  it('a destination inside the request target repository', async () => {
    const repo = path.join(fx.dir, 'target-repo');
    await mkdir(repo);
    const inTarget = await createFixture({ ...requestExecutionSample, target: { repository: repo } });
    try {
      const args = manifestArgs(inTarget, { bundleDir: path.join(repo, 'bundle') });
      const approvalId = await mintApproval(inTarget, args);
      await expectRefusedBeforeConsume(inTarget, args, approvalId, /inside the request target repository/);
    } finally {
      await removeFixture(inTarget);
    }
  });

  // The recomputed manifest re-canonicalizes the destination, so a symlink swapped into its parent
  // changes the manifest and is refused as a mismatch before the destination check even runs.
  it('a parent that was swapped for a symlink after approval no longer matches the approval', async () => {
    const parent = path.join(fx.dir, 'evidence');
    await mkdir(parent);
    const args = manifestArgs(fx, { bundleDir: path.join(parent, 'bundle') });
    const approvalId = await mintApproval(fx, args);
    await rename(parent, `${parent}-real`);
    await symlink(`${parent}-real`, parent);
    await expectRefusedBeforeConsume(fx, args, approvalId, /does not match the approved manifest/, 'APPROVAL_HASH_MISMATCH');
  });

  it('an existing bundle directory', async () => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    await mkdir(fx.bundleDir);
    await expectRefusedBeforeConsume(fx, args, approvalId, /already exists/);
  });

  it('an existing spend ledger', async () => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    await writeFile(fx.ledgerPath, '', 'utf8');
    await expectRefusedBeforeConsume(fx, args, approvalId, /already exists/);
  });

  it('a destination inside a real-run scratch worktree directory', async () => {
    const engineDir = await mkdtemp(path.join(realpathSync(tmpdir()), REAL_RUN_WORKTREE_PREFIX));
    try {
      const args = manifestArgs(fx, { ledgerPath: path.join(engineDir, 'spend.jsonl') });
      const approvalId = await mintApproval(fx, args);
      await expectRefusedBeforeConsume(fx, args, approvalId, /real-run scratch worktree/);
    } finally {
      await rm(engineDir, { recursive: true, force: true });
    }
  });

  it('a group- or world-writable parent another user could pre-fill', async () => {
    const parent = path.join(fx.dir, 'shared');
    await mkdir(parent);
    await chmod(parent, 0o777);
    const args = manifestArgs(fx, { bundleDir: path.join(parent, 'bundle') });
    const approvalId = await mintApproval(fx, args);
    await expectRefusedBeforeConsume(fx, args, approvalId, /group- or world-writable/);
  });

  it('a parent removed after approval cannot be recomputed into the approved manifest', async () => {
    const parent = path.join(fx.dir, 'gone');
    await mkdir(parent);
    const args = manifestArgs(fx, { ledgerPath: path.join(parent, 'spend.jsonl') });
    const approvalId = await mintApproval(fx, args);
    await rm(parent, { recursive: true });
    await expectRefusedBeforeConsume(fx, args, approvalId, /parent directory .* cannot be resolved/, 'MANIFEST_INVALID');
  });
});

describe('assertEvidenceDestinations', () => {
  it('refuses a destination inside the scratch worktree root (the post-seed re-check)', async () => {
    const root = path.join(fx.dir, 'scratch');
    await mkdir(root);
    expect(() =>
      assertEvidenceDestinations(
        { bundleDir: path.join(fx.dir, 'b'), spendLedgerPath: path.join(root, 'spend.jsonl') },
        { worktreeRoot: root },
      ),
    ).toThrow(/inside the scratch worktree/);
  });

  it('refuses a destination whose parent resolves through a symlink', async () => {
    await mkdir(path.join(fx.dir, 'real'));
    await symlink(path.join(fx.dir, 'real'), path.join(fx.dir, 'link'));
    expect(() =>
      assertEvidenceDestinations({ bundleDir: path.join(fx.dir, 'link', 'bundle'), spendLedgerPath: fx.ledgerPath }),
    ).toThrow(/resolves through a symlink/);
  });

  it('accepts fresh destinations under a real directory', () => {
    expect(() => assertEvidenceDestinations({ bundleDir: fx.bundleDir, spendLedgerPath: fx.ledgerPath })).not.toThrow();
  });
});

describe('bundle persistence', () => {
  async function verifiedBundle(dir: string) {
    const { runCandidateOfflineVerify } = await import('../../backend/src/cli/candidate-offline-command');
    const { configRepairCandidates } = await import('../../backend/src/cli/candidate-offline-profiles');
    const candidatePath = path.join(dir, 'alpha.json');
    await writeFile(candidatePath, `${JSON.stringify(configRepairCandidates().alpha)}\n`, 'utf8');
    return { candidatePath, bundle: (await runCandidateOfflineVerify(['config-repair', candidatePath, '--json'])).output };
  }

  it('the exclusive writer refuses an existing, even empty, bundle directory', async () => {
    const { persistCandidateBundleExclusive } = await import('../../backend/src/cli/candidate-offline-bundle');
    const { bundle } = await verifiedBundle(fx.dir);
    await mkdir(fx.bundleDir);
    expect(() => persistCandidateBundleExclusive(fx.bundleDir, bundle)).toThrow(/EEXIST/);
  });

  it('the exclusive writer creates an owner-only complete bundle', async () => {
    const { bundleComplete, persistCandidateBundleExclusive } = await import('../../backend/src/cli/candidate-offline-bundle');
    const { bundle } = await verifiedBundle(fx.dir);
    persistCandidateBundleExclusive(fx.bundleDir, bundle);
    expect(bundleComplete(fx.bundleDir)).toBe(true);
    expect(statSync(fx.bundleDir).mode & 0o777).toBe(0o700);
  });

  it('the exclusive writer refuses a parent swapped for a symlink', async () => {
    const { persistCandidateBundleExclusive } = await import('../../backend/src/cli/candidate-offline-bundle');
    const { bundle } = await verifiedBundle(fx.dir);
    const parent = path.join(fx.dir, 'evidence');
    await mkdir(`${parent}-real`);
    await symlink(`${parent}-real`, parent);
    expect(() => persistCandidateBundleExclusive(path.join(parent, 'bundle'), bundle)).toThrow(/ELOOP|ENOTDIR|resolves to/);
    expect(existsSync(path.join(`${parent}-real`, 'bundle'))).toBe(false);
  });

  it('detects a held bundle directory renamed away and replaced under the approved name', async () => {
    const { assertBundleBound } = await import('../../backend/src/cli/candidate-offline-bundle');
    const { DIRECTORY_NOFOLLOW_FLAGS } = await import('../../backend/src/cli/fd-path');
    const parent = realpathSync(fx.dir);
    const target = path.join(parent, 'bound-bundle');
    await mkdir(target);
    const parentFd = openSync(parent, DIRECTORY_NOFOLLOW_FLAGS);
    const dirFd = openSync(target, DIRECTORY_NOFOLLOW_FLAGS);
    try {
      expect(() => assertBundleBound(parentFd, parent, 'bound-bundle', dirFd)).not.toThrow();
      await rename(target, path.join(parent, 'moved-bundle'));
      await mkdir(target);
      expect(() => assertBundleBound(parentFd, parent, 'bound-bundle', dirFd)).toThrow(/replaced or renamed/);
    } finally {
      closeSync(dirFd);
      closeSync(parentFd);
    }
  });

  it('verify-candidate --bundle-dir still creates missing parent directories', async () => {
    const { runCandidateOfflineVerify } = await import('../../backend/src/cli/candidate-offline-command');
    const { candidatePath } = await verifiedBundle(fx.dir);
    const nested = path.join(fx.dir, 'a', 'b', 'bundle');
    await runCandidateOfflineVerify(['config-repair', candidatePath, '--json', '--bundle-dir', nested]);
    expect(existsSync(path.join(nested, 'COMPLETE'))).toBe(true);
  });
});
