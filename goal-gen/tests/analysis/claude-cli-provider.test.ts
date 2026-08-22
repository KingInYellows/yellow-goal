/**
 * `ClaudeCliAnalysisProvider` parse/repair-round tests. Never invokes a real `claude` process —
 * every test injects a fake `ClaudeInvocation` function into the constructor, so this exercises
 * only the class's own parse/validate/repair logic (`.claude/specs/packet-compiler.md` "Testing":
 * no live `claude` in tests).
 *
 * Regression coverage for the live-smoke defect: a live `claude -sonnet-5` call returned a finding
 * with `classification: "missing_capability"` (not in `FindingSchema`'s enum) that passed the
 * provider's OLD top-level-only validation and got written to disk, only failing much later at
 * compile time. These tests prove: (1) an out-of-enum classification triggers exactly one bounded
 * repair round, (2) a corrected repair response succeeds, (3) a repair response that is still
 * invalid throws a structured `AnalysisProviderError` — never a silent bad output.
 */
import { describe, expect, it } from 'vitest';
import {
  AnalysisProviderError,
  ClaudeCliAnalysisProvider,
  requiredKeysOf,
  type ClaudeInvocation,
  type ClaudeInvocationResult,
} from '../../backend/src/analysis';
import type { AnalysisProviderInput } from '../../backend/src/analysis';
import { FindingSchema } from '../../backend/src/contracts';

function validAssessment(classification: string): unknown {
  return {
    schemaVersion: 'yellow-goal/repository-assessment/v1',
    executiveJudgment: { usefulness: 'usf', functionality: 'fnc', cohesion: 'coh', milestoneReadiness: 'rdy' },
    ratings: [],
    findings: [
      {
        schemaVersion: 'yellow-goal/finding/v1',
        id: 'F-001',
        severity: 'medium',
        classification,
        title: 'stub finding title',
        evidenceRefs: ['ev-001'],
        consequence: 'stub consequence',
        requiredBehavior: 'stub required behavior',
      },
    ],
    evidenceGaps: [],
    biggestConstraint: 'stub biggest constraint',
  };
}

function validGoalResolution(): unknown {
  return {
    schemaVersion: 'yellow-goal/goal-resolution/v1',
    requestedGoal: 'stub requested goal',
    selectedGoal: 'stub selected goal',
    selectedMilestoneId: 'M-1',
    relationship: 'exact',
    rationale: 'stub rationale',
    evidenceRefs: ['ev-001'],
  };
}

function validMilestone(): unknown {
  return {
    schemaVersion: 'yellow-goal/milestone/v1',
    goal: 'stub milestone goal',
    whyNow: 'stub why now',
    scope: ['stub scope item'],
    nonGoals: ['stub non-goal'],
    acceptanceCriteria: [{ id: 'AC-001', behavior: 'stub behavior', verification: { type: 'command', commandRef: 'test' } }],
    terminalCondition: 'stub terminal condition',
    humanGates: [],
  };
}

function envelopeFor(payload: unknown): ClaudeInvocationResult {
  return { stdout: JSON.stringify({ result: JSON.stringify(payload) }), stderr: '', code: 0 };
}

const STUB_EVIDENCE = {
  schemaVersion: 'yellow-goal/evidence/v1' as const,
  id: 'ev-001',
  sourceType: 'repository-file' as const,
  path: 'package.json',
  retrievedAt: '2026-08-22T00:00:00.000Z',
  contentHash: 'a'.repeat(40),
  sensitivity: 'public' as const,
  facts: ['package.json declares a test script'],
  excerpt: '{"scripts":{"test":"vitest run"}}',
};

const STUB_INPUT: AnalysisProviderInput = {
  request: {
    schemaVersion: 'yellow-goal/request/v1',
    requestId: 'req-1',
    target: { repository: 'local/stub' },
    intent: { goal: 'stub goal' },
    mode: 'review-and-compile',
  } as unknown as AnalysisProviderInput['request'],
  repoProfile: {
    schemaVersion: 'yellow-goal/repo-profile/v1',
    target: { repository: 'local/stub', resolvedRef: 'main', headSha: '0'.repeat(40), inspectedAt: '2026-08-22T00:00:00.000Z' },
    repositoryKinds: [],
    instructionFiles: [],
    commands: [],
    evidenceRefs: [],
  } as unknown as AnalysisProviderInput['repoProfile'],
  evidence: [STUB_EVIDENCE],
  externalResearch: [],
};

