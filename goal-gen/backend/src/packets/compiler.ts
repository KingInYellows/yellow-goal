/**
 * `compilePacket` — assembles `repository-goal-packet@1` from approved structured inputs (request
 * + analysis bundle) and a pack, deterministically (`07_PACKET_CONTRACT.md` "Deterministic
 * compilation"). No target-repository access happens here — everything comes from already-
 * validated contract objects passed in via `assessmentPath`'s analysis bundle
 * (`backend/src/analysis/bundle.ts`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompileArgs, CompileResult } from '../cli/types';
import { FindingSchema, type Finding, type RepositoryGoalRequest } from '../contracts';
import { resolveDefaultOrchestrationProfile } from '../analysis/orchestration-defaults';
import { readAnalysisBundle, type AnalysisBundleData } from '../analysis/bundle';
import { parseCanonicalRequest } from '../intake';
import { assertOutputDirNotInsideTarget } from '../paths/output-containment';
import { sameRepositoryIdentity } from '../paths/repository-identity';
import { canonicalJson, canonicalJsonLines } from '../packs/canonical-json';
import { loadPack, type LoadedPack } from '../packs/pack-loader';
import { renderTemplateStrict } from '../packs/template-renderer';
import { writeZipArchive, type ZipSourceFile } from './archive';
import { renderChecksumsFile, sha256Hex, type ChecksumEntry } from './checksums';
import * as fragments from './fragment-renderers';
import { buildPacketManifest } from './manifest';
import { validatePacketPreZip, type RenderedFile } from './packet-validator';

export const ENGINE_VERSION = '0.1.0';

export class PacketCompilationError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PacketCompilationError';
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function packsRootFromThisModule(): string {
  // backend/src/packets/compiler.ts -> up to goal-gen/, then into packs/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'packs');
}

/** `pack` is an identifier like `repository-goal-packet@1` (id@majorVersion), not a filesystem
 *  path — resolves it against this repository's single pack root (`goal-gen/packs/`). */
function resolvePackDir(packIdentifier: string, packsRoot: string): string {
  const match = /^([a-z0-9-]+)@(\d+)$/.exec(packIdentifier);
  if (!match) throw new PacketCompilationError(`malformed pack identifier: "${packIdentifier}" (expected "<id>@<major>")`);
  const [, id, major] = match;
  return path.join(packsRoot, id!, `v${major}`);
}

async function readRequest(requestPath: string): Promise<RepositoryGoalRequest> {
  const raw = await readFile(requestPath, 'utf8');
  return parseCanonicalRequest(JSON.parse(raw));
}

/** `RepositoryAssessment.findings` is loosely typed (`z.record(unknown)[]`); each element must
 *  individually satisfy `FindingSchema` before it can be rendered — see the pack README's note
 *  on `{{FINDINGS_TABLE_ROWS}}`. */
function assertRequestMatchesBundle(request: RepositoryGoalRequest, bundle: AnalysisBundleData): void {
  const mismatches: string[] = [];
  if (request.intent.goal !== bundle.goalResolution.requestedGoal) {
    mismatches.push(
      `requested goal mismatch: request=${JSON.stringify(request.intent.goal)} bundle=${JSON.stringify(bundle.goalResolution.requestedGoal)}`,
    );
  }
  if (!sameRepositoryIdentity(request.target.repository, bundle.repoProfile.target.repository)) {
    mismatches.push(
      `repository mismatch: request=${JSON.stringify(request.target.repository)} bundle=${JSON.stringify(bundle.repoProfile.target.repository)}`,
    );
  }
  const requestRef = request.target.ref;
  const profileRef = bundle.repoProfile.target.requestedRef;
  if (requestRef && requestRef !== 'AUTO' && profileRef && profileRef !== 'AUTO' && requestRef !== profileRef) {
    mismatches.push(`ref mismatch: request=${JSON.stringify(requestRef)} bundle=${JSON.stringify(profileRef)}`);
  }
  if (mismatches.length > 0) {
    throw new PacketCompilationError(`request and assessment bundle do not describe the same run: ${mismatches.join('; ')}`);
  }
}

