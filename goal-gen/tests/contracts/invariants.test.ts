import { describe, expect, it } from 'vitest';
import {
  CommandRecordSchema,
  FinalHandoffSchema,
  FindingSchema,
  OrchestrationSpecSchema,
  RunEventSchema,
} from '../../backend/src/contracts';
import {
  commandRecordSample,
  finalHandoffSample,
  findingSample,
  orchestrationSpecSample,
  runEventSample,
} from './support/samples';

describe('CommandRecord: model-suggested commands are never executable', () => {
  it('accepts a model-suggested command with executable: false', () => {
    const result = CommandRecordSchema.safeParse({
      ...commandRecordSample,
      source: 'model-suggested',
      executable: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a model-suggested command with executable: true', () => {
    const result = CommandRecordSchema.safeParse({
      ...commandRecordSample,
      source: 'model-suggested',
      executable: true,
    });
    expect(result.success).toBe(false);
  });

  it('allows executable: true for non-model-suggested sources', () => {
    const result = CommandRecordSchema.safeParse({
      ...commandRecordSample,
      source: 'manifest-script',
      executable: true,
    });
    expect(result.success).toBe(true);
  });
});

describe('FinalHandoff: READY_AFTER_ONE_NAMED_ACTION requires remainingAction', () => {
  it('rejects READY_AFTER_ONE_NAMED_ACTION with no remainingAction', () => {
    const result = FinalHandoffSchema.safeParse({
      ...finalHandoffSample,
      status: 'READY_AFTER_ONE_NAMED_ACTION',
    });
    expect(result.success).toBe(false);
  });

  it('accepts READY_AFTER_ONE_NAMED_ACTION with a non-empty remainingAction', () => {
    const result = FinalHandoffSchema.safeParse({
      ...finalHandoffSample,
      status: 'READY_AFTER_ONE_NAMED_ACTION',
      remainingAction: 'Human approval required for the packaged migration script.',
    });
    expect(result.success).toBe(true);
  });

  it('does not require remainingAction for PR_READY_FOR_HUMAN_REVIEW or DO_NOT_MERGE', () => {
    expect(FinalHandoffSchema.safeParse(finalHandoffSample).success).toBe(true);
    expect(
      FinalHandoffSchema.safeParse({ ...finalHandoffSample, status: 'DO_NOT_MERGE' }).success,
    ).toBe(true);
  });
});

describe('OrchestrationSpec: lead.responsibilities must state sole-integrator/final-decision semantics', () => {
  it('accepts the canonical sample (responsibilities already say "sole integrator")', () => {
    expect(OrchestrationSpecSchema.safeParse(orchestrationSpecSample).success).toBe(true);
  });

  it('rejects responsibilities that omit sole-integrator/final-decision semantics', () => {
    const result = OrchestrationSpecSchema.safeParse({
      ...orchestrationSpecSample,
      lead: { ...orchestrationSpecSample.lead, responsibilities: ['writes the final report'] },
    });
    expect(result.success).toBe(false);
  });

  it('accepts responsibilities phrased around "final decision" instead of "sole integrator"', () => {
    const result = OrchestrationSpecSchema.safeParse({
      ...orchestrationSpecSample,
      lead: {
        ...orchestrationSpecSample.lead,
        responsibilities: ['the final decision-maker for this run'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown teamMode or fallbackMode', () => {
    expect(
      OrchestrationSpecSchema.safeParse({ ...orchestrationSpecSample, teamMode: 'solo' }).success,
    ).toBe(false);
    expect(
      OrchestrationSpecSchema.safeParse({ ...orchestrationSpecSample, fallbackMode: 'none' }).success,
    ).toBe(false);
  });

  it('rejects an empty mutationBoundaries list', () => {
    expect(
      OrchestrationSpecSchema.safeParse({ ...orchestrationSpecSample, mutationBoundaries: [] }).success,
    ).toBe(false);
  });
});

describe('Finding: all eight mission classifications are representable', () => {
  const classifications = [
    'verified_defect',
    'strongly_supported_risk',
    'documentation_contradiction',
    'missing_evidence',
    'intentional_limitation',
    'obsolete_finding',
    'duplicate_finding',
    'unknown',
  ];

  it.each(classifications)('accepts classification "%s"', (classification) => {
    const result = FindingSchema.safeParse({ ...findingSample, classification });
    expect(result.success).toBe(true);
  });

  it('rejects a classification outside the eight-member enum', () => {
    const result = FindingSchema.safeParse({ ...findingSample, classification: 'speculative' });
    expect(result.success).toBe(false);
  });
});

describe('RunEvent: additionalProperties is intentionally permissive', () => {
  it('accepts an unknown top-level field (payload shape varies by event type)', () => {
    const result = RunEventSchema.safeParse({ ...runEventSample, correlationId: 'trace-001' });
    expect(result.success).toBe(true);
  });
});
