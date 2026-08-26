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

  // A bad flag or stray positional makes Node's `parseArgs` throw a TypeError with an
  // ERR_PARSE_ARGS_* code. The dispatcher's catch block (index.ts) maps that to the same
  // USAGE_ERROR/exit-2 envelope as CliUsageError, rather than falling through to the generic
  // UNEXPECTED_ERROR/exit-1 case — see the review comment this guards against.
  it('an unsupported option exits 2 with a USAGE_ERROR envelope, nothing on stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['version', '--bogus']);
      expect(code).toBe(2);
      const stdoutText = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
      const stderrText = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
      expect(stdoutText).toBe('');
      const parsed = JSON.parse(stderrText.trim()) as { error: { code: string; message: string } };
      expect(parsed.error.code).toBe('USAGE_ERROR');
      expect(parsed.error.message).toMatch(/bogus/);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('a stray positional argument exits 2 with a USAGE_ERROR envelope, nothing on stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['version', 'stray']);
      expect(code).toBe(2);
      const stdoutText = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
      const stderrText = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
      expect(stdoutText).toBe('');
      const parsed = JSON.parse(stderrText.trim()) as { error: { code: string } };
      expect(parsed.error.code).toBe('USAGE_ERROR');
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  // Prove the mapping lives in the dispatcher, not a per-verb wrapper: an unrelated verb
  // (`inspect`) gets the same treatment for the same class of parseArgs failure.
  it('the parseArgs-to-USAGE_ERROR mapping is dispatcher-wide, not version-specific (inspect verb)', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['inspect', '--bogus', 'some-request.json']);
      expect(code).toBe(2);
      const stderrText = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
      const parsed = JSON.parse(stderrText.trim()) as { error: { code: string } };
      expect(parsed.error.code).toBe('USAGE_ERROR');
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
