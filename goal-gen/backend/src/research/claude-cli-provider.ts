/**
 * `ClaudeCliResearchProvider` — STUB live-research provider that shells `claude -p <question>`
 * (argument array, never `shell: true`, bounded output, timeout). NOT exercised by any test in
 * this suite — it requires a live `claude` CLI and produces genuinely non-deterministic output,
 * which is exactly what `RecordedResearchProvider` exists to avoid in tests.
 *
 * `claude -p` answers aren't tied to a single retrievable URL the way a web source is, so
 * `sourceUrl` is a synthetic `claude-cli:<question-hash>` identifier — this is a placeholder,
 * not a real citation, and callers building citable evidence for a packet should prefer a
 * provider backed by an actual primary source when one exists.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ExternalResearchRecordSchema } from '../contracts';
import type { ExternalResearchRecord } from '../contracts';
import type { ResearchDeps, ResearchProvider } from './provider';

const CLAUDE_TIMEOUT_MS = 60_000;
const CLAUDE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const SUMMARY_CHAR_CAP = 4000;

export interface ClaudeCliResearchProviderOptions {
  /** Defaults to 'other' — a live implementation would need real source-classification logic to
   *  claim 'official-docs'/'official-repo'/'standard'/'primary-research' honestly. */
  sourceKind?: ExternalResearchRecord['sourceKind'];
}

export class ClaudeCliResearchProvider implements ResearchProvider {
  constructor(private readonly options: ClaudeCliResearchProviderOptions = {}) {}

  async research(question: string, deps: ResearchDeps): Promise<ExternalResearchRecord> {
    const result = spawnSync('claude', ['-p', question], {
      encoding: 'utf8',
      timeout: CLAUDE_TIMEOUT_MS,
      maxBuffer: CLAUDE_MAX_BUFFER_BYTES,
    });
    if (result.status !== 0) {
      throw new Error(`claude -p failed (status ${result.status}): ${(result.stderr ?? '').trim()}`);
    }
    const fullSummary = (result.stdout ?? '').trim();
    const summary = fullSummary.length > SUMMARY_CHAR_CAP ? fullSummary.slice(0, SUMMARY_CHAR_CAP) : fullSummary;
    const questionHash = createHash('sha256').update(question).digest('hex').slice(0, 16);
    const sourceUrl = `claude-cli:${questionHash}`;
    const sourceKind = this.options.sourceKind ?? 'other';
    const retrievedAt = deps.clock().toISOString();

    const evidenceRecord = deps.evidence.add({
      sourceType: 'external-secondary',
      url: sourceUrl,
      sensitivity: 'public',
      facts: [`external research question: ${question}`, 'source: live claude -p (not a retrievable URL)'],
      excerpt: summary,
      citationLabel: sourceUrl,
    });

    return ExternalResearchRecordSchema.parse({
      schemaVersion: 'yellow-goal/external-research-record/v1',
      id: `ext-${evidenceRecord.id.replace(/^ev-/, '')}`,
      question,
      sourceUrl,
      sourceKind,
      retrievedAt,
      summary,
      evidenceId: evidenceRecord.id,
    });
  }
}
