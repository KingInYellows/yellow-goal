import { describe, expect, it } from 'vitest';
import type { EvidenceRecord } from '../../backend/src/contracts';
import { fenceLongerThanContent, renderRepoExcerptsFencedBlock } from '../../backend/src/packets/fragment-renderers';

function excerptRecord(excerpt: string): EvidenceRecord {
  return {
    schemaVersion: 'yellow-goal/evidence/v1',
    id: 'ev-readme',
    sourceType: 'repository-file',
    retrievedAt: '2026-08-22T00:00:00.000Z',
    contentHash: 'sha256-0123456789abcdef',
    sensitivity: 'public',
    facts: ['readme present'],
    path: 'README.md',
    excerpt,
  };
}

describe('fenceLongerThanContent', () => {
  it('uses a 3-backtick fence when the excerpt has no backticks', () => {
    expect(fenceLongerThanContent('plain text')).toBe('```');
  });

  it('uses one more backtick than the longest run in the excerpt', () => {
    expect(fenceLongerThanContent('before\n```text\ninjected\n```\nafter')).toBe('````');
    expect(fenceLongerThanContent('`````already long')).toBe('``````');
  });
});

describe('renderRepoExcerptsFencedBlock', () => {
  it('does not let a triple-backtick excerpt close the fence and inject Markdown', () => {
    const rendered = renderRepoExcerptsFencedBlock([
      excerptRecord('# Title\n\n```text\n# injected heading\n```\nmore'),
    ]);
    expect(rendered).toContain('````text\n');
    expect(rendered).toContain('# injected heading');
    expect(rendered.endsWith('````')).toBe(true);
    const innerStart = rendered.indexOf('````text\n') + '````text\n'.length;
    const inner = rendered.slice(innerStart, rendered.lastIndexOf('\n````'));
    expect(inner).toContain('```text');
    expect(inner).toContain('# injected heading');
  });
});
