/**
 * RR5: the M1 runner's argv contract, tested via the exported pure parser — importing runner.ts
 * never constructs executors (auto-run is guarded by the entry-script check). The validation test
 * calls `run()` only with a non-executable request, which fails before executor construction.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRunnerArgs, run } from '../../backend/src/runner';
import { requestSample } from '../contracts/support/samples';

describe('parseRunnerArgs (RR5)', () => {
  it('parses the bare-goal form, joining arguments verbatim', () => {
    expect(parseRunnerArgs(['fix', 'the', 'build'])).toEqual({
      kind: 'goal',
      goalText: 'fix the build',
      autoConfirm: false,
    });
  });

  it('consumes only leading --yes flags; a goal containing them is preserved', () => {
    expect(parseRunnerArgs(['--yes', 'run tests with --yes flag'])).toEqual({
      kind: 'goal',
      goalText: 'run tests with --yes flag',
      autoConfirm: true,
    });
  });

  it('parses --request with a file path', () => {
    expect(parseRunnerArgs(['--request', 'req.json'])).toEqual({
      kind: 'request',
      requestPath: 'req.json',
      autoConfirm: false,
    });
  });

  it('combines --yes with --request in either order', () => {
    expect(parseRunnerArgs(['--yes', '--request', 'req.json'])).toEqual({
      kind: 'request',
      requestPath: 'req.json',
      autoConfirm: true,
    });
    expect(parseRunnerArgs(['--request', 'req.json', '-y'])).toEqual({
      kind: 'request',
      requestPath: 'req.json',
      autoConfirm: true,
    });
  });

  it('rejects --request without a value', () => {
    expect(parseRunnerArgs(['--request'])).toMatchObject({ kind: 'usage' });
    expect(parseRunnerArgs(['--request', ''])).toMatchObject({ kind: 'usage' });
  });

  it('rejects duplicate --request flags instead of selecting the last file', () => {
    expect(parseRunnerArgs(['--request', 'reviewed.json', '--request', 'other.json'])).toEqual({
      kind: 'usage',
      message: '--request may only be specified once',
    });
  });

  it('rejects --request combined with a bare goal (two goal sources)', () => {
    expect(parseRunnerArgs(['--request', 'req.json', 'also do this'])).toMatchObject({
      kind: 'usage',
      message: expect.stringContaining('mutually exclusive'),
    });
  });

  it('rejects an empty invocation with usage text', () => {
    expect(parseRunnerArgs([])).toMatchObject({
      kind: 'usage',
      message: expect.stringContaining('usage:'),
    });
  });
});

describe('runner request validation (RR4)', () => {
  let dir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('emits VALIDATION_FAILED with field-level details before executor construction', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'runner-validation-'));
    const requestPath = path.join(dir, 'request.json');
    await writeFile(requestPath, JSON.stringify(requestSample));
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    const summary = await run(['--request', requestPath]);

    expect(summary.status).toBe('failed');
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      ev: 'error',
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ code: 'RUN_MODE_NOT_EXECUTABLE', field: 'mode' })],
    });
  });
});
