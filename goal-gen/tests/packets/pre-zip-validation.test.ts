/**
 * `validatePacketPreZip`'s `no-unresolved-placeholders` check, scoped to template-rendered
 * outputs only. Regression coverage for the third live-smoke round: a real evidence excerpt (of
 * goal-gen's own `.claude/specs/packet-compiler.md`, captured while inspecting yellow-goal itself)
 * legitimately contained the literal text `{{PLACEHOLDER}}`, and the OLD unscoped check rejected
 * the whole packet for it. `{{...}}` can only ever originate from `.tmpl` rendering — evidence,
 * research, and contracts/*.json are canonical data or untrusted excerpts, never rendered output.
 */
import { describe, expect, it } from 'vitest';
import type { EvidenceRecord, Finding, MilestoneSpec, RepositoryAssessment } from '../../backend/src/contracts';
import { isTemplateRenderedPath, validatePacketPreZip, type RenderedFile } from '../../backend/src/packets';

const MINIMAL_ASSESSMENT: RepositoryAssessment = {
  schemaVersion: 'yellow-goal/repository-assessment/v1',
  executiveJudgment: { usefulness: 'u', functionality: 'f', cohesion: 'c', milestoneReadiness: 'r' },
  ratings: [],
  findings: [],
  evidenceGaps: [],
  biggestConstraint: 'stub biggest constraint',
};

const MINIMAL_MILESTONE: MilestoneSpec = {
  schemaVersion: 'yellow-goal/milestone/v1',
  goal: 'stub goal',
  whyNow: 'stub why now',
  scope: ['stub scope'],
  nonGoals: ['stub non-goal'],
  acceptanceCriteria: [{ id: 'AC-001', behavior: 'stub behavior', verification: { type: 'command', commandRef: 'test' } }],
  terminalCondition: 'stub terminal condition',
  humanGates: [],
};

function minimalInput(files: RenderedFile[]) {
  return {
    files,
    assessment: MINIMAL_ASSESSMENT,
    findings: [] as Finding[],
    milestone: MINIMAL_MILESTONE,
    evidence: [] as EvidenceRecord[],
    goalResolutionEvidenceRefs: [] as string[],
  };
}

function placeholderCheck(files: RenderedFile[]) {
  const result = validatePacketPreZip(minimalInput(files));
  return result.checks.find((c) => c.id === 'no-unresolved-placeholders')!;
}

describe('isTemplateRenderedPath', () => {
  it('classifies numbered reports, prompts/, templates/, scripts/ as template-rendered', () => {
    expect(isTemplateRenderedPath('00_START_HERE.md')).toBe(true);
    expect(isTemplateRenderedPath('08_HUMAN_GATES.md')).toBe(true);
    expect(isTemplateRenderedPath('prompts/MASTER_IMPLEMENTATION_PROMPT.md')).toBe(true);
    expect(isTemplateRenderedPath('prompts/PERSISTENT_GOAL.txt')).toBe(true);
    expect(isTemplateRenderedPath('templates/FINDING_LEDGER.md')).toBe(true);
    expect(isTemplateRenderedPath('scripts/launch.sh')).toBe(true);
    expect(isTemplateRenderedPath('scripts/preflight.ps1')).toBe(true);
  });

  it('classifies evidence/research/contracts/manifest/checksums as data — never template-rendered', () => {
    expect(isTemplateRenderedPath('evidence/evidence.jsonl')).toBe(false);
    expect(isTemplateRenderedPath('evidence/repository-profile.json')).toBe(false);
    expect(isTemplateRenderedPath('evidence/research-sources.json')).toBe(false);
    expect(isTemplateRenderedPath('research/external-research.jsonl')).toBe(false);
    expect(isTemplateRenderedPath('contracts/request.json')).toBe(false);
    expect(isTemplateRenderedPath('contracts/repository-assessment.json')).toBe(false);
    expect(isTemplateRenderedPath('contracts/orchestration.json')).toBe(false);
    expect(isTemplateRenderedPath('MANIFEST.json')).toBe(false);
    expect(isTemplateRenderedPath('CHECKSUMS.sha256')).toBe(false);
  });
});

describe('no-unresolved-placeholders — scoped to template-rendered outputs', () => {
  it('(a) passes when a data file (evidence.jsonl) contains a literal {{PLACEHOLDER}} in a real excerpt', () => {
    const evidenceLine = JSON.stringify({
      schemaVersion: 'yellow-goal/evidence/v1',
      id: 'ev-001',
      sourceType: 'repository-file',
      path: '.claude/specs/packet-compiler.md',
      retrievedAt: '2026-08-22T00:00:00.000Z',
      contentHash: 'a'.repeat(16),
      sensitivity: 'public',
      facts: ['spec documents the {{PLACEHOLDER}} template syntax'],
      // The exact live-smoke scenario: an excerpt of prose ABOUT the placeholder syntax, which
      // legitimately contains the literal token.
      excerpt: 'packs/ uses {{PLACEHOLDER}} substitution — no logic in templates.',
    });

    const check = placeholderCheck([{ entryPath: 'evidence/evidence.jsonl', content: `${evidenceLine}\n` }]);
    expect(check.status).toBe('passed');
  });

  it('(a-continued) passes for the same literal text in contracts/*.json, research/*, and MANIFEST.json', () => {
    const files: RenderedFile[] = [
      { entryPath: 'contracts/repository-assessment.json', content: '{"biggestConstraint": "mentions {{PLACEHOLDER}} syntax"}' },
      { entryPath: 'research/external-research.jsonl', content: '{"summary": "docs use {{TOKEN}} notation"}\n' },
      { entryPath: 'MANIFEST.json', content: '{"note": "{{NOT_A_REAL_PLACEHOLDER}}"}' },
    ];
    const check = placeholderCheck(files);
    expect(check.status).toBe('passed');
  });

  it('(b) still fails, naming the file, when a rendered report has an unresolved {{TOKEN}}', () => {
    const check = placeholderCheck([{ entryPath: '00_START_HERE.md', content: '# Repo\n\nRelationship: {{ goalResolution.relationship }}\n' }]);
    expect(check.status).toBe('failed');
    expect(check.details).toContain('00_START_HERE.md');
  });

  it('(b-continued) still fails for prompts/, templates/, and scripts/ outputs', () => {
    const files: RenderedFile[] = [
      { entryPath: 'prompts/MASTER_IMPLEMENTATION_PROMPT.md', content: 'Lead: {{ orchestration.lead.modelId }}' },
      { entryPath: 'templates/FINDING_LEDGER.md', content: '| {{FINDING_LEDGER_ROWS}} |' },
      { entryPath: 'scripts/launch.sh', content: 'echo "{{ SHOULD_NOT_BE_HERE }}"' },
    ];
    const check = placeholderCheck(files);
    expect(check.status).toBe('failed');
    expect(check.details).toContain('prompts/MASTER_IMPLEMENTATION_PROMPT.md');
    expect(check.details).toContain('templates/FINDING_LEDGER.md');
    expect(check.details).toContain('scripts/launch.sh');
  });

  it('a data file with a placeholder AND a rendered report with a real unresolved token together: only the rendered report is named', () => {
    const files: RenderedFile[] = [
      { entryPath: 'evidence/evidence.jsonl', content: '{"excerpt": "{{ this is data, not a defect }}"}\n' },
      { entryPath: '05_MILESTONE.md', content: 'Goal: {{ milestone.goal }}' },
    ];
    const check = placeholderCheck(files);
    expect(check.status).toBe('failed');
    expect(check.details).toBe('05_MILESTONE.md');
    expect(check.details).not.toContain('evidence.jsonl');
  });
});
