/** AGX-R23: a v2 stub run equals the v1 stub run apart from the protocol id. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../backend/src/cli/index';
import { requestExecutionSample } from '../contracts/support/samples';

const V1 = 'yellow-goal/provider-protocol/v1';
const V2 = 'yellow-goal/provider-protocol/v2';

let dir: string;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'provider-v2-stub-'));
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: unknown, cb?: unknown) => { if (typeof cb === 'function') (cb as () => void)(); return true; }) as typeof process.stdout.write);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

async function requestFile(autoConfirmDod: boolean): Promise<string> {
  const file = path.join(dir, 'request.json');
  const execution = { ...requestExecutionSample.orchestration.execution, autoConfirmDod };
  await writeFile(file, JSON.stringify({ ...requestExecutionSample, orchestration: { ...requestExecutionSample.orchestration, execution } }));
  return file;
}

function normalize(value: unknown, key?: string): unknown {
  if (key === 'runId') return '<RUN_ID>';
  if (key === 'timestamp') return '<TIMESTAMP>';
  if (key !== undefined && /duration/i.test(key) && typeof value === 'number') return '<DURATION>';
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v, k)]));
  return value;
}

async function run(protocol: 'v1' | 'v2', argv: string[], autoConfirmDod: boolean): Promise<{ code: number; events: unknown[]; stderr: string }> {
  stdout.mockClear(); stderr.mockClear();
  const file = await requestFile(autoConfirmDod);
  const code = await main(['run', file, '--executor', 'stub', '--protocol', protocol, ...argv]);
  const text = stdout.mock.calls.map((call: unknown[]) => String(call[0])).join('').replaceAll(protocol === 'v2' ? V2 : V1, '<PROTOCOL>');
  const events = text.split('\n').filter(Boolean).map((line: string) => normalize(JSON.parse(line)));
  return { code, events, stderr: stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('') };
}

describe('provider v2 stub parity (AGX-R23)', () => {
  it.each([
    ['success', [], true], ['success', ['--yes'], false], ['success', [], false],
    ['failed', [], true], ['failed', ['--yes'], false],
    ['budget-exhausted', [], true], ['budget-exhausted', ['--yes'], false],
    ['await-cancel', ['--timeout-ms', '50'], true], ['await-cancel', ['--yes', '--timeout-ms', '50'], false],
  ] as const)('%s %j (autoConfirmDod=%s)', async (scenario, extra, autoConfirmDod) => {
    const argv = ['--stub-scenario', scenario, ...extra];
    const v1 = await run('v1', argv, autoConfirmDod);
    const v2 = await run('v2', argv, autoConfirmDod);
    expect(v2.events.length).toBeGreaterThan(0);
    expect(v2).toEqual(v1);
  });

  it('puts the v2 id, and only that, in run.start', async () => {
    const file = await requestFile(true);
    expect(await main(['run', file, '--executor', 'stub', '--protocol', 'v2'])).toBe(0);
    const first = JSON.parse(String(stdout.mock.calls[0]![0]).split('\n')[0]!) as { type: string; payload: { protocolVersion: string; executor: string; simulation: boolean } };
    expect(first).toMatchObject({ type: 'run.start', payload: { protocolVersion: V2, executor: 'stub', simulation: true } });
  });
});