function validateFindings(rawFindings: readonly Record<string, unknown>[]): Finding[] {
  return rawFindings.map((raw, i) => {
    const result = FindingSchema.safeParse(raw);
    if (!result.success) throw new PacketCompilationError(`assessment.findings[${i}] failed Finding validation: ${result.error.message}`);
    return result.data;
  });
}

function buildScalarContext(input: {
  bundle: AnalysisBundleData;
  packetId: string;
  findingsSummary: fragments.FindingsSummary;
}): Record<string, string> {
  const { bundle, packetId, findingsSummary } = input;
  const { assessment, goalResolution, milestone, orchestration, repoProfile } = bundle;

  return {
    'repoProfile.target.repository': repoProfile.target.repository,
    'repoProfile.target.defaultBranch': repoProfile.target.defaultBranch ?? '(unknown)',
    'repoProfile.target.requestedRef': repoProfile.target.requestedRef ?? 'AUTO',
    'repoProfile.target.resolvedRef': repoProfile.target.resolvedRef,
    'repoProfile.target.headSha': repoProfile.target.headSha,
    'repoProfile.target.inspectedAt': repoProfile.target.inspectedAt,
    'manifest.packetId': packetId,
    'assessment.executiveJudgment.usefulness': assessment.executiveJudgment.usefulness,
    'assessment.executiveJudgment.functionality': assessment.executiveJudgment.functionality,
    'assessment.executiveJudgment.cohesion': assessment.executiveJudgment.cohesion,
    'assessment.executiveJudgment.milestoneReadiness': assessment.executiveJudgment.milestoneReadiness,
    'assessment.biggestConstraint': assessment.biggestConstraint,
    'findingsSummary.blockingCount': String(findingsSummary.blockingCount),
    'findingsSummary.highCount': String(findingsSummary.highCount),
    'findingsSummary.mediumCount': String(findingsSummary.mediumCount),
    'findingsSummary.lowCount': String(findingsSummary.lowCount),
    'goalResolution.requestedGoal': goalResolution.requestedGoal,
    'goalResolution.selectedGoal': goalResolution.selectedGoal,
    'goalResolution.selectedMilestoneId': goalResolution.selectedMilestoneId,
    'goalResolution.relationship': goalResolution.relationship,
    'goalResolution.rationale': goalResolution.rationale,
    'goalResolution.preservedIntent': goalResolution.preservedIntent ?? '',
    'milestone.goal': milestone.goal,
    'milestone.whyNow': milestone.whyNow,
    'milestone.terminalCondition': milestone.terminalCondition,
    'orchestration.profileId': orchestration.profileId,
    'orchestration.provider': orchestration.provider,
    'orchestration.lead.role': orchestration.lead.role,
    'orchestration.lead.modelRole': orchestration.lead.modelRole,
    'orchestration.lead.modelId': orchestration.lead.modelId,
    'orchestration.maxConcurrentWorkers': String(orchestration.maxConcurrentWorkers),
    'orchestration.exclusiveFileOwnership': String(orchestration.exclusiveFileOwnership ?? false),
    'orchestration.requirePlanApproval': String(orchestration.requirePlanApproval ?? false),
    'orchestration.validationOwnership': orchestration.validationOwnership,
    'orchestration.teamMode': orchestration.teamMode,
    'orchestration.fallbackMode': orchestration.fallbackMode,
  };
}

