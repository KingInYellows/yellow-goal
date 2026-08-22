/**
 * `ResearchProvider` — the external-research interface for the pipeline's `bounded research`
 * stage (request -> resolve target -> inspect (deterministic) -> evidence ledger -> BOUNDED
 * RESEARCH -> assessment...). Deliberately standalone from `inspection/`: inspection must stay
 * deterministic (packet-compiler.md invariant 7), while research is explicitly non-deterministic
 * and provenance-recorded. The lead or worker C wires this in at the research pipeline stage —
 * `inspectRepository` never calls into this module.
 *
 * Every answered question produces BOTH an `EvidenceRecord` (the source's bounded excerpt, so it
 * can be cited like any other evidence) and an `ExternalResearchRecord` that references it —
 * `ExternalResearchRecordSchema.evidenceId` is required, so a provider can't answer a question
 * without also creating the evidence backing it.
 */
import type { EvidenceStore } from '../evidence/store';
import type { ExternalResearchRecord } from '../contracts';

export interface ResearchDeps {
  evidence: EvidenceStore;
  clock: () => Date;
}

export interface ResearchProvider {
  research(question: string, deps: ResearchDeps): Promise<ExternalResearchRecord>;
}

/**
 * Runs `questions` through `provider` up to `maxQuestions` (05_REPOSITORY_INSPECTION_AND_RESEARCH
 * .md: "bounded question count"). Extra questions beyond the bound are simply never asked — the
 * caller gets back exactly the records for the questions that were actually run, plus the list of
 * questions that were skipped for bookkeeping.
 */
export interface BoundedResearchResult {
  records: ExternalResearchRecord[];
  skippedQuestions: string[];
}

export async function runBoundedResearch(
  provider: ResearchProvider,
  questions: readonly string[],
  deps: ResearchDeps,
  maxQuestions: number,
): Promise<BoundedResearchResult> {
  const toRun = questions.slice(0, maxQuestions);
  const skippedQuestions = questions.slice(maxQuestions);
  const records: ExternalResearchRecord[] = [];
  for (const question of toRun) {
    records.push(await provider.research(question, deps));
  }
  return { records, skippedQuestions };
}
