/**
 * RR3/RR4 (plans/specs/request-to-run-pipeline.md): the single request→run mapping path.
 * Covers the strict `orchestration.execution` refinement (RR2), verbatim goal preservation,
 * guardrail defaulting/overriding, and the fail-closed mode gate — all pure, no executor
 * construction, no spend.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RepositoryGoalRequestSchema } from '../../backend/src/contracts/request';
import { IntakeValidationFailure } from '../../backend/src/intake';
import { defaultRunConfig } from '../../backend/src/orchestrator/guardrails';
import { loadRunRequest, requestToRunInputs } from '../../backend/src/run/request-to-run';
import { requestExecutionSample, requestSample } from '../contracts/support/samples';

const executableRequest = () => RepositoryGoalRequestSchema.parse(requestExecutionSample);

describe('requestToRunInputs (RR3)', () => {
  it('maps an approved-implementation request onto run inputs', () => {
    const inputs = requestToRunInputs(executableRequest());
    expect(inputs.goalText).toBe(requestExecutionSample.intent.goal);
    expect(inputs.autoConfirm).toBe(true);
    expect(inputs.runConfig).toEqual(
      defaultRunConfig({
        maxBudgetUsd: 5,
        maxReplans: 2,
        maxReextractions: 1,
        maxRetriesPerAction: 2,
        actionTimeoutMs: 120_000,
        model: 'haiku',
      }),
    );
  });

  it('preserves the goal text verbatim — no trimming or rewriting', () => {
    const goal = '  Fix the   thing --yes really. ';
    const request = RepositoryGoalRequestSchema.parse({
      ...requestExecutionSample,
      intent: { goal },
    });
    expect(requestToRunInputs(request).goalText).toBe(goal);
  });

  it('defaults everything when the execution block is absent', () => {
    const request = RepositoryGoalRequestSchema.parse({
      ...requestSample,
      mode: 'approved-implementation',
    });
    const inputs = requestToRunInputs(request);
    expect(inputs.runConfig).toEqual(defaultRunConfig());
    expect(inputs.autoConfirm).toBe(false);
  });

  it.each(['review-and-compile', 'review-only'] as const)(
    'refuses mode %s before any run wiring (RR4)',
    (mode) => {
      const request = RepositoryGoalRequestSchema.parse({ ...requestSample, mode });
      let thrown: unknown;
      try {
        requestToRunInputs(request);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(IntakeValidationFailure);
      expect((thrown as IntakeValidationFailure).errors).toEqual([
        expect.objectContaining({ code: 'RUN_MODE_NOT_EXECUTABLE', field: 'mode' }),
      ]);
    },
  );
});

describe('execution refinement strictness (RR2)', () => {
  it('rejects unknown keys inside execution', () => {
    const candidate = {
      ...requestExecutionSample,
      orchestration: {
        execution: { autoConfirmDod: true, autoAcceptSignoff: true },
      },
    };
    expect(RepositoryGoalRequestSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects unknown keys inside execution.guardrails', () => {
    const candidate = {
      ...requestExecutionSample,
      orchestration: {
        execution: { guardrails: { maxBudgetUsd: 5, maxBuget: 500 } },
      },
    };
    expect(RepositoryGoalRequestSchema.safeParse(candidate).success).toBe(false);
  });

  it('still lets unknown keys pass through the surrounding orchestration bucket', () => {
    const candidate = {
      ...requestExecutionSample,
      orchestration: { someFutureField: 'ok', execution: { autoConfirmDod: false } },
    };
    expect(RepositoryGoalRequestSchema.safeParse(candidate).success).toBe(true);
  });
});

describe('loadRunRequest', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function write(name: string, content: string): Promise<string> {
    dir ??= await mkdtemp(path.join(tmpdir(), 'run-request-'));
    const filePath = path.join(dir, name);
    await writeFile(filePath, content);
    return filePath;
  }

  it('loads and parses a valid canonical request file', async () => {
    const filePath = await write('request.json', JSON.stringify(requestExecutionSample));
    const request = await loadRunRequest(filePath);
    expect(request.requestId).toBe(requestExecutionSample.requestId);
    expect(request.mode).toBe('approved-implementation');
  });

  it('throws IntakeValidationFailure on malformed JSON', async () => {
    const filePath = await write('bad.json', '{not json');
    await expect(loadRunRequest(filePath)).rejects.toMatchObject({
      name: 'IntakeValidationFailure',
      errors: [expect.objectContaining({ code: 'REQUEST_FILE_INVALID_JSON' })],
    });
  });

  it('throws IntakeValidationFailure on a schema-invalid request', async () => {
    const filePath = await write('invalid.json', JSON.stringify({ ...requestSample, mode: 'yolo' }));
    await expect(loadRunRequest(filePath)).rejects.toBeInstanceOf(IntakeValidationFailure);
  });
});