function buildFragmentContext(bundle: AnalysisBundleData, findings: readonly Finding[]): Record<string, string> {
  const { assessment, goalResolution, milestone, orchestration, repoProfile, evidence } = bundle;
  return {
    EVIDENCE_GAPS_LIST: fragments.renderEvidenceGapsList(assessment.evidenceGaps),
    RATINGS_TABLE_ROWS: fragments.renderRatingsTableRows(assessment.ratings),
    REPO_KINDS_LIST: fragments.renderRepoKindsList(repoProfile.repositoryKinds),
    REPO_INSTRUCTION_FILES_LIST: fragments.renderInstructionFilesList(repoProfile.instructionFiles),
    REPO_COMMANDS_TABLE_ROWS: fragments.renderCommandsTableRows(repoProfile.commands),
    REPO_OPEN_PULL_REQUESTS_LIST: fragments.renderOpenPullRequestsList(repoProfile.openPullRequests),
    REPO_CI_WORKFLOWS_LIST: fragments.renderCiWorkflowsList(repoProfile.ciWorkflows),
    REPO_RELEASE_SIGNALS_LIST: fragments.renderReleaseSignalsList(repoProfile.releaseSignals),
    REPO_PROTECTED_PATHS_LIST: fragments.renderProtectedPathsList(repoProfile.protectedPaths),
    REPO_EXCERPTS_FENCED_BLOCK: fragments.renderRepoExcerptsFencedBlock(evidence),
    FINDINGS_TABLE_ROWS: fragments.renderFindingsTableRows(findings),
    FINDINGS_DETAIL_SECTIONS: fragments.renderFindingsDetailSections(findings),
    FINDING_LEDGER_ROWS: fragments.renderFindingLedgerRows(findings),
    GOAL_RESOLUTION_BLOCKED_BY_LIST: fragments.renderGoalResolutionBlockedByList(goalResolution.blockedBy),
    GOAL_RESOLUTION_EVIDENCE_LIST: fragments.renderGoalResolutionEvidenceList(goalResolution.evidenceRefs),
    MILESTONE_SCOPE_LIST: fragments.renderMilestoneScopeList(milestone.scope),
    MILESTONE_NON_GOALS_LIST: fragments.renderMilestoneNonGoalsList(milestone.nonGoals),
    MILESTONE_ACCEPTANCE_CRITERIA_LIST: fragments.renderMilestoneAcceptanceCriteriaList(milestone.acceptanceCriteria),
    MILESTONE_RISKS_LIST: fragments.renderMilestoneRisksList(milestone.risks),
    MILESTONE_HUMAN_GATES_LIST: fragments.renderMilestoneHumanGatesList(milestone.humanGates),
    ORCHESTRATION_LEAD_RESPONSIBILITIES_LIST: fragments.renderOrchestrationLeadResponsibilitiesList(orchestration.lead.responsibilities),
    ORCHESTRATION_MUTATION_BOUNDARIES_LIST: fragments.renderOrchestrationMutationBoundariesList(orchestration.mutationBoundaries),
    ORCHESTRATION_WAVES_SECTION: fragments.renderOrchestrationWavesSection(orchestration.waves),
    ORCH_INVESTIGATION_TEAMMATES_LIST: fragments.renderInvestigationTeammatesList(orchestration.waves),
    ORCH_IMPLEMENTATION_TEAMMATES_LIST: fragments.renderImplementationTeammatesList(orchestration.waves),
    ORCH_VERIFICATION_TEAMMATES_LIST: fragments.renderVerificationTeammatesList(orchestration.waves),
    ORCHESTRATION_STOP_CONDITIONS_LIST: fragments.renderOrchestrationStopConditionsList(orchestration.stopConditions),
    ORCHESTRATION_HUMAN_APPROVAL_LIST: fragments.renderOrchestrationHumanApprovalList(orchestration.humanApproval),
    VALIDATION_ACCEPTANCE_CRITERIA_ROWS: fragments.renderValidationAcceptanceCriteriaRows(milestone.acceptanceCriteria),
    VALIDATION_GATES_LIST: fragments.renderValidationGatesList(),
    VALIDATION_MATRIX_ROWS: fragments.renderValidationMatrixRows(milestone.acceptanceCriteria),
  };
}

