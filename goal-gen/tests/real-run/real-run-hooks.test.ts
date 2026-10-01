/**
 * Observer hooks on the real-run engine (shell 04 step 3.1): `onStarted` fires once, right after
 * consumption; `onSpend` fires once per ledger entry. Hooks never change an outcome unless they
 * throw, and a throw never skips cleanup.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealRunInput, RealRunStarted } from '../../backend/src/real-run/real-run-engine';
import type { RealRunOutcome, RealRunSpend } from '../../backend/src/real-run/outcome';
import {
  createFixture, invocations, ledgerEntries, manifestArgs, markerExists, mintApproval, removeFixture, runEngine,
  scratchRoot, stubCleanCredentials, type Fixture,
} from './support';

let fx: Fixture;
beforeEach(async () => { stubCleanCredentials(); fx = await createFixture(); });
afterEach(async () => { vi.unstubAllEnvs(); await removeFixture(fx); });

type Calls = { started: RealRunStarted[]; spend: RealRunSpend[]; order: string[] };
function observers(): { calls: Calls; hooks: Pick<RealRunInput, 'onStarted' | 'onSpend'> } {
  const calls: Calls = { started: [], spend: [], order: [] };
  return {
    calls,
    hooks: {
      onStarted: (info) => { calls.started.push(info); calls.order.push('started'); },
      onSpend: (spend) => { calls.spend.push(spend); calls.order.push('spend'); },
    },
  };
}

describe('real-run engine observer hooks', () => {
  it.each(['APPROVAL_MISSING', 'APPROVAL_HASH_MISMATCH', 'APPROVAL_CONSUMED', 'RUN_CANCELLED'] as const)('refused (%s): neither hook fires', async (code) => {
    const args = manifestArgs(fx);
    const { calls, hooks } = observers();
    let overrides: Partial<RealRunInput> = { ...hooks };
    if (code === 'APPROVAL_MISSING') overrides = { ...overrides, approvalPath: undefined };
    else {
      await mintApproval(fx, args);
      if (code === 'APPROVAL_HASH_MISMATCH') {
        const outcome = await runEngine(fx, 'success', manifestArgs(fx, { extra: ['--max-turns', '9'] }), overrides);
        expect(outcome).toMatchObject({ kind: 'refused', code });
        expect(calls).toMatchObject({ started: [], spend: [] });
        return;
      }
      if (code === 'APPROVAL_CONSUMED') await runEngine(fx, 'success', args);
      if (code === 'RUN_CANCELLED') overrides = { ...overrides, signal: AbortSignal.abort() };
    }
    const before = invocations(fx).length;
    const outcome = await runEngine(fx, 'success', args, overrides);
    expect(outcome).toMatchObject({ kind: 'refused', code });
    expect(calls.started).toEqual([]);
    expect(calls.spend).toEqual([]);
    expect(invocations(fx)).toHaveLength(before);
  });

  it('hands onStarted the approved identity after consumption', async () => {
    const args = manifestArgs(fx);
    const approvalId = await mintApproval(fx, args);
    const { calls, hooks } = observers();
    let consumedAtStart: boolean | undefined;
    const outcome = await runEngine(fx, 'success', args, { ...hooks, onStarted: (info) => { consumedAtStart = markerExists(fx, info.approvalId); hooks.onStarted!(info); } });
    expect(outcome.kind).toBe('verified');
    expect(consumedAtStart).toBe(true);
    expect(calls.started).toHaveLength(1);
    expect(calls.started[0]).toMatchObject({ approvalId, manifest: { evidence: { bundleDir: fx.bundleDir } } });
    expect(calls.started[0]!.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof calls.started[0]!.targetRepository).toBe('string');
  });

  it('pre-spawn cancel after consumption: onStarted only', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const controller = new AbortController();
    const { calls, hooks } = observers();
    const outcome = await runEngine(fx, 'success', args, { ...hooks, signal: controller.signal, onStarted: (info) => { hooks.onStarted!(info); controller.abort(); } });
    expect(outcome).toMatchObject({ kind: 'worker-failed', reason: 'cancel', evidence: { spawned: false } });
    expect(calls.order).toEqual(['started']);
    expect(invocations(fx)).toHaveLength(0);
  });

  it.each(['mode-rejected', 'worktree-refused', 'auth-mode-mismatch'] as const)('NOT_SPAWNED class %s: onStarted only', async (failureClass) => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const { calls, hooks } = observers();
    const executorFactory: RealRunInput['executorFactory'] = () => ({
      kind: 'claude-code',
      run: async () => ({ id: 'x', actionId: 'x', status: 'failed', failureClass, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }) as never,
    });
    const outcome = await runEngine(fx, 'success', args, { ...hooks, executorFactory });
    expect(outcome).toMatchObject({ kind: 'worker-failed' });
    expect(calls.order).toEqual(['started']);
    expect(ledgerEntries(fx)).toEqual([]);
  });

  it.each(['success', 'wrong-repair', 'error-result', 'budget-stop', 'max-turns', 'missing-cost', 'malformed-output'])('spawned %s: exactly one onSpend, before the outcome resolves', async (scenario) => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const { calls, hooks } = observers();
    let resolved = false;
    const pending = runEngine(fx, scenario, args, hooks).then((outcome) => { resolved = true; return outcome; });
    const outcome: RealRunOutcome = await pending;
    expect(resolved).toBe(true);
    expect(calls.order).toEqual(['started', 'spend']);
    expect(calls.spend[0]).toEqual('spend' in outcome && outcome.spend !== undefined ? outcome.spend : undefined);
    expect(ledgerEntries(fx)).toHaveLength(1);
  });

  it('an executor that throws still reports its unknown spend', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const { calls, hooks } = observers();
    const outcome = await runEngine(fx, 'success', args, { ...hooks, executorFactory: () => ({ kind: 'claude-code', run: async () => { throw new Error('boom'); } }) });
    expect(outcome).toMatchObject({ kind: 'worker-failed', reason: 'engine-error' });
    expect(calls.spend).toEqual([{ costUsd: null, turns: null, durationMs: 0, exitClass: 'engine-error' }]);
  });

  it('a throwing onStarted surfaces as engine-error and spawns nothing', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const outcome = await runEngine(fx, 'success', args, { onStarted: () => { throw new Error('start hook down'); } });
    expect(outcome).toMatchObject({ kind: 'worker-failed', reason: 'engine-error', evidence: { stage: 'onStarted', message: 'start hook down' } });
    expect(invocations(fx)).toHaveLength(0);
  });

  it('a throwing onSpend keeps the ledger entry, removes the worktree and reports engine-error', async () => {
    const args = manifestArgs(fx);
    await mintApproval(fx, args);
    const outcome = await runEngine(fx, 'success', args, { onSpend: () => { throw new Error('spend hook down'); } });
    expect(outcome).toMatchObject({ kind: 'worker-failed', reason: 'engine-error', evidence: { stage: 'onSpend', message: 'spend hook down' }, spend: { exitClass: 'success' } });
    expect(ledgerEntries(fx)).toHaveLength(1);
    expect(existsSync(scratchRoot(invocations(fx)[0]!))).toBe(false);
    expect(existsSync(fx.bundleDir)).toBe(false);
  });
});
