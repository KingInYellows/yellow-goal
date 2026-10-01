/**
 * AGX-R22: Protocol v1 stays byte-identical after v2 lands. The goldens in
 * tests/golden/provider-v1/ were captured from `main` BEFORE any v2 change; this test regenerates the
 * same artifacts through `main()` and byte-compares them. Regenerate deliberately with
 * `GOLDEN_UPDATE=1 npx vitest run tests/cli/provider-v1-golden.test.ts` — a diff in review is a
 * protocol change, never a refresh.
 *
 * Normalized (non-deterministic by nature): runId, timestamp, and any `*duration*` key. The engine
 * version is replaced with a placeholder so a package version bump does not churn the goldens.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../backend/src/cli/index';
import { readArtifactVersion } from '../../backend/src/cli/artifact-version';
import { requestExecutionSample } from '../contracts/support/samples';

const GOLDEN_DIR = path.join(import.meta.dirname, '..', 'golden', 'provider-v1');
const UPDATE = process.env.GOLDEN_UPDATE === '1';

let dir: string;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'provider-v1-golden-'));
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: unknown, cb?: unknown) => { if (typeof cb === 'function') (cb as () => void)(); return true; }) as typeof process.stdout.write);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

const out = (): string => stdout.mock.calls.map((call: unknown[]) => String(call[0])).join('');
const err = (): string => stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('');

async function requestFile(autoConfirmDod: boolean): Promise<string> {
  const file = path.join(dir, 'request.json');
  const execution = { ...requestExecutionSample.orchestration.execution, autoConfirmDod };
  await writeFile(file, JSON.stringify({ ...requestExecutionSample, orchestration: { ...requestExecutionSample.orchestration, execution } }));
  return file;
}

function normalizeValue(value: unknown, key?: string): unknown {
  if (key === 'runId') return '<RUN_ID>';
  if (key === 'timestamp') return '<TIMESTAMP>';
  if (key !== undefined && /duration/i.test(key) && typeof value === 'number') return '<DURATION>';
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeValue(v, k)]));
  }
  return value;
}

/** Normalizes every JSONL line, preserving key order and the exact one-event-per-line shape. */
const normalizeStream = (text: string): string =>
  text.split('\n').filter(Boolean).map((line) => JSON.stringify(normalizeValue(JSON.parse(line)))).join('\n') + '\n';

async function expectGolden(name: string, actual: string): Promise<void> {
  const file = path.join(GOLDEN_DIR, name);
  if (UPDATE) {
    await mkdir(GOLDEN_DIR, { recursive: true });
    await writeFile(file, actual);
  }
  expect(actual).toBe(await readFile(file, 'utf8'));
}

describe('provider v1 byte goldens (AGX-R22)', () => {
  it('capabilities --json stdout bytes', async () => {
    expect(await main(['capabilities', '--json'])).toBe(0);
    expect(err()).toBe('');
    await expectGolden('capabilities.json', out().replaceAll(`"engineVersion":"${await readArtifactVersion()}"`, '"engineVersion":"<ENGINE_VERSION>"'));
  });

  it.each([
    ['success', ['--yes']],
    ['failed', ['--yes']],
    ['budget-exhausted', ['--yes']],
    ['await-cancel', ['--yes', '--timeout-ms', '50']],
  ] as const)('stub stream and stderr for %s', async (scenario, extra) => {
    const file = await requestFile(true);
    await main(['run', file, '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', scenario, ...extra]);
    await expectGolden(`stub-${scenario}.stdout.jsonl`, normalizeStream(out()));
    await expectGolden(`stub-${scenario}.stderr.json`, err());
  });

  it('RUN_GATE_REQUIRED stub stream and stderr', async () => {
    const file = await requestFile(false);
    expect(await main(['run', file, '--executor', 'stub', '--protocol', 'v1'])).toBe(1);
    await expectGolden('gate-required.stdout.jsonl', normalizeStream(out()));
    await expectGolden('gate-required.stderr.json', err());
  });

  it.each([
    ['v1-claude-code', ['--executor', 'claude-code', '--protocol', 'v1']],
    ['unknown-protocol', ['--executor', 'stub', '--protocol', 'v9']],
  ] as const)('usage error envelope: %s', async (name, args) => {
    const file = await requestFile(true);
    expect(await main(['run', file, ...args])).toBe(2);
    expect(out()).toBe('');
    await expectGolden(`usage-${name}.stderr.json`, err());
  });
});