const TEMPLATE_LOGICAL_PATHS: readonly { logical: string; output: string }[] = [
  { logical: 'templates/00_START_HERE.md', output: '00_START_HERE.md' },
  { logical: 'templates/01_EXECUTIVE_JUDGMENT.md', output: '01_EXECUTIVE_JUDGMENT.md' },
  { logical: 'templates/02_REPOSITORY_STATE.md', output: '02_REPOSITORY_STATE.md' },
  { logical: 'templates/03_FINDINGS.md', output: '03_FINDINGS.md' },
  { logical: 'templates/04_GOAL_RESOLUTION.md', output: '04_GOAL_RESOLUTION.md' },
  { logical: 'templates/05_MILESTONE.md', output: '05_MILESTONE.md' },
  { logical: 'templates/06_ORCHESTRATION.md', output: '06_ORCHESTRATION.md' },
  { logical: 'templates/07_VALIDATION_PLAN.md', output: '07_VALIDATION_PLAN.md' },
  { logical: 'templates/08_HUMAN_GATES.md', output: '08_HUMAN_GATES.md' },
  { logical: 'templates/FINDING_LEDGER.md', output: 'templates/FINDING_LEDGER.md' },
  { logical: 'templates/VALIDATION_MATRIX.md', output: 'templates/VALIDATION_MATRIX.md' },
  { logical: 'templates/FINAL_HANDOFF.md', output: 'templates/FINAL_HANDOFF.md' },
  { logical: 'prompts/MASTER_IMPLEMENTATION_PROMPT.md', output: 'prompts/MASTER_IMPLEMENTATION_PROMPT.md' },
  { logical: 'prompts/PERSISTENT_GOAL.txt', output: 'prompts/PERSISTENT_GOAL.txt' },
  { logical: 'prompts/REVIEW_PROMPT.md', output: 'prompts/REVIEW_PROMPT.md' },
];

const SCRIPT_ASSET_PATHS: readonly string[] = ['scripts/preflight.sh', 'scripts/preflight.ps1', 'scripts/launch.sh', 'scripts/launch.ps1'];

export interface CompilePacketOptions {
  clock?: () => Date;
  /** Overrides pack resolution for tests (bypasses the `packs/` root lookup). */
  packDirOverride?: string;
}

