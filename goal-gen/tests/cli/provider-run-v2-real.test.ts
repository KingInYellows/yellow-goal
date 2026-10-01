/**
 * AGX-R24/R25: the v2 real-run surface — event order and payloads, refusals that emit nothing on
 * stdout, and `--yes` as a usage error. The worker is the fake `claude`, injected through the
 * `executorFactory` seam; approvals are minted through the `run approve` TTY seam.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../backend/src/cli/index';
import { parseRunInvocation } from '../../backend/src/cli/protocol-run-options';
import { runProviderV2Real, type ProviderRunV2RealOptions } from '../../backend/src/cli/provider-run-v2-real';
import { RunEventSchema } from '../../backend/src/contracts/run-event';
import { createProtocolStdoutWriter } from '../../backend/src/events/protocol-stdout-writer';
import {
  createFixture, fakeWorkerFactory, invocations, ledgerEntries, manifestArgs, markerExists, mintApproval, removeFixture,
  stubCleanCredentials, type Fixture,
} from '../real-run/support';

let fx: Fixture;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  stubCleanCredentials();
  fx = await createFixture();
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: unknown, cb?: unknown) => { if (typeof cb === 'function') (cb as () => void)(); return true; }) as typeof process.stdout.write);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await removeFixture(fx); });

const out = (): string => stdout.mock.calls.map((call: unknown[]) => String(call[0])).join('');
const err = (): string => stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('');
const events = (): Array<{ type: string; sequence: number; payload: Record<string, unknown> }> => out().split('\n').filter(Boolean).map((line: string) => JSON.parse(line));

function argv(extra: string[] = [], args: string[] = manifestArgs(fx), approval = fx.approvalPath): string[] {
  return [fx.requestPath, '--protocol', 'v2', '--executor', 'agx-claude-code', ...args, '--approval', approval, ...extra];
}
function run(scenario: string, overrides: ProviderRunV2RealOptions = {}, args?: string[], approval?: string): Promise<number> {
  return runProviderV2Real(parseRunInvocation(argv([], args, approval)) as never, {
    executorFactory: fakeWorkerFactory(fx, scenario), env: {}, stateDir: fx.stateDir, ...overrides,
  });
}
function expectValidStream(): void {
  const list = events();
  expect(list.map((event) => event.sequence)).toEqual(list.map((_event, index) => index));
  for (const event of list) expect(RunEventSchema.safeParse(event).success).toBe(true);
  expect(list.some((event) => event.type.startsWith('gate.'))).toBe(false);
}
const error = (): { error: Record<string, unknown> } => JSON.parse(err());

describe('provider v2 real run: spawned outcomes', () => {
  it('success: run.start → run.spend → run.summary verified, exit 0', async () => {
    const approvalId = await mintApproval(fx, manifestArgs(fx));
    expect(await run('success')).toBe(0);
    const list = events();
    expect(list.map((event) => event.type)).toEqual(['run.start', 'run.spend', 'run.summary']);
    expectValidStream();
    expect(list[0]!.payload).toMatchObject({
      protocolVersion: 'yellow-goal/provider-protocol/v2', executor: 'agx-claude-code', simulation: false, targetRepositoryHonored: false,
      approvalId, profile: { id: 'config-repair', version: '2' }, caps: { perActionUsd: 0.5, totalUsd: 5 },
    });
    expect(list[0]!.payload.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(list[0]!.payload).not.toHaveProperty('bundleDir');
    expect(list[1]!.payload).toMatchObject({ approvalId, exitClass: 'success' });
    expect(list[2]!.payload).toMatchObject({ outcome: 'verified', approvalId, bundleDir: fx.bundleDir });
    expect(list[2]!.payload).not.toHaveProperty('spend');
    expect(err()).toBe('');
    expect(existsSync(fx.bundleDir)).toBe(true);
  });

  it('wrong-repair: verification-rejected with a bundle path, exit 1', async () => {
    await mintApproval(fx, manifestArgs(fx));
    expect(await run('wrong-repair')).toBe(1);
    const list = events();
    expect(list.map((event) => event.type)).toEqual(['run.start', 'run.spend', 'run.summary']);
    expectValidStream();
    expect(list[2]!.payload).toMatchObject({ outcome: 'verification-rejected', bundleDir: fx.bundleDir });
    expect((list[2]!.payload.reasons as string[]).length).toBeGreaterThan(0);
    expect(error().error).toMatchObject({ code: 'RUN_VERIFICATION_REJECTED' });
  });

  it.each(['budget-stop', 'missing-cost', 'error-result'])('%s: worker-failed with spend and no bundle path, exit 1', async (scenario) => {
    await mintApproval(fx, manifestArgs(fx));
    expect(await run(scenario)).toBe(1);
    const list = events();
    expect(list.map((event) => event.type)).toEqual(['run.start', 'run.spend', 'run.summary']);
    expectValidStream();
    expect(list[2]!.payload).toMatchObject({ outcome: 'worker-failed' });
    expect(list[2]!.payload).not.toHaveProperty('bundleDir');
    expect(error().error).toMatchObject({ code: 'RUN_WORKER_FAILED' });
    expect(ledgerEntries(fx)).toHaveLength(1);
    expect(existsSync(fx.bundleDir)).toBe(false);
  });

  it('a cancel after consumption: run.start, no run.spend, worker-failed', async () => {
    await mintApproval(fx, manifestArgs(fx));
    let abort: (() => void) | undefined;
    const signals = { on: (_s: string, l: () => void) => { abort = l; }, off: () => undefined };
    const writerFactory: ProviderRunV2RealOptions['writerFactory'] = (onFailure) => {
      const inner = createProtocolStdoutWriter({ onFailure });
      return {
        write: (envelope) => { inner.write(envelope); if ((envelope as { type?: string }).type === 'run.start') abort?.(); },
        get failure() { return inner.failure; },
        finalize: (ms) => inner.finalize(ms),
      };
    };
    expect(await run('success', { signals, writerFactory })).toBe(1);
    expect(events().map((event) => event.type)).toEqual(['run.start', 'run.summary']);
    expect(events()[1]!.payload).toMatchObject({ outcome: 'worker-failed', reason: 'cancel' });
    expect(invocations(fx)).toHaveLength(0);
    expectValidStream();
  });
});

describe('provider v2 real run: refusals emit no events', () => {
  async function expectRefusal(code: string, approvalIdPresent: boolean, before = 0): Promise<void> {
    expect(out()).toBe('');
    const body = error();
    expect(body.error).toMatchObject({ code });
    expect('approvalId' in body.error).toBe(approvalIdPresent);
    expect(err().trim().split('\n')).toHaveLength(1);
    expect(invocations(fx)).toHaveLength(before);
  }

  it('APPROVAL_MISSING: no approvalId (none was read)', async () => {
    expect(await run('success', {}, undefined, fx.approvalPath)).toBe(1);
    await expectRefusal('APPROVAL_MISSING', false);
  });

  it('APPROVAL_HASH_MISMATCH: approval not consumed, no approvalId', async () => {
    const approvalId = await mintApproval(fx, manifestArgs(fx));
    expect(await run('success', {}, manifestArgs(fx, { extra: ['--max-turns', '9'] }))).toBe(1);
    // Rejected by the verifier before a valid approval is established, so no approvalId (AGX-R6).
    await expectRefusal('APPROVAL_HASH_MISMATCH', false);
    expect(markerExists(fx, approvalId)).toBe(false);
  });

  it('APPROVAL_CONSUMED: the second run with one approval never spawns', async () => {
    await mintApproval(fx, manifestArgs(fx));
    expect(await run('success')).toBe(0);
    stdout.mockClear(); stderr.mockClear();
    expect(await run('success')).toBe(1);
    await expectRefusal('APPROVAL_CONSUMED', true, 1);
  });

  it('AUTH_MODE_MISMATCH: an API key under subscription auth', async () => {
    const approvalId = await mintApproval(fx, manifestArgs(fx));
    expect(await run('success', { env: { ANTHROPIC_API_KEY: 'sk-test' } })).toBe(1);
    await expectRefusal('AUTH_MODE_MISMATCH', true);
    expect(markerExists(fx, approvalId)).toBe(false);
  });

  it('RUN_CANCELLED: a signal before consumption leaves the approval usable', async () => {
    const approvalId = await mintApproval(fx, manifestArgs(fx));
    let abort: (() => void) | undefined;
    const signals = { on: (_s: string, l: () => void) => { abort = l; }, off: () => undefined };
    const executorFactory: ProviderRunV2RealOptions['executorFactory'] = (manifest) => { abort?.(); return fakeWorkerFactory(fx, 'success')!(manifest); };
    expect(await run('success', { signals, executorFactory })).toBe(1);
    await expectRefusal('RUN_CANCELLED', true);
    expect(markerExists(fx, approvalId)).toBe(false);
  });
});

describe('provider v2 real run: --yes is a usage error (AGX-R25)', () => {
  it.each([['--yes'], ['-y']])('%s exits 2 with zero stdout and zero worker invocations', async (flag) => {
    await mintApproval(fx, manifestArgs(fx));
    expect(await main(['run', ...argv([flag])])).toBe(2);
    expect(out()).toBe('');
    expect(error().error).toMatchObject({ code: 'USAGE_ERROR' });
    expect(invocations(fx)).toHaveLength(0);
    expect(ledgerEntries(fx)).toEqual([]);
  });
});