describe('ClaudeCliAnalysisProvider — parse and one bounded repair round', () => {
  it('succeeds on the first attempt when everything validates (no repair round triggered)', async () => {
    const calls: string[][] = [];
    const invoke: ClaudeInvocation = async (argv) => {
      calls.push([...argv]);
      return envelopeFor({ assessment: validAssessment('missing_evidence'), goalResolution: validGoalResolution(), milestone: validMilestone() });
    };

    const provider = new ClaudeCliAnalysisProvider(invoke);
    const output = await provider.analyze(STUB_INPUT);

    expect(calls).toHaveLength(1);
    expect(output.assessment.findings[0]!.classification).toBe('missing_evidence');
  });

  it('an out-of-enum finding.classification triggers exactly one repair round, which succeeds', async () => {
    const calls: string[][] = [];
    const invoke: ClaudeInvocation = async (argv) => {
      calls.push([...argv]);
      if (calls.length === 1) {
        // The exact live-smoke defect: a plausible-but-wrong classification.
        return envelopeFor({ assessment: validAssessment('missing_capability'), goalResolution: validGoalResolution(), milestone: validMilestone() });
      }
      return envelopeFor({ assessment: validAssessment('missing_evidence'), goalResolution: validGoalResolution(), milestone: validMilestone() });
    };

    const provider = new ClaudeCliAnalysisProvider(invoke);
    const output = await provider.analyze(STUB_INPUT);

    expect(calls).toHaveLength(2);
    // The repair prompt (the -p argument) names the exact failure so the model can fix it.
    const repairPrompt = calls[1]![1]!;
    expect(repairPrompt).toContain('failed validation');
    expect(repairPrompt).toContain('findings[0]');
    expect(repairPrompt).toContain('classification');
    expect(repairPrompt).toContain('Return corrected JSON only');
    expect(output.assessment.findings[0]!.classification).toBe('missing_evidence');
  });

  it('throws AnalysisProviderError naming the specific failure if the repair round is STILL invalid — never returns a bad output, never repairs more than once', async () => {
    const calls: string[][] = [];
    const invoke: ClaudeInvocation = async (argv) => {
      calls.push([...argv]);
      // Invalid every time.
      return envelopeFor({ assessment: validAssessment('missing_capability'), goalResolution: validGoalResolution(), milestone: validMilestone() });
    };

    const provider = new ClaudeCliAnalysisProvider(invoke);

    await expect(provider.analyze(STUB_INPUT)).rejects.toBeInstanceOf(AnalysisProviderError);
    expect(calls).toHaveLength(2); // exactly one repair round, never a second

    try {
      await provider.analyze(STUB_INPUT);
      expect.unreachable('expected AnalysisProviderError');
    } catch (e) {
      expect((e as AnalysisProviderError).message).toContain('findings[0]');
      expect((e as AnalysisProviderError).message).toContain('classification');
    }
  });

  it('the initial prompt serializes evidence ids, facts, and excerpts — not just a count', async () => {
    let firstPrompt = '';
    const invoke: ClaudeInvocation = async (argv) => {
      if (!firstPrompt) firstPrompt = argv[1]!;
      return envelopeFor({ assessment: validAssessment('missing_evidence'), goalResolution: validGoalResolution(), milestone: validMilestone() });
    };

    const provider = new ClaudeCliAnalysisProvider(invoke);
    await provider.analyze(STUB_INPUT);

    expect(firstPrompt).toContain('ev-001');
    expect(firstPrompt).toContain('package.json declares a test script');
    expect(firstPrompt).toContain('vitest run');
    expect(firstPrompt).not.toMatch(/Evidence records available: 0/);
  });

  it('the initial prompt enumerates the exact allowed enum values (prevents inventing a plausible-but-wrong value)', async () => {
    let firstPrompt = '';
    const invoke: ClaudeInvocation = async (argv) => {
      if (!firstPrompt) firstPrompt = argv[1]!;
      return envelopeFor({ assessment: validAssessment('missing_evidence'), goalResolution: validGoalResolution(), milestone: validMilestone() });
    };

    const provider = new ClaudeCliAnalysisProvider(invoke);
    await provider.analyze(STUB_INPUT);

    expect(firstPrompt).toContain('verified_defect');
    expect(firstPrompt).toContain('strongly_supported_risk');
    expect(firstPrompt).toContain('documentation_contradiction');
    expect(firstPrompt).toContain('missing_evidence');
    expect(firstPrompt).toContain('intentional_limitation');
    expect(firstPrompt).toContain('obsolete_finding');
    expect(firstPrompt).toContain('duplicate_finding');
    expect(firstPrompt).toContain('"exact" | "refined" | "prerequisite" | "blocked"');
    expect(firstPrompt).toContain('"command" | "workflow" | "inspection" | "human"');
  });

  it('the initial prompt describes the full field-by-field response shape, not just enum values (regression for the second live-smoke round: model produced findings missing required fields and invented unrecognized keys)', async () => {
    let firstPrompt = '';
    const invoke: ClaudeInvocation = async (argv) => {
      if (!firstPrompt) firstPrompt = argv[1]!;
      return envelopeFor({ assessment: validAssessment('missing_evidence'), goalResolution: validGoalResolution(), milestone: validMilestone() });
    };

    const provider = new ClaudeCliAnalysisProvider(invoke);
    await provider.analyze(STUB_INPUT);

    // Every required Finding field the second live-smoke round showed the model omitting.
    expect(firstPrompt).toContain('"schemaVersion": "yellow-goal/finding/v1"');
    expect(firstPrompt).toContain('"consequence": "<string, required>"');
    expect(firstPrompt).toContain('"requiredBehavior": "<string, required>"');
    expect(firstPrompt).toContain('"id": "<string, required>"');
    expect(firstPrompt).toContain('"title": "<string, required>"');

    // Every top-level assessment/goalResolution/milestone required field is present too.
    expect(firstPrompt).toContain('"selectedMilestoneId": "<string, required>"');
    expect(firstPrompt).toContain('"acceptanceCriteria"');
    expect(firstPrompt).toContain('"biggestConstraint": "<string, required>"');

    // Explicit no-unrecognized-keys instruction (the model previously invented
    // summary/recommendation keys that are not in any schema).
    expect(firstPrompt).toMatch(/no\s+additional keys anywhere/i);
    expect(firstPrompt).toMatch(/strict\s*\(rejects unknown\s+keys\)/i);
  });

  it('anti-rot: the prompt mentions every REQUIRED key of FindingSchema, derived from the schema itself — fails automatically if FindingSchema ever gains a required field the prompt does not describe', async () => {
    let firstPrompt = '';
    const invoke: ClaudeInvocation = async (argv) => {
      if (!firstPrompt) firstPrompt = argv[1]!;
      return envelopeFor({ assessment: validAssessment('missing_evidence'), goalResolution: validGoalResolution(), milestone: validMilestone() });
    };

    const provider = new ClaudeCliAnalysisProvider(invoke);
    await provider.analyze(STUB_INPUT);

    const required = requiredKeysOf(FindingSchema);
    expect(required.length).toBeGreaterThan(0); // sanity: the introspection itself found something
    for (const key of required) {
      expect(firstPrompt, `expected the prompt to mention required Finding key "${key}"`).toContain(`"${key}":`);
    }
  });

  it('the repair prompt re-states the full response shape alongside the zod errors, not just the enum list', async () => {
    const calls: string[][] = [];
    const invoke: ClaudeInvocation = async (argv) => {
      calls.push([...argv]);
      if (calls.length === 1) {
        // Missing required Finding fields + an invented unrecognized key, matching the second
        // live-smoke defect exactly.
        return envelopeFor({
          assessment: {
            schemaVersion: 'yellow-goal/repository-assessment/v1',
            executiveJudgment: { usefulness: 'usf', functionality: 'fnc', cohesion: 'coh', milestoneReadiness: 'rdy' },
            ratings: [],
            findings: [{ id: 'F-001', severity: 'medium', classification: 'missing_evidence', title: 'stub', summary: 'unrecognized key' }],
            evidenceGaps: [],
            biggestConstraint: 'stub biggest constraint',
          },
          goalResolution: validGoalResolution(),
          milestone: validMilestone(),
        });
      }
      return envelopeFor({ assessment: validAssessment('missing_evidence'), goalResolution: validGoalResolution(), milestone: validMilestone() });
    };

    const provider = new ClaudeCliAnalysisProvider(invoke);
    const output = await provider.analyze(STUB_INPUT);

    expect(calls).toHaveLength(2);
    const repairPrompt = calls[1]![1]!;
    expect(repairPrompt).toContain('failed validation');
    // The skeleton is restated near the errors, not just once at the top of the (now-long) prompt.
    expect(repairPrompt).toContain('Required response shape');
    expect(repairPrompt).toContain('"consequence": "<string, required>"');
    expect(repairPrompt).toContain('"requiredBehavior": "<string, required>"');
    expect(output.assessment.findings[0]!.classification).toBe('missing_evidence');
  });

  it('a non-zero exit code is treated as a failure eligible for the repair round', async () => {
    const calls: string[][] = [];
    const invoke: ClaudeInvocation = async (argv) => {
      calls.push([...argv]);
      if (calls.length === 1) return { stdout: '', stderr: 'boom', code: 1 };
      return envelopeFor({ assessment: validAssessment('missing_evidence'), goalResolution: validGoalResolution(), milestone: validMilestone() });
    };

    const provider = new ClaudeCliAnalysisProvider(invoke);
    const output = await provider.analyze(STUB_INPUT);
    expect(calls).toHaveLength(2);
    expect(output.assessment.findings[0]!.classification).toBe('missing_evidence');
  });
});
