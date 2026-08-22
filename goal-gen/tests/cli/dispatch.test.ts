import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../backend/src/cli/index';

let tempDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'goal-gen-cli-dispatch-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  await rm(tempDir, { recursive: true, force: true });
});

function stdoutText(): string {
  return stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

describe('CLI dispatcher', () => {
  it('request create --json exits 0 and prints a single JSON line to stdout, nothing to stderr', async () => {
    const code = await main([
      'request',
      'create',
      '--repo',
      'octocat/example',
      '--goal',
      'Ship the thing.',
      '--json',
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutText().trim()) as { request: { target: { repository: string } } };
    expect(parsed.request.target.repository).toBe('octocat/example');
    expect(stderrText()).toBe('');
  });

  it('request create without --json still prints valid (pretty) JSON to stdout', async () => {
    const code = await main(['request', 'create', '--repo', 'octocat/example', '--goal', 'Ship the thing.']);
    expect(code).toBe(0);
    expect(() => JSON.parse(stdoutText())).not.toThrow();
  });

  it('unknown command exits 2 with a structured USAGE_ERROR on stderr, nothing on stdout', async () => {
    const code = await main(['bogus']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stderrText().trim()) as { error: { code: string } };
    expect(parsed.error.code).toBe('USAGE_ERROR');
    expect(stdoutText()).toBe('');
  });

  it('unknown request subcommand exits 2 with USAGE_ERROR', async () => {
    const code = await main(['request', 'bogus']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stderrText().trim()) as { error: { code: string } };
    expect(parsed.error.code).toBe('USAGE_ERROR');
  });

  it('unknown packet subcommand exits 2 with USAGE_ERROR', async () => {
    const code = await main(['packet', 'bogus']);
    expect(code).toBe(2);
  });

  it('request create with an unknown permission profile exits 1 with structured VALIDATION_FAILED details', async () => {
    const code = await main([
      'request',
      'create',
      '--repo',
      'octocat/example',
      '--goal',
      'Ship the thing.',
      '--permission-profile',
      'not-real',
    ]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stderrText().trim()) as { error: { code: string; details: unknown[] } };
    expect(parsed.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(parsed.error.details)).toBe(true);
    expect(parsed.error.details.length).toBeGreaterThan(0);
  });

  it('inspect reaches the real (wired) inspection module and fails structurally on a missing request file', async () => {
    // Before integration this asserted NOT_WIRED; the module now exists, so the same invocation
    // must reach real code and fail on the nonexistent request path — never NOT_WIRED again.
    const code = await main(['inspect', 'request.json', '--output', tempDir]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stderrText().trim()) as { error: { code: string } };
    expect(parsed.error.code).not.toBe('NOT_WIRED');
  });

  it('request validate on an invalid file exits 1 while still printing a normal JSON result to stdout', async () => {
    const filePath = path.join(tempDir, 'bad.json');
    await writeFile(filePath, JSON.stringify({}));
    const code = await main(['request', 'validate', filePath]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutText().trim()) as { valid: boolean };
    expect(parsed.valid).toBe(false);
  });

  it('request validate on a valid file exits 0', async () => {
    const filePath = path.join(tempDir, 'good.json');
    await main(['request', 'create', '--repo', 'octocat/example', '--goal', 'Ship the thing.', '--output', filePath]);
    stdoutSpy.mockClear();
    const code = await main(['request', 'validate', filePath]);
    expect(code).toBe(0);
  });

  it('packet verify with no path exits 2 with USAGE_ERROR', async () => {
    const code = await main(['packet', 'verify']);
    expect(code).toBe(2);
  });
});
