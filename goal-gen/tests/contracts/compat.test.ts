import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as contracts from '../../backend/src/contracts';
import { loadAppSchema, loadVendoredSchema } from './support/load-schema';
import { validateAgainstJsonSchema } from './support/json-schema-checker';
import * as samples from './support/samples';

/**
 * Contract compatibility matrix: every canonical sample must validate under BOTH the zod contract
 * and its corresponding JSON Schema (vendored or app), and a structurally invalid variant must
 * fail both. Each case is labeled with its provenance (`vendored` vs `app`) so a failing test
 * names which tier's schema disagreed with the zod contract — see goal-gen/schemas/README.md for
 * what "vendored" vs "app" means.
 */

interface CompatCase {
  kind: 'vendored' | 'app';
  name: string;
  schemaFile: string;
  zodSchema: z.ZodTypeAny;
  sample: Record<string, unknown>;
  /** A top-level required key whose removal must make the sample invalid under both schemas. */
  breakKey: string;
}

function omitKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone = { ...obj };
  delete clone[key];
  return clone;
}

const cases: CompatCase[] = [
  {
    kind: 'vendored',
    name: 'RepositoryGoalRequest',
    schemaFile: 'request',
    zodSchema: contracts.RepositoryGoalRequestSchema,
    sample: samples.requestSample,
    breakKey: 'mode',
  },
  {
    kind: 'vendored',
    name: 'RepoProfile',
    schemaFile: 'repo-profile',
    zodSchema: contracts.RepoProfileSchema,
    sample: samples.repoProfileSample,
    breakKey: 'evidenceRefs',
  },
  {
    kind: 'vendored',
    name: 'EvidenceRecord',
    schemaFile: 'evidence-record',
    zodSchema: contracts.EvidenceRecordSchema,
    sample: samples.evidenceRecordSample,
    breakKey: 'contentHash',
  },
  {
    kind: 'vendored',
    name: 'Finding',
    schemaFile: 'finding',
    zodSchema: contracts.FindingSchema,
    sample: samples.findingSample,
    breakKey: 'requiredBehavior',
  },
  {
    kind: 'vendored',
    name: 'RepositoryAssessment',
    schemaFile: 'repository-assessment',
    zodSchema: contracts.RepositoryAssessmentSchema,
    sample: samples.repositoryAssessmentSample,
    breakKey: 'biggestConstraint',
  },
  {
    kind: 'vendored',
    name: 'GoalResolution',
    schemaFile: 'goal-resolution',
    zodSchema: contracts.GoalResolutionSchema,
    sample: samples.goalResolutionSample,
    breakKey: 'selectedMilestoneId',
  },
  {
    kind: 'vendored',
    name: 'MilestoneSpec',
    schemaFile: 'milestone',
    zodSchema: contracts.MilestoneSpecSchema,
    sample: samples.milestoneSpecSample,
    breakKey: 'terminalCondition',
  },
  {
    kind: 'vendored',
    name: 'OrchestrationSpec',
    schemaFile: 'orchestration',
    zodSchema: contracts.OrchestrationSpecSchema,
    sample: samples.orchestrationSpecSample,
    breakKey: 'stopConditions',
  },
  {
    kind: 'vendored',
    name: 'PacketManifest',
    schemaFile: 'packet-manifest',
    zodSchema: contracts.PacketManifestSchema,
    sample: samples.packetManifestSample,
    breakKey: 'timestampFields',
  },
  {
    kind: 'vendored',
    name: 'RunEvent',
    schemaFile: 'run-event',
    zodSchema: contracts.RunEventSchema,
    sample: samples.runEventSample,
    breakKey: 'type',
  },
  {
    kind: 'app',
    name: 'ResolvedRepositoryTarget',
    schemaFile: 'resolved-repository-target',
    zodSchema: contracts.ResolvedRepositoryTargetSchema,
    sample: samples.resolvedRepositoryTargetSample,
    breakKey: 'accessLevel',
  },
  {
    kind: 'app',
    name: 'CommandRecord',
    schemaFile: 'command-record',
    zodSchema: contracts.CommandRecordSchema,
    sample: samples.commandRecordSample,
    breakKey: 'sideEffectClass',
  },
  {
    kind: 'app',
    name: 'ExternalResearchRecord',
    schemaFile: 'external-research-record',
    zodSchema: contracts.ExternalResearchRecordSchema,
    sample: samples.externalResearchRecordSample,
    breakKey: 'evidenceId',
  },
  {
    kind: 'app',
    name: 'ModelRoleBinding',
    schemaFile: 'model-role-binding',
    zodSchema: contracts.ModelRoleBindingSchema,
    sample: samples.modelRoleBindingSample,
    breakKey: 'provider',
  },
  {
    kind: 'app',
    name: 'OrchestrationProfile',
    schemaFile: 'orchestration-profile',
    zodSchema: contracts.OrchestrationProfileSchema,
    sample: samples.orchestrationProfileSample,
    breakKey: 'docSource',
  },
  {
    kind: 'app',
    name: 'ValidationResult',
    schemaFile: 'validation-result',
    zodSchema: contracts.ValidationResultSchema,
    sample: samples.validationResultSample,
    breakKey: 'overall',
  },
  {
    kind: 'app',
    name: 'FinalHandoff',
    schemaFile: 'final-handoff',
    zodSchema: contracts.FinalHandoffSchema,
    sample: samples.finalHandoffSample,
    breakKey: 'evidenceSummary',
  },
];

describe.each(cases)('contract compatibility: $kind/$name', ({ kind, name, schemaFile, zodSchema, sample, breakKey }) => {
  const jsonSchema = kind === 'vendored' ? loadVendoredSchema(schemaFile) : loadAppSchema(schemaFile);

  it(`[${kind}/${name}] canonical sample satisfies both the zod contract and the JSON Schema`, () => {
    const zodResult = zodSchema.safeParse(sample);
    const zodDetail = zodResult.success ? '' : JSON.stringify(zodResult.error.issues);
    expect(zodResult.success, `[${kind}/${name}] zod rejected a canonical sample: ${zodDetail}`).toBe(true);

    const jsonResult = validateAgainstJsonSchema(jsonSchema, sample);
    expect(
      jsonResult.valid,
      `[${kind}/${name}] JSON Schema (${schemaFile}.schema.json) rejected a canonical sample: ${jsonResult.errors.join('; ')}`,
    ).toBe(true);
  });

  it(`[${kind}/${name}] removing required "${breakKey}" fails both the zod contract and the JSON Schema`, () => {
    const invalid = omitKey(sample, breakKey);

    const zodResult = zodSchema.safeParse(invalid);
    expect(zodResult.success, `[${kind}/${name}] zod unexpectedly accepted a sample missing "${breakKey}"`).toBe(
      false,
    );

    const jsonResult = validateAgainstJsonSchema(jsonSchema, invalid);
    expect(
      jsonResult.valid,
      `[${kind}/${name}] JSON Schema (${schemaFile}.schema.json) unexpectedly accepted a sample missing "${breakKey}"`,
    ).toBe(false);
  });
});
