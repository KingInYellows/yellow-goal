/**
 * `run` verb contract (RR11–RR16, plans/specs/request-to-run-pipeline.md), tested in-process
 * through `main()` with stdout/stderr spies like the rest of tests/cli/. Every test uses
 * `--executor stub` (RR16) — nothing here can spawn a real `claude` or spend money; the
 * claude-code engine path stays covered by tests/integration/runner.probe.ts (operator-run).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunEventSchema } from '../../backend/src/contracts/run-event';
import { main } from '../../backend/src/cli/index';
import { CliUsageError } from '../../backend/src/cli/errors';
import { defaultEngineFactory, runRunCommand, type EngineFactory } from '../../backend/src/cli/run-command';
import { IntakeValidationFailure } from '../../backend/src/intake';
import { defaultRunConfig } from '../../backend/src/orchestrator/guardrails';
import { requestExecutionSample, requestSample } from '../contracts/support/samples';

let tempDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'goal-gen-run-verb-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  await rm(tempDir, { recursive: true, force: true });
});

function stdoutLines(): string[] {
  const text: string = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
  return text.split('\n').filter((line) => line !== '');
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

async function writeRequest(candidate: unknown): Promise<string> {
  const filePath = path.join(tempDir, 'request.json');
  await writeFile(filePath, JSON.stringify(candidate));
  return filePath;
}

describe('run verb (stub engine)', () => {
  it('streams valid run-event/v1 JSON Lines ending in run.summary and exits 0 (RR11/RR12)', async () => {
    const requestPath = await writeRequest(requestExecutionSample);
    const code = await main(['run', requestPath, '--executor', 'stub']);
    expect(stderrText()).toBe('');
    expect(code).toBe(0);

    const lines = stdoutLines();
    expect(lines.length).toBeGreaterThan(1);
    const envelopes = lines.map((line) => {
      const parsed = RunEventSchema.safeParse(JSON.parse(line));
      expect(parsed.success, line).toBe(true);
      return parsed.success ? parsed.data : undefined!;
    });
    expect(envelopes.map((e) => e.sequence)).toEqual(envelopes.map((_, i) => i));
    expect(new Set(envelopes.map((e) => e.runId)).size).toBe(1);
    const last = envelopes[envelopes.length - 1]!;
    expect(last.type).toBe('run.summary');
    expect(last.payload).toMatchObject({ status: 'succeeded' });
    // requestExecutionSample sets autoConfirmDod, so the DoD gate auto-confirms without --yes.
    expect(envelopes.some((e) => e.type === 'gate.autoConfirm')).toBe(true);
  });

  it('honors --yes when the request does not auto-confirm (RR14)', async () => {
    const requestPath = await writeRequest({
      ...requestExecutionSample,
      // Spread the sample's orchestration: replacing it wholesale would drop permissionProfile (RR21).
      orchestration: { ...requestExecutionSample.orchestration, execution: { autoConfirmDod: false } },
    });
    const code = await main(['run', requestPath, '--executor', 'stub', '--yes']);
    expect(code).toBe(0);
    expect(stdoutLines().some((line) => (JSON.parse(line) as { type: string }).type === 'gate.autoConfirm')).toBe(true);
  });

  it('refuses to run without --executor: exit 2, USAGE_ERROR, nothing spawned (RR13)', async () => {
    const requestPath = await writeRequest(requestExecutionSample);
    const code = await main(['run', requestPath]);
    expect(code).toBe(2);
    expect(stdoutLines()).toEqual([]);
    const parsed = JSON.parse(stderrText().trim()) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('USAGE_ERROR');
    expect(parsed.error.message).toContain('--executor');
  });

  it('rejects an unknown --executor value with exit 2 (RR13)', async () => {
    const requestPath = await writeRequest(requestExecutionSample);
    const code = await main(['run', requestPath, '--executor', 'codex']);
    expect(code).toBe(2);
    expect((JSON.parse(stderrText().trim()) as { error: { code: string } }).error.code).toBe('USAGE_ERROR');
  });

  it('refuses a review-mode request with VALIDATION_FAILED and exit 1 (RR4)', async () => {
    const requestPath = await writeRequest(requestSample); // mode: review-and-compile
    const code = await main(['run', requestPath, '--executor', 'stub']);
    expect(code).toBe(1);
    expect(stdoutLines()).toEqual([]);
    const parsed = JSON.parse(stderrText().trim()) as { error: { code: string; details?: unknown } };
    expect(parsed.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(parsed.error.details)).toContain('RUN_MODE_NOT_EXECUTABLE');
  });

  it('requires the request-file positional (exit 2)', async () => {
    const code = await main(['run', '--executor', 'stub']);
    expect(code).toBe(2);
    expect((JSON.parse(stderrText().trim()) as { error: { code: string } }).error.code).toBe('USAGE_ERROR');
  });

  it('rejects extra positionals with USAGE_ERROR, exit 2 — before the request file is read', async () => {
    const requestPath = await writeRequest(requestExecutionSample);
    const code = await main(['run', requestPath, 'accidental.json', '--executor', 'stub']);
    expect(code).toBe(2);
    expect(stdoutLines()).toEqual([]);
    const parsed = JSON.parse(stderrText().trim()) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('USAGE_ERROR');
    expect(parsed.error.message).toContain('exactly one');
  });

  it('translates a malformed option (missing --executor value) into USAGE_ERROR, exit 2', async () => {
    const requestPath = await writeRequest(requestExecutionSample);
    const code = await main(['run', requestPath, '--executor']);
    expect(code).toBe(2);
    expect(stdoutLines()).toEqual([]);
    expect((JSON.parse(stderrText().trim()) as { error: { code: string } }).error.code).toBe('USAGE_ERROR');
  });

  it('translates an unknown flag into USAGE_ERROR, exit 2', async () => {
    const requestPath = await writeRequest(requestExecutionSample);
    const code = await main(['run', requestPath, '--executor', 'stub', '--bogus']);
    expect(code).toBe(2);
    expect((JSON.parse(stderrText().trim()) as { error: { code: string } }).error.code).toBe('USAGE_ERROR');
  });
});

describe('runFailureEnvelope (RR11 stderr envelope, pure mapping)', () => {
  // The stub engine always succeeds (RR16), so a terminal non-success run.summary isn't
  // reachable end-to-end through the CLI without a test-only production seam — unit-tested
  // directly instead (see run-command.ts).
  it('maps each non-succeeded status to a distinct machine-readable code', async () => {
    const { runFailureEnvelope } = await import('../../backend/src/cli/run-command');
    expect(runFailureEnvelope({ status: 'succeeded', reason: 'ok' })).toBeUndefined();
    expect(runFailureEnvelope({ status: 'failed', reason: 'retries exhausted' })).toEqual({
      error: { code: 'RUN_FAILED', message: 'retries exhausted' },
    });
    expect(runFailureEnvelope({ status: 'cancelled', reason: 'aborted' })).toEqual({
      error: { code: 'RUN_CANCELLED', message: 'aborted' },
    });
    expect(runFailureEnvelope({ status: 'budget-exhausted', reason: 'budget cap $5 exceeded' })).toEqual({
      error: { code: 'RUN_BUDGET_EXHAUSTED', message: 'budget cap $5 exceeded' },
    });
  });
});

describe('operator consent policies (RR18/RR19)', () => {
  it('opens the stream with a run.start audit envelope: effective config + target disclosure', async () => {
    const requestPath = await writeRequest(requestExecutionSample);
    const code = await main(['run', requestPath, '--executor', 'stub']);
    expect(code).toBe(0);
    const first = JSON.parse(stdoutLines()[0]!) as { type: string; payload: Record<string, unknown> };
    expect(first.type).toBe('run.start');
    expect(first.payload).toMatchObject({
      executor: 'stub',
      autoConfirm: true,
      allowGuardrailOverride: false,
      targetRepository: requestExecutionSample.target.repository,
      targetRepositoryHonored: false,
    });
    expect(first.payload.runConfig).toMatchObject({ maxBudgetUsd: 5 });
  });

  it('refuses request-raised guardrails without --allow-guardrail-override (RR18)', async () => {
    const requestPath = await writeRequest({
      ...requestExecutionSample,
      orchestration: { ...requestExecutionSample.orchestration, execution: { guardrails: { maxBudgetUsd: 500 } } },
    });
    const code = await main(['run', requestPath, '--executor', 'stub']);
    expect(code).toBe(1);
    expect(stdoutLines()).toEqual([]); // rejected before the stream opens — nothing spent
    const parsed = JSON.parse(stderrText().trim()) as { error: { code: string; details?: unknown } };
    expect(parsed.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(parsed.error.details)).toContain('RUN_GUARDRAILS_EXCEED_DEFAULTS');
  });

  it('honors raised guardrails with --allow-guardrail-override, visible in run.start (RR18)', async () => {
    const requestPath = await writeRequest({
      ...requestExecutionSample,
      orchestration: {
        ...requestExecutionSample.orchestration,
        execution: { autoConfirmDod: true, guardrails: { maxBudgetUsd: 500 } },
      },
    });
    const code = await main(['run', requestPath, '--executor', 'stub', '--allow-guardrail-override']);
    expect(code).toBe(0);
    const first = JSON.parse(stdoutLines()[0]!) as { payload: { allowGuardrailOverride: boolean; runConfig: { maxBudgetUsd: number } } };
    expect(first.payload.allowGuardrailOverride).toBe(true);
    expect(first.payload.runConfig.maxBudgetUsd).toBe(500);
  });

  it('effectiveAutoConfirm: request-file consent counts only for the stub engine (RR19)', async () => {
    const { effectiveAutoConfirm } = await import('../../backend/src/cli/run-command');
    // stub: CLI --yes OR request autoConfirmDod
    expect(effectiveAutoConfirm('stub', false, true)).toBe(true);
    expect(effectiveAutoConfirm('stub', true, false)).toBe(true);
    expect(effectiveAutoConfirm('stub', false, false)).toBe(false);
    // claude-code (real spend): ONLY the operator's CLI --yes
    expect(effectiveAutoConfirm('claude-code', false, true)).toBe(false);
    expect(effectiveAutoConfirm('claude-code', true, false)).toBe(true);
    expect(effectiveAutoConfirm('claude-code', true, true)).toBe(true);
  });
});

/** The fail-closed ordering the spec promises ("before any extractor/executor/worktree work") is
 *  proven through the exported construction seam, not inferred from an empty stdout: an invalid
 *  request must never reach `defaultEngineFactory` (or any override), and a valid one reaches it
 *  exactly once, after validation. */
