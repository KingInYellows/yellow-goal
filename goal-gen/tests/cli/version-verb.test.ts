/**
 * `version` verb (RR17): identity probe only. Emits the package artifact version — NOT
 * `packets/compiler.ts`'s ENGINE_VERSION (pack-format compatibility) and NOT a protocol
 * version. Asserting inequality with a semantic marker is impossible while all three are
 * literally "0.1.0", so instead these tests pin the SOURCE: the value must come from
 * package.json, byte-for-byte.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../../backend/src/cli/index';
import { runVersion } from '../../backend/src/cli/commands';

async function packageVersion(): Promise<string> {
  const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

describe('version verb (RR17)', () => {
  it('reports the package artifact version', async () => {
    const result = await runVersion(['--json']);
    expect(result.output).toEqual({ engineVersion: await packageVersion() });
    expect(result.json).toBe(true);
  });

  it('exits 0 through the dispatcher with a single JSON object on stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['version', '--json']);
      expect(code).toBe(0);
      const text = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
      expect(JSON.parse(text.trim())).toEqual({ engineVersion: await packageVersion() });
      expect(stderrSpy.mock.calls).toHaveLength(0);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
