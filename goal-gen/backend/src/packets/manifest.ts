/**
 * Builds a `PacketManifest` (07_PACKET_CONTRACT.md "Manifest requirements", completed per
 * `schemas/README.md`'s documented correction). Pure — takes already-rendered file hashes and
 * already-resolved contract objects; does no I/O itself.
 */
import {
  EvidenceRecordSchemaVersion,
  FindingSchemaVersion,
  GoalResolutionSchemaVersion,
  MilestoneSpecSchemaVersion,
  OrchestrationSpecSchemaVersion,
  PacketManifestSchemaVersion,
  RepoProfileSchemaVersion,
  RepositoryAssessmentSchemaVersion,
  RepositoryGoalRequestSchemaVersion,
  type GoalResolution,
  type MilestoneSpec,
  type OrchestrationProfile,
  type OrchestrationSpec,
  type PacketManifest,
  type RepositoryAssessment,
  type RepositoryGoalRequest,
} from '../contracts';
import type { ChecksumEntry } from './checksums';

/** Manifest field paths that carry timestamps — the ONLY fields a determinism test may normalize
 *  before comparing two compiles (`07_PACKET_CONTRACT.md` "Deterministic compilation"). Kept as
 *  one explicit list here so `PacketManifest.timestampFields` and the determinism test can never
 *  silently drift apart. */
export const PACKET_TIMESTAMP_FIELDS: readonly string[] = [
  'MANIFEST.json#inspectionStartedAt',
  'MANIFEST.json#inspectionCompletedAt',
  'evidence/repository-profile.json#target.inspectedAt',
  'evidence/evidence.jsonl#*.retrievedAt',
  'evidence/research-sources.json#*.retrievedAt',
  'research/external-research.jsonl#*.retrievedAt',
];

export interface BuildManifestInput {
  packetId: string;
  engineVersion: string;
  pack: { id: string; version: string };
  request: RepositoryGoalRequest;
  target: { repository: string; requestedRef?: string; resolvedRef?: string; headSha: string };
  inspectionStartedAt: string;
  inspectionCompletedAt: string;
  assessment: RepositoryAssessment;
  goalResolution: GoalResolution;
  milestone: MilestoneSpec;
  orchestration: OrchestrationSpec;
  orchestrationProfile: OrchestrationProfile;
  analysisProviderId: string;
  tools: Record<string, unknown>;
  files: readonly ChecksumEntry[];
  filesBytes: Readonly<Record<string, number>>;
  predecessorPacketId?: string;
  validation: { status: 'passed' | 'failed'; errors: string[] };
}

export function buildPacketManifest(input: BuildManifestInput): PacketManifest {
  const analysisModels: Record<string, string> = {
    assessment: input.analysisProviderId,
    goalResolution: input.analysisProviderId,
    milestone: input.analysisProviderId,
  };

  const resolvedOrchestrationModels: Record<string, string> = Object.fromEntries(
    Object.entries(input.orchestrationProfile.roleBindings).map(([role, binding]) => [role, binding.modelId]),
  );

  const humanGates = [...new Set([...input.milestone.humanGates, ...input.orchestration.humanApproval])];

  const manifest: PacketManifest = {
    schemaVersion: PacketManifestSchemaVersion,
    packetId: input.packetId,
    engineVersion: input.engineVersion,
    pack: input.pack,
    requestId: input.request.requestId,
    target: input.target,
    inspectionStartedAt: input.inspectionStartedAt,
    inspectionCompletedAt: input.inspectionCompletedAt,
    analysisModels,
    resolvedOrchestrationModels,
    tools: input.tools,
    schemas: {
      request: RepositoryGoalRequestSchemaVersion,
      repoProfile: RepoProfileSchemaVersion,
      evidence: EvidenceRecordSchemaVersion,
      finding: FindingSchemaVersion,
      assessment: RepositoryAssessmentSchemaVersion,
      goalResolution: GoalResolutionSchemaVersion,
      milestone: MilestoneSpecSchemaVersion,
      orchestration: OrchestrationSpecSchemaVersion,
      manifest: PacketManifestSchemaVersion,
    },
    files: input.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: input.filesBytes[f.path] })),
    humanGates,
    evidenceGaps: input.assessment.evidenceGaps,
    timestampFields: [...PACKET_TIMESTAMP_FIELDS],
    targetMutationOccurred: false,
    validation: input.validation,
  };

  return input.predecessorPacketId ? { ...manifest, predecessorPacketId: input.predecessorPacketId } : manifest;
}
