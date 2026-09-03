/**
 * RR5: the M1 runner's argv contract, tested via the exported pure parser — importing runner.ts
 * never constructs executors (auto-run is guarded by the entry-script check). The validation test
 * calls `run()` only with a non-executable request, which fails before executor construction.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunEventSchema, type RunEvent } from '../../backend/src/contracts/run-event';
import { RunEventEmitter } from '../../backend/src/events/run-event-emitter';
import { defaultRunConfig } from '../../backend/src/orchestrator/guardrails';
import { parseRunnerArgs, run, runStartEvent } from '../../backend/src/runner';
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
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('emits VALIDATION_FAILED with field-level details before executor construction', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'runner-validation-'));
    const requestPath = path.join(dir, 'request.json');
    await writeFile(requestPath, JSON.stringify(requestSample));
    const output: RunEvent[] = [];
    const emitter = new RunEventEmitter({ runId: 'runner-validation', sink: (event) => output.push(event) });

    const summary = await run(['--request', requestPath], emitter);

    expect(summary.status).toBe('failed');
    expect(output).toHaveLength(2);
    expect(output.every((event) => RunEventSchema.safeParse(event).success)).toBe(true);
    expect(output.map((event) => event.sequence)).toEqual([0, 1]);
    expect(output[0]).toMatchObject({
      type: 'error',
      payload: {
        code: 'VALIDATION_FAILED',
        errors: [expect.objectContaining({ code: 'RUN_MODE_NOT_EXECUTABLE', field: 'mode' })],
      },
    });
    expect(output[1]).toMatchObject({ type: 'run.summary', payload: { status: 'failed' } });
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

describe('runStartEvent — the runner\'s audit envelope matches the run verb', () => {
  it('discloses the request target as not honored and carries the consent flag', () => {
    const event = runStartEvent({
      goalText: 'g',
      autoConfirm: false,
      runConfig: defaultRunConfig(),
      allowGuardrailOverride: true,
      targetRepository: 'owner/repo',
    });
    expect(event).toMatchObject({
      ev: 'run.start',
      executor: 'claude-code',
      allowGuardrailOverride: true,
      targetRepository: 'owner/repo',
      targetRepositoryHonored: false,
    });
  });

  it('omits target fields for a bare-goal run (nothing was requested)', () => {
    const event = runStartEvent({ goalText: 'g', autoConfirm: true, runConfig: defaultRunConfig(), allowGuardrailOverride: false });
    expect(event).not.toHaveProperty('targetRepository');
    expect(event).not.toHaveProperty('targetRepositoryHonored');
    expect(event.allowGuardrailOverride).toBe(false);
  });
});
