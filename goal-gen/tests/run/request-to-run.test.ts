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

  it('rejects a whitespace-only goal before extractor or executor construction', () => {
    const request = RepositoryGoalRequestSchema.parse({
      ...requestExecutionSample,
      intent: { ...requestExecutionSample.intent, goal: '   ' },
    });

    expect(() => requestToRunInputs(request)).toThrowError(
      expect.objectContaining({
        name: 'IntakeValidationFailure',
        errors: [expect.objectContaining({ code: 'RUN_GOAL_EMPTY', field: 'intent.goal' })],
      }),
    );
  });

  it('defaults everything when the execution block is absent', () => {
    const request = RepositoryGoalRequestSchema.parse({
      ...requestSample,
      mode: 'approved-implementation',
      constraints: { readOnlyTarget: false, allowTargetEdits: true },
      orchestration: { ...requestSample.orchestration, permissionProfile: 'implement' },
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

  it.each([
    ['readOnlyTarget: true', { readOnlyTarget: true }],
    ['allowTargetEdits: false', { allowTargetEdits: false }],
  ] as const)('refuses a request whose constraints declare %s', (_label, constraints) => {
    const request = RepositoryGoalRequestSchema.parse({
      ...requestExecutionSample,
      constraints,
    });
    let thrown: unknown;
    try {
      requestToRunInputs(request);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IntakeValidationFailure);
    expect((thrown as IntakeValidationFailure).errors).toEqual([
      expect.objectContaining({ code: 'RUN_CONSTRAINTS_FORBID_EXECUTION', field: 'constraints' }),
    ]);
  });

  it('still executes when constraints are present but permissive', () => {
    const request = RepositoryGoalRequestSchema.parse({
      ...requestExecutionSample,
      constraints: { readOnlyTarget: false, allowTargetEdits: true },
    });
    expect(requestToRunInputs(request).goalText).toBe(request.intent.goal);
  });

  it('refuses an otherwise-executable request whose constraints are absent (RR21 default-deny)', () => {
    const { constraints: _omit, ...withoutConstraints } = requestExecutionSample;
    const request = RepositoryGoalRequestSchema.parse(withoutConstraints);
    let thrown: unknown;
    try {
      requestToRunInputs(request);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IntakeValidationFailure);
    expect((thrown as IntakeValidationFailure).errors).toEqual([
      expect.objectContaining({ code: 'RUN_CONSTRAINTS_NOT_DECLARED_WRITABLE', field: 'constraints' }),
    ]);
  });

  it('refuses constraints that omit allowTargetEdits, even with readOnlyTarget: false (RR21 default-deny)', () => {
    const request = RepositoryGoalRequestSchema.parse({
      ...requestExecutionSample,
      constraints: { readOnlyTarget: false },
    });
    let thrown: unknown;
    try {
      requestToRunInputs(request);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IntakeValidationFailure);
    expect((thrown as IntakeValidationFailure).errors).toEqual([
      expect.objectContaining({ code: 'RUN_CONSTRAINTS_NOT_DECLARED_WRITABLE', field: 'constraints' }),
    ]);
  });

  it.each(['inspect', 'compile'])(
    "refuses an otherwise-executable request using permission profile '%s' (RR21 fail-closed profile)",
    (permissionProfile) => {
      const request = RepositoryGoalRequestSchema.parse({
        ...requestExecutionSample,
        orchestration: { ...requestExecutionSample.orchestration, permissionProfile },
      });
      let thrown: unknown;
      try {
        requestToRunInputs(request);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(IntakeValidationFailure);
      expect((thrown as IntakeValidationFailure).errors).toEqual([
        expect.objectContaining({
          code: 'RUN_PERMISSION_PROFILE_FORBIDS_EXECUTION',
          field: 'orchestration.permissionProfile',
        }),
      ]);
    },
  );

  it('refuses an otherwise-executable request with no permissionProfile declared (RR21 fail-closed profile)', () => {
    const { permissionProfile: _omit, ...orchestrationWithoutProfile } = requestExecutionSample.orchestration;
    const request = RepositoryGoalRequestSchema.parse({
      ...requestExecutionSample,
      orchestration: orchestrationWithoutProfile,
    });
    let thrown: unknown;
    try {
      requestToRunInputs(request);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IntakeValidationFailure);
    expect((thrown as IntakeValidationFailure).errors).toEqual([
      expect.objectContaining({
        code: 'RUN_PERMISSION_PROFILE_FORBIDS_EXECUTION',
        field: 'orchestration.permissionProfile',
      }),
    ]);
  });

  it("still executes with permission profile 'autonomous-isolated' (truthy but scoped targetWrite)", () => {
    const request = RepositoryGoalRequestSchema.parse({
      ...requestExecutionSample,
      orchestration: { ...requestExecutionSample.orchestration, permissionProfile: 'autonomous-isolated' },
    });
    expect(requestToRunInputs(request).goalText).toBe(request.intent.goal);
  });
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

describe('execution refinement value bounds', () => {
  it('rejects a non-finite maxBudgetUsd (JSON 1e400 parses to Infinity and would disable the budget guardrail)', () => {
    const candidate = {
      ...requestExecutionSample,
      orchestration: {
        execution: { guardrails: { maxBudgetUsd: Number.POSITIVE_INFINITY } },
      },
    };
    expect(RepositoryGoalRequestSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects actionTimeoutMs above the ADR-0010 run wall-clock cap', () => {
    const candidate = {
      ...requestExecutionSample,
      orchestration: {
        execution: { guardrails: { actionTimeoutMs: 3_600_001 } },
      },
    };
    expect(RepositoryGoalRequestSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects actionTimeoutMs above the Node setTimeout maximum (values past 2^31-1 clamp to 1ms)', () => {
    const candidate = {
      ...requestExecutionSample,
      orchestration: {
        execution: { guardrails: { actionTimeoutMs: 2_147_483_648 } },
      },
    };
    expect(RepositoryGoalRequestSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    ['a flag-like value', '--dangerously-looking-flag'],
    ['a value with whitespace', 'model name'],
  ])('rejects %s for execution.model (value reaches the claude argv)', (_label, model) => {
    const candidate = {
      ...requestExecutionSample,
      orchestration: { execution: { model } },
    };
    expect(RepositoryGoalRequestSchema.safeParse(candidate).success).toBe(false);
  });

  it('accepts a normal model id', () => {
    const candidate = {
      ...requestExecutionSample,
      orchestration: { execution: { model: 'claude-haiku-4-5-20251001' } },
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

describe('guardrail ceilings (RR18)', () => {
  const withGuardrails = (guardrails: Record<string, number>) =>
    RepositoryGoalRequestSchema.parse({
      ...requestExecutionSample,
      // Spread the sample's own orchestration: replacing it wholesale would drop
      // permissionProfile, which RR21 now requires for any executable request.
      orchestration: { ...requestExecutionSample.orchestration, execution: { guardrails } },
    });

  it('rejects raising any cap above the ADR-0010 defaults without operator consent', () => {
    const defaults = defaultRunConfig();
    const raised = withGuardrails({ maxBudgetUsd: defaults.maxBudgetUsd + 1, maxReplans: defaults.maxReplans + 1 });
    let thrown: unknown;
    try {
      requestToRunInputs(raised);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IntakeValidationFailure);
    const errors = (thrown as IntakeValidationFailure).errors;
    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error.code).toBe('RUN_GUARDRAILS_EXCEED_DEFAULTS');
    }
    expect(errors.map((e) => e.field)).toEqual([
      'orchestration.execution.guardrails.maxBudgetUsd',
      'orchestration.execution.guardrails.maxReplans',
    ]);
  });

  it('honors raised caps when the operator passes allowGuardrailOverride', () => {
    const defaults = defaultRunConfig();
    const raised = withGuardrails({ maxBudgetUsd: defaults.maxBudgetUsd + 5 });
    const inputs = requestToRunInputs(raised, { allowGuardrailOverride: true });
    expect(inputs.runConfig.maxBudgetUsd).toBe(defaults.maxBudgetUsd + 5);
  });

  it('always allows lowering or matching the default caps', () => {
    const defaults = defaultRunConfig();
    const inputs = requestToRunInputs(
      withGuardrails({ maxBudgetUsd: defaults.maxBudgetUsd, actionTimeoutMs: 1000 }),
    );
    expect(inputs.runConfig.maxBudgetUsd).toBe(defaults.maxBudgetUsd);
    expect(inputs.runConfig.actionTimeoutMs).toBe(1000);
  });
});

describe('execution refinement counter bounds', () => {
  it.each(['maxReplans', 'maxReextractions', 'maxRetriesPerAction'] as const)(
    // .int() alone accepts values like 1e100 (Number.isInteger is true for such floats), which
    // would leave a retry/replan/re-extraction loop effectively non-terminating.
    'rejects %s above the operational ceiling (1e100 is an "integer" .int() alone would accept)',
    (field) => {
      const candidate = {
        ...requestExecutionSample,
        orchestration: {
          execution: { guardrails: { [field]: 1e100 } },
        },
      };
      expect(RepositoryGoalRequestSchema.safeParse(candidate).success).toBe(false);
    },
  );

  it('accepts counters at the ceiling', () => {
    const candidate = {
      ...requestExecutionSample,
      orchestration: {
        execution: {
          guardrails: { maxReplans: 100, maxReextractions: 100, maxRetriesPerAction: 100 },
        },
      },
    };
    expect(RepositoryGoalRequestSchema.safeParse(candidate).success).toBe(true);
  });
});
