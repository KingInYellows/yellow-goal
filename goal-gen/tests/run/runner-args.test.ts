/**
 * RR5: the M1 runner's argv contract, tested via the exported pure parser — importing runner.ts
 * never constructs executors (auto-run is guarded by the entry-script check). The validation test
 * calls `run()` only with a non-executable request, which fails before executor construction.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalTerminal } from '../../backend/src/cli/terminal-challenge';
import { RunEventSchema, type RunEvent } from '../../backend/src/contracts/run-event';
import { RunEventEmitter } from '../../backend/src/events/run-event-emitter';
import { defaultRunConfig } from '../../backend/src/orchestrator/guardrails';
import { confirmRealSpend, parseRunnerArgs, run, runStartEvent } from '../../backend/src/runner';
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

/** A fake terminal that answers once the prompt appears, or ends input when `answer` is null. */
function fakeTerminal(
  answer: string | null | ((shown: string) => string),
  tty: { stdin: boolean; output: boolean } = { stdin: true, output: true },
) {
  const stdin = Object.assign(new PassThrough(), { isTTY: tty.stdin });
  const output = Object.assign(new PassThrough(), { isTTY: tty.output });
  let text = '';
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
    if (text.includes('Type the challenge') && !stdin.writableEnded) {
      const shown = /^challenge:\s+(\S+)$/m.exec(text)?.[1] ?? '';
      if (answer === null) stdin.end();
      else stdin.end(`${typeof answer === 'function' ? answer(shown) : answer}\n`);
    }
  });
  const terminal: ApprovalTerminal = { stdin, output };
  return { terminal, text: () => text };
}

const spendFields = { goalText: 'fix the build', runConfig: defaultRunConfig(), autoConfirm: true };

describe('confirmRealSpend (RR22)', () => {
  it('confirms only when the operator types the challenge it showed', async () => {
    const { terminal, text } = fakeTerminal((shown) => shown);
    await expect(confirmRealSpend(spendFields, terminal)).resolves.toEqual({ confirmed: true });
    expect(text()).toContain('real spend');
    expect(text()).toContain('goal:         "fix the build"');
    expect(text()).toContain('DoD gate:     auto-confirmed (--yes)');
  });

  it('shows every spend/time cap and flags a request target as not honored', async () => {
    const { terminal, text } = fakeTerminal(null);
    await confirmRealSpend({ ...spendFields, targetRepository: 'owner/repo' }, terminal);
    const config = defaultRunConfig();
    expect(text()).toContain(`$${config.maxBudgetUsd}`);
    expect(text()).toContain(`${config.maxReplans} replans · ${config.maxReextractions} re-extractions · ${config.maxRetriesPerAction} retries/action`);
    expect(text()).toContain('target:       "owner/repo" (not honored');
  });

  it('declines at once when stdin has already ended', async () => {
    const { terminal } = fakeTerminal('unused');
    const stdin = terminal.stdin as PassThrough;
    stdin.end();
    stdin.resume();
    await new Promise((resolve) => stdin.once('end', resolve));
    await expect(confirmRealSpend(spendFields, terminal)).resolves.toMatchObject({ confirmed: false, code: 'RUNNER_DECLINED' });
  });

  it('shows a fresh challenge each time', async () => {
    const first = fakeTerminal(null);
    const second = fakeTerminal(null);
    await confirmRealSpend(spendFields, first.terminal);
    await confirmRealSpend(spendFields, second.terminal);
    const challenge = (t: string) => /^challenge:\s+(\S+)$/m.exec(t)?.[1];
    expect(challenge(first.text())).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(challenge(first.text())).not.toBe(challenge(second.text()));
  });

  it.each([
    ['a wrong answer', '0000-0000'],
    ['--yes typed at the prompt', 'yes'],
    ['end of input', null],
  ])('declines on %s', async (_label, answer) => {
    const { terminal } = fakeTerminal(answer);
    await expect(confirmRealSpend(spendFields, terminal)).resolves.toMatchObject({ confirmed: false, code: 'RUNNER_DECLINED' });
  });

  it.each([
    ['stdin', { stdin: false, output: true }],
    ['terminal output', { stdin: true, output: false }],
  ])('refuses without writing when %s is not a TTY', async (_label, tty) => {
    const { terminal } = fakeTerminal((shown) => shown, tty);
    const writes = vi.spyOn(terminal.output, 'write');
    await expect(confirmRealSpend(spendFields, terminal)).resolves.toMatchObject({ confirmed: false, code: 'RUNNER_TTY_REQUIRED' });
    expect(writes).not.toHaveBeenCalled();
  });

  it('refuses under the test process itself (no controlling terminal is bound)', async () => {
    // vitest workers have no TTY stdin, which is exactly an agent session's shape.
    await expect(confirmRealSpend(spendFields)).resolves.toMatchObject({ confirmed: false, code: 'RUNNER_TTY_REQUIRED' });
  });
});

describe('runner spend gate (RR22)', () => {
  it.each([
    ['--yes with no terminal', ['--yes', 'fix the build'], fakeTerminal((shown) => shown, { stdin: false, output: false }).terminal, 'RUNNER_TTY_REQUIRED'],
    ['a declined challenge', ['--yes', 'fix the build'], fakeTerminal('0000-0000').terminal, 'RUNNER_DECLINED'],
  ])('stops before run.start and executor construction on %s', async (_label, args, terminal, code) => {
    const output: RunEvent[] = [];
    const emitter = new RunEventEmitter({ runId: 'runner-gate', sink: (event) => output.push(event) });

    const summary = await run(args, emitter, terminal);

    expect(summary).toMatchObject({ status: 'failed', goalText: 'fix the build', costUsd: 0 });
    expect(output.map((event) => event.type)).toEqual(['error', 'run.summary']);
    expect(output[0]).toMatchObject({ payload: { code } });
  });

  it('still ends with run.summary when the confirmation itself throws', async () => {
    const { terminal } = fakeTerminal('unused');
    terminal.output.write = () => {
      throw new Error('terminal gone');
    };
    const output: RunEvent[] = [];
    const emitter = new RunEventEmitter({ runId: 'runner-gate-throw', sink: (event) => output.push(event) });

    const summary = await run(['fix the build'], emitter, terminal);

    expect(summary).toMatchObject({ status: 'failed', costUsd: 0 });
    expect(output.map((event) => event.type)).toEqual(['error', 'run.summary']);
    expect(output[0]).toMatchObject({ payload: { code: 'RUNNER_DECLINED', message: expect.stringContaining('terminal gone') } });
  });
});