export async function compilePacketImpl(args: CompileArgs, options: CompilePacketOptions = {}): Promise<CompileResult> {
  const clock = options.clock ?? (() => new Date());
  const now = clock();

  const request = await readRequest(args.requestPath);
  const bundle = await readAnalysisBundle(args.assessmentPath);
  assertRequestMatchesBundle(request, bundle);
  await assertOutputDirNotInsideTarget(args.outputDir, request.target.repository);
  await assertOutputDirNotInsideTarget(args.outputDir, bundle.repoProfile.target.repository);
  const findings = validateFindings(bundle.assessment.findings);
  const findingsSummary = fragments.summarizeFindings(findings);

  const orchestrationProfile = resolveDefaultOrchestrationProfile(clock);

  const packDir = options.packDirOverride ?? resolvePackDir(args.pack, packsRootFromThisModule());
  const pack = await loadPack(packDir, ENGINE_VERSION);

  const packetId = `${slugify(bundle.repoProfile.target.repository)}-${slugify(bundle.goalResolution.selectedMilestoneId)}-${isoDateOnly(now)}`;

  const scalarCtx = buildScalarContext({ bundle, packetId, findingsSummary });
  const fragmentCtx = buildFragmentContext(bundle, findings);
  const renderCtx = { ...scalarCtx, ...fragmentCtx };

  const renderedFiles: RenderedFile[] = [];

  for (const { logical, output } of TEMPLATE_LOGICAL_PATHS) {
    const templateText = await pack.readTemplate(logical);
    const rendered = renderTemplateStrict(logical, templateText, renderCtx);
    renderedFiles.push({ entryPath: output, content: rendered });
  }

  for (const scriptPath of SCRIPT_ASSET_PATHS) {
    const content = await pack.readAsset(scriptPath);
    renderedFiles.push({ entryPath: scriptPath, content });
  }

  // Canonical JSON contracts.
  renderedFiles.push({ entryPath: 'contracts/request.json', content: canonicalJson(request) });
  renderedFiles.push({ entryPath: 'contracts/repository-assessment.json', content: canonicalJson(bundle.assessment) });
  renderedFiles.push({ entryPath: 'contracts/goal-resolution.json', content: canonicalJson(bundle.goalResolution) });
  renderedFiles.push({ entryPath: 'contracts/milestone.json', content: canonicalJson(bundle.milestone) });
  renderedFiles.push({ entryPath: 'contracts/orchestration.json', content: canonicalJson(bundle.orchestration) });

  // Evidence / research (pass-through from the analysis bundle, re-rendered canonically).
  renderedFiles.push({ entryPath: 'evidence/evidence.jsonl', content: canonicalJsonLines(bundle.evidence) });
  renderedFiles.push({ entryPath: 'evidence/repository-profile.json', content: canonicalJson(bundle.repoProfile) });
  renderedFiles.push({ entryPath: 'evidence/research-sources.json', content: canonicalJson(bundle.researchSources) });
  renderedFiles.push({ entryPath: 'research/external-research.jsonl', content: canonicalJsonLines(bundle.externalResearch) });

  // Pre-ZIP validation — fail closed, write nothing if it fails.
  const preZipValidation = validatePacketPreZip({
    files: renderedFiles,
    assessment: bundle.assessment,
    findings,
    milestone: bundle.milestone,
    evidence: bundle.evidence,
    goalResolutionEvidenceRefs: bundle.goalResolution.evidenceRefs,
  });
  if (preZipValidation.overall !== 'passed') {
    throw new PacketCompilationError(`packet failed pre-ZIP validation for pack "${args.pack}"`, preZipValidation);
  }

  // Checksums + manifest. MANIFEST.json cannot list its own hash, so it is built from every
  // OTHER file's checksum first, then added to the file set afterward.
  const checksumEntries: ChecksumEntry[] = renderedFiles.map((f) => ({ path: f.entryPath, sha256: sha256Hex(f.content) }));
  const filesBytes: Record<string, number> = Object.fromEntries(renderedFiles.map((f) => [f.entryPath, Buffer.byteLength(f.content, 'utf8')]));

  const manifest = buildPacketManifest({
    packetId,
    engineVersion: ENGINE_VERSION,
    pack: { id: pack.pack.id, version: pack.pack.version },
    request,
    target: {
      repository: bundle.repoProfile.target.repository,
      requestedRef: bundle.repoProfile.target.requestedRef,
      resolvedRef: bundle.repoProfile.target.resolvedRef,
      headSha: bundle.repoProfile.target.headSha,
    },
    inspectionStartedAt: bundle.repoProfile.target.inspectedAt,
    inspectionCompletedAt: bundle.repoProfile.target.inspectedAt,
    assessment: bundle.assessment,
    goalResolution: bundle.goalResolution,
    milestone: bundle.milestone,
    orchestration: bundle.orchestration,
    orchestrationProfile,
    analysisProviderId: bundle.providerId,
    tools: {},
    files: checksumEntries,
    filesBytes,
    validation: { status: 'passed', errors: [] },
  });

  const manifestContent = canonicalJson(manifest);
  renderedFiles.push({ entryPath: 'MANIFEST.json', content: manifestContent });
  checksumEntries.push({ path: 'MANIFEST.json', sha256: sha256Hex(manifestContent) });

  const checksumsContent = renderChecksumsFile(checksumEntries);
  renderedFiles.push({ entryPath: 'CHECKSUMS.sha256', content: checksumsContent });

  // Verify the assembled file set exactly matches the pack's required-output list.
  const actualPaths = new Set(renderedFiles.map((f) => f.entryPath));
  const missing = pack.outputLayout.paths.filter((p) => !actualPaths.has(p));
  const extra = [...actualPaths].filter((p) => !pack.outputLayout.paths.includes(p));
  if (missing.length > 0 || extra.length > 0) {
    throw new PacketCompilationError(
      `compiled packet file set does not match pack output layout (missing: ${missing.join(', ')}; extra: ${extra.join(', ')})`,
    );
  }

  // Write the uncompressed packet tree.
  const packetDir = path.join(args.outputDir, packetId);
  for (const file of renderedFiles) {
    const fullPath = path.join(packetDir, file.entryPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, file.content, 'utf8');
  }

  // Write the ZIP deliverable, every entry stamped with the same clock reading.
  const zipPath = path.join(args.outputDir, `${packetId}.zip`);
  const zipFiles: ZipSourceFile[] = renderedFiles.map((f) => ({ entryPath: f.entryPath, content: Buffer.from(f.content, 'utf8') }));
  await writeZipArchive(zipPath, zipFiles, now);

  return {
    packetPath: zipPath,
    manifestPath: path.join(packetDir, 'MANIFEST.json'),
    packetDirPath: packetDir,
    packetId,
    validation: preZipValidation,
  };
}
