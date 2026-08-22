/**
 * `RecordedResearchProvider` — the ONLY research provider ever used in tests. Answers exactly the
 * questions it was constructed with a canned response for; an unrecognized question fails closed
 * (throws) rather than fabricating an answer, matching the evidence-first stance elsewhere in this
 * module ("Prefer primary sources... record retrieval dates").
 */
import { ExternalResearchRecordSchema } from '../contracts';
import type { ExternalResearchRecord } from '../contracts';
import type { ResearchDeps, ResearchProvider } from './provider';

export interface RecordedResearchAnswer {
  sourceUrl: string;
  sourceKind: ExternalResearchRecord['sourceKind'];
  summary: string;
}

export class RecordedResearchProvider implements ResearchProvider {
  constructor(private readonly answers: Record<string, RecordedResearchAnswer>) {}

  async research(question: string, deps: ResearchDeps): Promise<ExternalResearchRecord> {
    const answer = this.answers[question];
    if (!answer) {
      throw new Error(`RecordedResearchProvider has no recorded answer for question: "${question}"`);
    }
    const retrievedAt = deps.clock().toISOString();
    const evidenceRecord = deps.evidence.add({
      sourceType: answer.sourceKind === 'official-docs' || answer.sourceKind === 'official-repo' || answer.sourceKind === 'standard'
        ? 'external-primary'
        : 'external-secondary',
      url: answer.sourceUrl,
      sensitivity: 'public',
      facts: [`external research question: ${question}`],
      excerpt: answer.summary.length > 4000 ? answer.summary.slice(0, 4000) : answer.summary,
      citationLabel: answer.sourceUrl,
    });

    return ExternalResearchRecordSchema.parse({
      schemaVersion: 'yellow-goal/external-research-record/v1',
      id: `ext-${evidenceRecord.id.replace(/^ev-/, '')}`,
      question,
      sourceUrl: answer.sourceUrl,
      sourceKind: answer.sourceKind,
      retrievedAt,
      summary: answer.summary,
      evidenceId: evidenceRecord.id,
    });
  }
}
