/**
 * RR5: the M1 runner's argv contract, tested via the exported pure parser — importing runner.ts
 * never constructs executors (auto-run is guarded by the entry-script check), and no test here
 * calls `run()`, so nothing can spawn a real `claude`.
 */
import { describe, expect, it } from 'vitest';
import { parseRunnerArgs } from '../../backend/src/runner';

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
      allowGuardrailOverride: false,
    });
  });

  it('combines --yes with --request in either order', () => {
    expect(parseRunnerArgs(['--yes', '--request', 'req.json'])).toEqual({
      kind: 'request',
      requestPath: 'req.json',
      autoConfirm: true,
      allowGuardrailOverride: false,
    });
    expect(parseRunnerArgs(['--request', 'req.json', '-y'])).toEqual({
      kind: 'request',
      requestPath: 'req.json',
      autoConfirm: true,
      allowGuardrailOverride: false,
    });
  });

  it('rejects --request without a value', () => {
    expect(parseRunnerArgs(['--request'])).toMatchObject({ kind: 'usage' });
    expect(parseRunnerArgs(['--request', ''])).toMatchObject({ kind: 'usage' });
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

describe('--allow-guardrail-override (RR18)', () => {
  it('parses with --request in either order', () => {
    expect(parseRunnerArgs(['--allow-guardrail-override', '--request', 'req.json'])).toEqual({
      kind: 'request',
      requestPath: 'req.json',
      autoConfirm: false,
      allowGuardrailOverride: true,
    });
    expect(parseRunnerArgs(['--request', 'req.json', '--allow-guardrail-override', '-y'])).toEqual({
      kind: 'request',
      requestPath: 'req.json',
      autoConfirm: true,
      allowGuardrailOverride: true,
    });
  });

  it('defaults to false', () => {
    expect(parseRunnerArgs(['--request', 'req.json'])).toMatchObject({ allowGuardrailOverride: false });
  });

  it('is a usage error without --request (nothing to consent to)', () => {
    expect(parseRunnerArgs(['--allow-guardrail-override', 'do a thing'])).toMatchObject({ kind: 'usage' });
  });
});
