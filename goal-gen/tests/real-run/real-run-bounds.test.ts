/**
 * AGX-R14: the engine bounds its one worker attempt by the manifest's action timeout, the run
 * wall-clock and caller cancellation, and each kills the worker's whole process group — including
 * a descendant that ignores SIGTERM. The approval stays consumed on every path.
 */
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFixture,
  invocations,
  ledgerEntries,
  manifestArgs,
  markerExists,
  mintApproval,
  removeFixture,
  runEngine,
  scratchRoot,
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Aborts once the fake worker has recorded its invocation and its descendant, never before. */
async function abortWhenWorkerReady(controller: AbortController): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (invocations(fx)[0]?.descendantPid !== undefined) {
      controller.abort();
      return;
    }
    await sleep(50);
  }
  controller.abort();
}

function expectGroupKilledAndConsumed(approvalId: string): void {
  const calls = invocations(fx);
  expect(calls).toHaveLength(1);
  const descendant = calls[0]!.descendantPid;
  if (descendant !== undefined) expect(processAlive(descendant)).toBe(false);
  expect(existsSync(scratchRoot(calls[0]!))).toBe(false);
  expect(markerExists(fx, approvalId)).toBe(true);
  expect(ledgerEntries(fx)).toHaveLength(1);
}

describe('real-run execution bounds (AGX-R14)', () => {
  it('action timeout kills the whole process group, including a SIGTERM-ignoring grandchild', async () => {
    // The action timeout starts at spawn, so the worker has ample time to record its descendant.
    const args = manifestArgs(fx, { extra: ['--action-timeout-ms', '3000'] });
    const approvalId = await mintApproval(fx, args);
    const outcome = await runEngine(fx, 'descendant-ignores-sigterm', args);
    expect(outcome).toMatchObject({ kind: 'worker-failed', reason: 'timeout', approvalId });
    expect(invocations(fx)[0]!.descendantPid).toEqual(expect.any(Number));
    expectGroupKilledAndConsumed(approvalId);
    expect(ledgerEntries(fx)[0]).toMatchObject({ exitClass: 'timeout', costUsd: null, turns: null });
  });

  it('caller cancellation kills the whole process group', async () => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    const controller = new AbortController();
    const [outcome] = await Promise.all([
      runEngine(fx, 'descendant-ignores-sigterm', args, { signal: controller.signal }),
      abortWhenWorkerReady(controller),
    ]);
    expect(outcome).toMatchObject({ kind: 'worker-failed', reason: 'cancel', approvalId });
    expectGroupKilledAndConsumed(approvalId);
    expect(ledgerEntries(fx)[0]).toMatchObject({ exitClass: 'cancel' });
  });

  it('run wall-clock expiry ends the attempt as wall-clock, not cancel', async () => {
    // The wall-clock starts at consumption (before seeding), so leave the worker time to start.
    const args = manifestArgs(fx, { extra: ['--run-wall-clock-ms', '4000', '--action-timeout-ms', '20000'] });
    const approvalId = await mintApproval(fx, args);
    const outcome = await runEngine(fx, 'hang', args);
    expect(outcome).toMatchObject({ kind: 'worker-failed', reason: 'wall-clock', approvalId });
    expectGroupKilledAndConsumed(approvalId);
    expect(ledgerEntries(fx)[0]).toMatchObject({ exitClass: 'wall-clock' });
  });

  it('a cancel before consumption refuses RUN_CANCELLED and leaves the approval usable', async () => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    const controller = new AbortController();
    controller.abort();
    const outcome = await runEngine(fx, 'success', args, { signal: controller.signal });
    expect(outcome).toMatchObject({ kind: 'refused', code: 'RUN_CANCELLED', approvalId });
    expect(invocations(fx)).toHaveLength(0);
    expect(ledgerEntries(fx)).toHaveLength(0);
    expect(markerExists(fx, approvalId)).toBe(false);
    expect((await runEngine(fx, 'success', args)).kind).toBe('verified');
  });
});
