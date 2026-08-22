/**
 * Tests for research/provider.ts + recorded-provider.ts (the ONLY provider used in tests —
 * ClaudeCliResearchProvider needs a live `claude` binary and is intentionally unexercised here).
 * Covers: recorded answers produce a linked EvidenceRecord + ExternalResearchRecord pair, an
 * unrecognized question fails closed, and runBoundedResearch enforces the question cap.
 */
import { describe, expect, it } from 'vitest';
import { EvidenceStore } from '../../backend/src/evidence/store';
import { RecordedResearchProvider } from '../../backend/src/research/recorded-provider';
import { runBoundedResearch } from '../../backend/src/research/provider';

const FIXED_CLOCK = () => new Date('2024-06-01T00:00:00.000Z');

describe('research/provider + recorded-provider', () => {
  it('answers a recorded question with a linked EvidenceRecord + ExternalResearchRecord', async () => {
    const evidence = new EvidenceStore(FIXED_CLOCK);
    const provider = new RecordedResearchProvider({
      'What is the current LTS version of Node.js?': {
        sourceUrl: 'https://nodejs.org/en/about/previous-releases',
        sourceKind: 'official-docs',
        summary: 'Fixture summary: Node.js LTS release information.',
      },
    });

    const record = await provider.research('What is the current LTS version of Node.js?', { evidence, clock: FIXED_CLOCK });
    expect(record.question).toBe('What is the current LTS version of Node.js?');
    expect(record.sourceKind).toBe('official-docs');
    expect(record.retrievedAt).toBe('2024-06-01T00:00:00.000Z');

    const stored = evidence.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(record.evidenceId);
    expect(stored[0]!.sourceType).toBe('external-primary');
  });

  it('classifies non-primary source kinds as external-secondary evidence', async () => {
    const evidence = new EvidenceStore(FIXED_CLOCK);
    const provider = new RecordedResearchProvider({
      'blog question': { sourceUrl: 'https://example.com/blog-post', sourceKind: 'other', summary: 'Fixture secondary source.' },
    });
    const record = await provider.research('blog question', { evidence, clock: FIXED_CLOCK });
    expect(evidence.list()[0]!.sourceType).toBe('external-secondary');
    expect(record.sourceKind).toBe('other');
  });

  it('fails closed for a question with no recorded answer', async () => {
    const evidence = new EvidenceStore(FIXED_CLOCK);
    const provider = new RecordedResearchProvider({});
    await expect(provider.research('unrecorded question', { evidence, clock: FIXED_CLOCK })).rejects.toThrow(
      /no recorded answer/,
    );
  });

  it('runBoundedResearch caps the number of questions actually asked', async () => {
    const evidence = new EvidenceStore(FIXED_CLOCK);
    const provider = new RecordedResearchProvider({
      'question one': { sourceUrl: 'https://example.com/1', sourceKind: 'official-docs', summary: 's1' },
      'question two': { sourceUrl: 'https://example.com/2', sourceKind: 'official-docs', summary: 's2' },
      'question three': { sourceUrl: 'https://example.com/3', sourceKind: 'official-docs', summary: 's3' },
    });

    const result = await runBoundedResearch(
      provider,
      ['question one', 'question two', 'question three'],
      { evidence, clock: FIXED_CLOCK },
      2,
    );
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.question)).toEqual(['question one', 'question two']);
    expect(result.skippedQuestions).toEqual(['question three']);
  });
});