describe('engine construction seam (fail-closed ordering)', () => {
  it('constructs exactly one engine, after validation, for a valid request (positive control)', async () => {
    const factory = vi.fn<EngineFactory>(defaultEngineFactory);
    const requestPath = await writeRequest(requestExecutionSample);
    const code = await runRunCommand([requestPath, '--executor', 'stub'], { engineFactory: factory });
    expect(code).toBe(0);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(
      'stub',
      expect.objectContaining({ goalText: requestExecutionSample.intent.goal }),
      expect.any(Function),
    );
    // The audit envelope (run.start) is the first event and precedes construction.
    expect((JSON.parse(stdoutLines()[0]!) as { type: string }).type).toBe('run.start');
  });

  it('never constructs an engine for a request whose mode is not executable (RR4)', async () => {
    const factory = vi.fn<EngineFactory>(defaultEngineFactory);
    const requestPath = await writeRequest(requestSample); // mode: review-and-compile
    await expect(runRunCommand([requestPath, '--executor', 'stub'], { engineFactory: factory })).rejects.toBeInstanceOf(
      IntakeValidationFailure,
    );
    expect(factory).not.toHaveBeenCalled();
    expect(stdoutLines()).toEqual([]);
  });

  it('never constructs an engine when raised guardrails lack operator consent (RR18)', async () => {
    const factory = vi.fn<EngineFactory>(defaultEngineFactory);
    const requestPath = await writeRequest({
      ...requestExecutionSample,
      orchestration: {
        ...requestExecutionSample.orchestration,
        execution: { guardrails: { maxBudgetUsd: defaultRunConfig().maxBudgetUsd + 1 } },
      },
    });
    await expect(runRunCommand([requestPath, '--executor', 'stub'], { engineFactory: factory })).rejects.toBeInstanceOf(
      IntakeValidationFailure,
    );
    expect(factory).not.toHaveBeenCalled();
    expect(stdoutLines()).toEqual([]);
  });

  it('never constructs an engine on a usage error — even with --executor claude-code (RR13)', async () => {
    const factory = vi.fn<EngineFactory>(defaultEngineFactory);
    const requestPath = await writeRequest(requestExecutionSample);
    await expect(runRunCommand([requestPath, 'extra.json', '--executor', 'claude-code'], { engineFactory: factory })).rejects.toBeInstanceOf(
      CliUsageError,
    );
    await expect(runRunCommand([requestPath], { engineFactory: factory })).rejects.toBeInstanceOf(CliUsageError);
    expect(factory).not.toHaveBeenCalled();
    expect(stdoutLines()).toEqual([]);
  });
});
