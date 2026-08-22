/**
 * Analysis module tests. Uses only `RecordedAnalysisProvider` — never the live
 * `ClaudeCliAnalysisProvider` (`.claude/specs/packet-compiler.md` "Testing": no live `claude`).
 */
import { mkdtemp, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AnalysisProviderError,
  BundleValidationError,
  DEFAULT_ORCHESTRATION_PROFILE_ID,
  createAnalyzeRepository,
  RecordedAnalysisProvider,
  readAnalysisBundle,
  resolveDefaultOrchestrationProfile,
  resolveDefaultOrchestrationSpec,
  type AnalysisProvider,
  type AnalysisProviderInput,
  type AnalysisProviderOutput,
} from '../../backend/src/analysis';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'analysis', 'node-plugin');
const FIXED_CLOCK = (): Date => new Date('2026-08-22T00:00:00.000Z');

describe('RecordedAnalysisProvider', () => {
  it('returns the fixture assessment/goalResolution/milestone verbatim (validated), ignoring input', async () => {
    const provider = new RecordedAnalysisProvider(FIXTURE_DIR);
    const output = await provider.analyze({
      request: JSON.parse(await readFile(path.join(FIXTURE_DIR, 'request.json'), 'utf8')),
      repoProfile: JSON.parse(await readFile(path.join(FIXTURE_DIR, 'repository-profile.json'), 'utf8')),
      evidence: [],
      externalResearch: [],
    });
    expect(output.goalResolution.selectedMilestoneId).toBe('M-node-plugin-lint');
    expect(output.assessment.findings).toHaveLength(1);
    expect(output.milestone.acceptanceCriteria).toHaveLength(1);
  });

  it('is pure: two calls with different input produce byte-identical output', async () => {
    const provider = new RecordedAnalysisProvider(FIXTURE_DIR);
    const a = await provider.analyze({ request: {} as never, repoProfile: {} as never, evidence: [], externalResearch: [] });
    const b = await provider.analyze({ request: {} as never, repoProfile: {} as never, evidence: [{ id: 'ev-999' } as never], externalResearch: [] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('orchestration-defaults', () => {
  it('resolves the exact documented default profile: lead fable-5; investigation opus/opus/sonnet; implementation sonnet x3; verification opus/opus/sonnet', () => {
    const profile = resolveDefaultOrchestrationProfile(FIXED_CLOCK);
    expect(profile.id).toBe(DEFAULT_ORCHESTRATION_PROFILE_ID);
    expect(profile.roleBindings.lead.modelId).toBe('claude-fable-5');

    const spec = resolveDefaultOrchestrationSpec(profile);
    expect(spec.profileId).toBe('claude-fable-opus-sonnet@1');
    expect(spec.lead.modelId).toBe('claude-fable-5');
    expect(spec.teamMode).toBe('agent-team-preferred');
    expect(spec.fallbackMode).toBe('subagents');

    const investigation = spec.waves.find((w) => w.name === 'investigation')!;
    expect(investigation.teammates.map((t) => t.modelId)).toEqual(['claude-opus-5', 'claude-opus-5', 'claude-sonnet-5']);
    expect(investigation.readOnly).toBe(true);

    const implementation = spec.waves.find((w) => w.name === 'implementation')!;
    expect(implementation.teammates.map((t) => t.modelId)).toEqual(['claude-sonnet-5', 'claude-sonnet-5', 'claude-sonnet-5']);
    expect(implementation.requiresPlanApproval).toBe(true);

    const verification = spec.waves.find((w) => w.name === 'verification')!;
    expect(verification.teammates.map((t) => t.modelId)).toEqual(['claude-opus-5', 'claude-opus-5', 'claude-sonnet-5']);
    expect(verification.freshContext).toBe(true);
  });

  it('is deterministic given the same clock', () => {
    const a = resolveDefaultOrchestrationSpec(resolveDefaultOrchestrationProfile(FIXED_CLOCK));
    const b = resolveDefaultOrchestrationSpec(resolveDefaultOrchestrationProfile(FIXED_CLOCK));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('createAnalyzeRepository', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), 'analyze-bundle-'));
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('writes a complete analysis bundle (assessment/goal-resolution/milestone/orchestration/provider/repository-profile/evidence/research)', async () => {
    const analyze = createAnalyzeRepository(new RecordedAnalysisProvider(FIXTURE_DIR), FIXED_CLOCK);
    const result = await analyze({
      requestPath: path.join(FIXTURE_DIR, 'request.json'),
      repoProfilePath: path.join(FIXTURE_DIR, 'repository-profile.json'),
      outputDir,
    });

    expect(result.assessmentPath).toBe(path.join(outputDir, 'assessment.json'));
    expect(result.goalResolutionPath).toBe(path.join(outputDir, 'goal-resolution.json'));
    expect(result.milestonePath).toBe(path.join(outputDir, 'milestone.json'));
    expect(result.providerId).toBe('recorded-fixture');

    const bundle = await readAnalysisBundle(result.assessmentPath);
    expect(bundle.providerId).toBe('recorded-fixture');
    expect(bundle.repoProfile.target.repository).toBe('local/node-plugin-fixture');
    // Evidence sibling (evidence/evidence.jsonl next to repository-profile.json) was picked up.
    expect(bundle.evidence).toHaveLength(1);
    expect(bundle.evidence[0]!.id).toBe('ev-001');
    expect(bundle.orchestration.profileId).toBe('claude-fable-opus-sonnet@1');
  });

  it('readAnalysisBundle (and therefore compilePacket) fails with a structured error naming the exact missing sibling file — no silent fallback', async () => {
    const analyze = createAnalyzeRepository(new RecordedAnalysisProvider(FIXTURE_DIR), FIXED_CLOCK);
    const result = await analyze({
      requestPath: path.join(FIXTURE_DIR, 'request.json'),
      repoProfilePath: path.join(FIXTURE_DIR, 'repository-profile.json'),
      outputDir,
    });

    // Remove one required sibling and confirm the failure names it specifically.
    await unlink(path.join(outputDir, 'goal-resolution.json'));

    await expect(readAnalysisBundle(result.assessmentPath)).rejects.toThrow(BundleValidationError);
    try {
      await readAnalysisBundle(result.assessmentPath);
      expect.unreachable('expected BundleValidationError');
    } catch (e) {
      expect(e).toBeInstanceOf(BundleValidationError);
      expect((e as BundleValidationError).message).toContain('goal-resolution.json');
      expect((e as BundleValidationError).message).not.toContain('milestone.json');
    }
  });

  it('readAnalysisBundle fails closed when provider.json is missing — never defaults providerId to unknown', async () => {
    const analyze = createAnalyzeRepository(new RecordedAnalysisProvider(FIXTURE_DIR), FIXED_CLOCK);
    const result = await analyze({
      requestPath: path.join(FIXTURE_DIR, 'request.json'),
      repoProfilePath: path.join(FIXTURE_DIR, 'repository-profile.json'),
      outputDir,
    });

    await unlink(path.join(outputDir, 'provider.json'));

    await expect(readAnalysisBundle(result.assessmentPath)).rejects.toThrow(BundleValidationError);
    try {
      await readAnalysisBundle(result.assessmentPath);
      expect.unreachable('expected BundleValidationError');
    } catch (e) {
      expect(e).toBeInstanceOf(BundleValidationError);
      expect((e as BundleValidationError).message).toContain('provider.json');
    }
  });
});

/**
 * Regression coverage for the live-smoke defect: a provider that returns a finding with an
 * out-of-enum `classification` (e.g. the model-invented `"missing_capability"`, not in
 * `FindingSchema`'s enum) must be caught BEFORE `createAnalyzeRepository` writes anything to
 * `outputDir` — never a silent write of an invalid bundle that only fails later at compile time.
 * Uses a hand-written stub `AnalysisProvider` (not `RecordedAnalysisProvider`) so the assertion is
 * about `createAnalyzeRepository`'s own gate, independent of any one provider's read-time checks.
 */
function buildValidAssessmentShape(): Record<string, unknown> {
  return {
    schemaVersion: 'yellow-goal/repository-assessment/v1',
    executiveJudgment: {
      usefulness: 'stub',
      functionality: 'stub',
      cohesion: 'stub',
      milestoneReadiness: 'stub',
    },
    ratings: [],
    findings: [],
    evidenceGaps: [],
    biggestConstraint: 'stub',
  };
}

function buildValidGoalResolution(): Record<string, unknown> {
  return {
    schemaVersion: 'yellow-goal/goal-resolution/v1',
    requestedGoal: 'stub requested goal',
    selectedGoal: 'stub selected goal',
    selectedMilestoneId: 'M-stub',
    relationship: 'exact',
    rationale: 'stub rationale',
    evidenceRefs: ['ev-001'],
  };
}

function buildValidMilestone(): Record<string, unknown> {
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

/** A stub `AnalysisProvider` that returns whatever `findingsOverride` is given for
 *  `assessment.findings`, bypassing any provider-internal validation entirely — used to exercise
 *  `createAnalyzeRepository`'s own pre-write gate in isolation. */
class StubAnalysisProvider implements AnalysisProvider {
  readonly providerId = 'stub-provider';
  constructor(private readonly findingsOverride: Record<string, unknown>[]) {}

  async analyze(_input: AnalysisProviderInput): Promise<AnalysisProviderOutput> {
    return {
      assessment: { ...buildValidAssessmentShape(), findings: this.findingsOverride } as AnalysisProviderOutput['assessment'],
      goalResolution: buildValidGoalResolution() as AnalysisProviderOutput['goalResolution'],
      milestone: buildValidMilestone() as AnalysisProviderOutput['milestone'],
    };
  }
}

describe('createAnalyzeRepository — pre-write validation gate (regression for the live-smoke defect)', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), 'analyze-gate-'));
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('rejects an out-of-enum finding.classification BEFORE writing anything to outputDir', async () => {
    const invalidFinding = {
      schemaVersion: 'yellow-goal/finding/v1',
      id: 'F-001',
      severity: 'medium',
      // The exact defect the live smoke hit: a plausible-but-wrong classification not in
      // FindingSchema's enum (verified_defect | strongly_supported_risk |
      // documentation_contradiction | missing_evidence | intentional_limitation |
      // obsolete_finding | duplicate_finding | unknown).
      classification: 'missing_capability',
      title: 'stub finding',
      evidenceRefs: ['ev-001'],
      consequence: 'stub consequence',
      requiredBehavior: 'stub required behavior',
    };
    const provider = new StubAnalysisProvider([invalidFinding]);
    const analyze = createAnalyzeRepository(provider, FIXED_CLOCK);

    await expect(
      analyze({
        requestPath: path.join(FIXTURE_DIR, 'request.json'),
        repoProfilePath: path.join(FIXTURE_DIR, 'repository-profile.json'),
        outputDir,
      }),
    ).rejects.toBeInstanceOf(AnalysisProviderError);

    try {
      await analyze({
        requestPath: path.join(FIXTURE_DIR, 'request.json'),
        repoProfilePath: path.join(FIXTURE_DIR, 'repository-profile.json'),
        outputDir,
      });
      expect.unreachable('expected AnalysisProviderError');
    } catch (e) {
      expect(e).toBeInstanceOf(AnalysisProviderError);
      expect((e as AnalysisProviderError).message).toContain('findings[0]');
      expect((e as AnalysisProviderError).message).toContain('classification');
    }

    // Nothing was written — no partial/invalid bundle on disk.
    const entries = await readdir(outputDir).catch(() => []);
    expect(entries).toEqual([]);
  });

  it('accepts a valid finding classification and writes the bundle normally', async () => {
    const validFinding = {
      schemaVersion: 'yellow-goal/finding/v1',
      id: 'F-001',
      severity: 'medium',
      classification: 'missing_evidence',
      title: 'stub finding',
      evidenceRefs: ['ev-001'],
      consequence: 'stub consequence',
      requiredBehavior: 'stub required behavior',
    };
    const provider = new StubAnalysisProvider([validFinding]);
    const analyze = createAnalyzeRepository(provider, FIXED_CLOCK);

    const result = await analyze({
      requestPath: path.join(FIXTURE_DIR, 'request.json'),
      repoProfilePath: path.join(FIXTURE_DIR, 'repository-profile.json'),
      outputDir,
    });

    const written = JSON.parse(await readFile(result.assessmentPath, 'utf8')) as { findings: { classification: string }[] };
    expect(written.findings[0]!.classification).toBe('missing_evidence');
  });
});
