import { afterEach, describe, expect, it, vi } from 'vitest';

const forbiddenModules = [
  '../../backend/src/cli/run-command',
  '../../backend/src/cli/provider-run-v1',
  '../../backend/src/executors/claude-code-executor',
  '../../backend/src/extractors/llm-extractor',
  'node:child_process',
];

afterEach(() => {
  for (const modulePath of forbiddenModules) vi.doUnmock(modulePath);
  vi.resetModules();
});

describe('capabilities cold-import isolation', () => {
  it('loads static discovery without run, provider, executor, or child-process modules', async () => {
    vi.resetModules();
    for (const modulePath of forbiddenModules) {
      vi.doMock(modulePath, () => { throw new Error(`unexpected discovery import: ${modulePath}`); });
    }
    const { runCapabilities } = await import('../../backend/src/cli/provider-capabilities');
    await expect(runCapabilities([])).resolves.toMatchObject({ json: true, output: { protocolVersion: 'yellow-goal/provider-protocol/v1' } });
  });
});
