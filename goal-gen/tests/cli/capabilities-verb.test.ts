import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../backend/src/cli/index';
import { RepositoryGoalRequestSchemaVersion } from '../../backend/src/contracts/request';
import { RunEventSchemaVersion } from '../../backend/src/contracts/run-event';
import { PROTOCOL_STDOUT_FINALIZE_MS, PROTOCOL_STDOUT_MAX_EVENT_BYTES, PROTOCOL_STDOUT_MAX_QUEUED_BYTES } from '../../backend/src/events/protocol-stdout-writer';
import { ProviderCapabilitiesSchemaVersion, ProviderProtocolVersion, ProviderStubScenarios } from '../../backend/src/cli/provider-capabilities';

let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { stdout.mockRestore(); stderr.mockRestore(); });
const out = (): string => stdout.mock.calls.map((call: unknown[]) => String(call[0])).join('');
const err = (): string => stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('');
async function artifactVersion(): Promise<string> {
  const metadata = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof metadata.version !== 'string') throw new Error('test package metadata has no version');
  return metadata.version;
}

describe('capabilities verb (PP-01)', () => {
  async function expectCapabilities(argv: string[]): Promise<void> {
    expect(await main(['capabilities', ...argv])).toBe(0);
    expect(err()).toBe('');
    const result = JSON.parse(out()) as Record<string, unknown>;
    expect(result).toMatchObject({
      schemaVersion: ProviderCapabilitiesSchemaVersion,
      protocolVersion: ProviderProtocolVersion,
      engineVersion: await artifactVersion(),
      requestSchemaVersion: RepositoryGoalRequestSchemaVersion,
      runEventSchemaVersion: RunEventSchemaVersion,
    });
    expect(result.operations).toEqual(['capabilities', 'request.create', 'request.validate', 'run', 'version']);
    expect(new Set(result.operations as string[]).size).toBe((result.operations as string[]).length);
    expect(result.capabilities).toEqual(['run.cancel.os-signal', 'run.executor.stub', 'run.gate.noninteractive', 'run.stdout.jsonl', 'run.timeout']);
    expect(new Set(result.capabilities as string[]).size).toBe((result.capabilities as string[]).length);
    expect(result.stubScenarios).toEqual(ProviderStubScenarios);
    expect(new Set(result.stubScenarios as string[]).size).toBe((result.stubScenarios as string[]).length);
    expect(result.limits).toEqual({ maxEventBytes: PROTOCOL_STDOUT_MAX_EVENT_BYTES, maxQueuedBytes: PROTOCOL_STDOUT_MAX_QUEUED_BYTES, writerFinalizationTimeoutMs: PROTOCOL_STDOUT_FINALIZE_MS });
    expect(out().endsWith('\n')).toBe(true);
  }
  it('emits the static protocol object by default', async () => { await expectCapabilities([]); });
  it('emits the static protocol object with --json', async () => { await expectCapabilities(['--json']); });

  it('agrees with the installed-artifact version verb', async () => {
    expect(await main(['capabilities', '--json'])).toBe(0);
    const capabilities = JSON.parse(out()) as { engineVersion: string };
    stdout.mockClear(); stderr.mockClear();
    expect(await main(['version', '--json'])).toBe(0);
    expect(err()).toBe('');
    expect(JSON.parse(out())).toEqual({ engineVersion: capabilities.engineVersion });
    expect(capabilities.engineVersion).toBe(await artifactVersion());
  });

  it('rejects unexpected positionals before producing stdout', async () => {
    expect(await main(['capabilities', 'extra'])).toBe(2);
    expect(out()).toBe('');
    expect(JSON.parse(err())).toMatchObject({ error: { code: 'USAGE_ERROR' } });
  });
});
