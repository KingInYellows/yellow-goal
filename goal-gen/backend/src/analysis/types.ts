/**
 * `AnalysisProvider` — schema-constrained assessment + goal resolution + milestone, from
 * `RepoProfile` + evidence + the original request. Model-dependent, provenance-recorded
 * (`.claude/specs/packet-compiler.md` "analysis/" row). Orchestration is deliberately NOT part
 * of this interface — it is deterministic pack policy, resolved by `orchestration-defaults.ts`,
 * not something a model judges per repository.
 */
import type {
  EvidenceRecord,
  ExternalResearchRecord,
  GoalResolution,
  MilestoneSpec,
  RepoProfile,
  RepositoryAssessment,
  RepositoryGoalRequest,
} from '../contracts';

export interface AnalysisProviderInput {
  request: RepositoryGoalRequest;
  repoProfile: RepoProfile;
  /** Append-only evidence collected during inspection. May be empty (an evidence gap, not an
   *  error) if the inspection stage recorded none. */
  evidence: EvidenceRecord[];
  /** Bounded external research collected before analysis, if any. */
  externalResearch: ExternalResearchRecord[];
}

export interface AnalysisProviderOutput {
  assessment: RepositoryAssessment;
  goalResolution: GoalResolution;
  milestone: MilestoneSpec;
}

export interface AnalysisProvider {
  /** Identifies which model/mode produced the output, for `PacketManifest.analysisModels`
   *  (e.g. `claude-sonnet-5` for the live provider, `recorded-fixture` for tests). */
  readonly providerId: string;
  analyze(input: AnalysisProviderInput): Promise<AnalysisProviderOutput>;
}

/** Thrown by any `AnalysisProvider` implementation when its output fails to validate against the
 *  RepositoryAssessment/GoalResolution/MilestoneSpec contracts, or (for the live provider) when
 *  its raw response cannot be repaired into valid JSON at all. */
export class AnalysisProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisProviderError';
  }
}
