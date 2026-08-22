/**
 * Assembles the deterministic `RepoProfile` from all detector outputs, plus the richer internal
 * `CommandRecord[]` (contracts/command-record.ts) each embedded `RepoProfile.commands[]` entry is
 * derived from. `RepoProfile.commands` uses its OWN lighter inline shape (repo-profile.ts's
 * private `RepoProfileCommandSchema`) with a different `sideEffectClass` enum than `CommandRecord`
 * — `REPO_PROFILE_SIDE_EFFECT_MAP` below is the one place that conversion happens (facts only, no
 * judgments — see this module's callers for where classification/severity get decided later).
 */
import { RepoProfileSchema } from '../contracts';
import type { CommandRecord, RepoProfile, ResolvedRepositoryTarget } from '../contracts';
import type { EvidenceStore } from '../evidence/store';
import type { GhClient } from '../providers/gh-client';
import { detectCommands } from './detectors/commands';
import type { CiWorkflowsDeps } from './detectors/ci-workflows';
import { detectCiWorkflows } from './detectors/ci-workflows';
import { detectDeploymentMaterial } from './detectors/deployment';
import type { GithubMetadataDeps } from './detectors/github-metadata';
import { detectGithubMetadata } from './detectors/github-metadata';
import { detectInstructionFiles } from './detectors/instruction-files';
import { detectManifests } from './detectors/manifests';
import { detectProtectedPaths } from './detectors/protected-paths';
import { detectTestsSurface } from './detectors/tests-surface';
import { compileProtectedPathPolicy, loadProtectedPathPolicy, type CompiledProtectedPathPolicy } from './policy';

const REPO_PROFILE_SIDE_EFFECT_MAP: Record<
  CommandRecord['sideEffectClass'],
  'none' | 'workspace-only' | 'repository-write' | 'external-mutation' | 'unknown'
> = {
  'read-only': 'none',
  build: 'workspace-only',
  test: 'workspace-only',
  mutating: 'repository-write',
  unknown: 'unknown',
};

export interface BuildProfileDeps {
  ghClient?: GhClient;
  ghRepository?: string;
}

export interface BuildProfileResult {
  profile: RepoProfile;
  commandRecords: CommandRecord[];
}

export async function buildRepoProfile(
  resolvedTarget: ResolvedRepositoryTarget,
  localDir: string | null,
  requestedRef: string | undefined,
  evidence: EvidenceStore,
  deps: BuildProfileDeps,
): Promise<BuildProfileResult> {
  const repositoryKindsSet = new Set<string>();
  const evidenceRefs = new Set<string>();
  let instructionFiles: string[] = [];
  let manifests: Record<string, unknown>[] = [];
  let commandRecords: CommandRecord[] = [];
  let protectedPaths: string[] = [];
  let policy: CompiledProtectedPathPolicy | undefined;

  if (localDir) {
    policy = compileProtectedPathPolicy(await loadProtectedPathPolicy());

    const instructionResult = await detectInstructionFiles(localDir, evidence, policy);
    instructionFiles = instructionResult.paths;
    instructionResult.evidenceRefs.forEach((r) => evidenceRefs.add(r));

    const manifestsResult = await detectManifests(localDir, evidence, policy);
    manifests = manifestsResult.manifests as unknown as Record<string, unknown>[];
    manifestsResult.repositoryKinds.forEach((k) => repositoryKindsSet.add(k));
    manifestsResult.evidenceRefs.forEach((r) => evidenceRefs.add(r));

    commandRecords = await detectCommands(localDir, manifestsResult.manifests, evidence, policy);
    commandRecords.forEach((c) => c.evidenceRefs.forEach((r) => evidenceRefs.add(r)));

    const protectedResult = detectProtectedPaths(localDir, policy, evidence);
    protectedPaths = protectedResult.paths;
    protectedResult.evidenceRefs.forEach((r) => evidenceRefs.add(r));

    const testsResult = detectTestsSurface(localDir, evidence);
    testsResult.evidenceRefs.forEach((r) => evidenceRefs.add(r));

    const deploymentResult = detectDeploymentMaterial(localDir, evidence);
    deploymentResult.evidenceRefs.forEach((r) => evidenceRefs.add(r));
  }

  const ciDeps: CiWorkflowsDeps = { ghClient: deps.ghClient, ghRepository: deps.ghRepository, policy };
  const ciResult = await detectCiWorkflows(localDir, evidence, ciDeps);
  ciResult.evidenceRefs.forEach((r) => evidenceRefs.add(r));

  const ghDeps: GithubMetadataDeps = { ghClient: deps.ghClient, ghRepository: deps.ghRepository };
  const ghMetadata = await detectGithubMetadata(evidence, ghDeps);
  ghMetadata.evidenceRefs.forEach((r) => evidenceRefs.add(r));

  const repoProfileCommands = commandRecords.map((c) => ({
    id: c.id,
    argv: c.argv,
    cwd: c.workingDir,
    sourceEvidenceRef: c.evidenceRefs[0] ?? '',
    confidence: c.confidence,
    sideEffectClass: REPO_PROFILE_SIDE_EFFECT_MAP[c.sideEffectClass],
  }));

  const profile = RepoProfileSchema.parse({
    schemaVersion: 'yellow-goal/repo-profile/v1',
    target: {
      repository: resolvedTarget.identity,
      defaultBranch: resolvedTarget.defaultBranch ?? null,
      ...(requestedRef !== undefined ? { requestedRef } : {}),
      resolvedRef: resolvedTarget.resolvedRef,
      headSha: resolvedTarget.sha,
      inspectedAt: resolvedTarget.inspectionTimestamp,
    },
    repositoryKinds: [...repositoryKindsSet].sort(),
    instructionFiles,
    manifests,
    commands: repoProfileCommands,
    openPullRequests: ghMetadata.openPullRequests,
    issues: ghMetadata.issues,
    ciWorkflows: ciResult.ciWorkflows,
    releaseSignals: ghMetadata.releaseSignals,
    protectedPaths,
    evidenceRefs: [...evidenceRefs].sort(),
  }) as RepoProfile;

  return { profile, commandRecords };
}
