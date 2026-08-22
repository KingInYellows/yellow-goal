/**
 * File-layout convention for the handoff directories between `inspect` → `analyze` → `compile`.
 *
 * Neither `AnalyzeArgs` nor `CompileArgs` (backend/src/cli/types.ts) carry a path for every
 * input each stage needs — `analyze` receives only `repoProfilePath` (not an evidence/research
 * path), and `compile` receives only `assessmentPath` (not `repoProfilePath` at all). This module
 * is the ONE place that convention lives, so it is easy to find and adjust at integration time if
 * worker B's `inspectRepository` output does not actually match it:
 *
 *  - `inspect`'s output directory (the parent of `InspectResult.repoProfilePath`) is expected to
 *    also contain, as OPTIONAL siblings under the packet's own relative layout: `evidence/evidence.jsonl`,
 *    `evidence/research-sources.json`, `research/external-research.jsonl`. Missing siblings degrade
 *    to empty arrays (an evidence gap, not a hard failure) rather than throwing, so this module
 *    works even if worker B's actual layout differs.
 *  - `analyze`'s output directory (`AnalyzeArgs.outputDir`) mirrors that same relative layout PLUS
 *    the three required analysis outputs (`assessment.json`, `goal-resolution.json`,
 *    `milestone.json`) and a deterministically-resolved `orchestration.json`, all at its root.
 *  - `compile` derives its input bundle directory as `path.dirname(assessmentPath)` and reads the
 *    same fixed sibling names. `provider.json` is required (fail-closed).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import {
  EvidenceRecordSchema,
  ExternalResearchRecordSchema,
  GoalResolutionSchema,
  MilestoneSpecSchema,
  OrchestrationSpecSchema,
  RepoProfileSchema,
  RepositoryAssessmentSchema,
  type EvidenceRecord,
  type ExternalResearchRecord,
  type GoalResolution,
  type MilestoneSpec,
  type OrchestrationSpec,
  type RepoProfile,
  type RepositoryAssessment,
} from '../contracts';
import { canonicalJson, canonicalJsonLines } from '../packs/canonical-json';

export const BUNDLE_FILES = {
  assessment: 'assessment.json',
  goalResolution: 'goal-resolution.json',
  milestone: 'milestone.json',
  orchestration: 'orchestration.json',
  /** Not a contract file — carries only `{ providerId }` so `compilePacket` (which receives just
   *  `assessmentPath`, not the `AnalyzeResult` object) can attribute `PacketManifest.analysisModels`
   *  correctly without re-running analysis. */
  provider: 'provider.json',
  repositoryProfile: 'repository-profile.json',
  evidence: path.join('evidence', 'evidence.jsonl'),
  researchSources: path.join('evidence', 'research-sources.json'),
  externalResearch: path.join('research', 'external-research.jsonl'),
} as const;

export class BundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleValidationError';
  }
}

async function readRequiredJson<T>(filePath: string, schema: z.ZodType<T>, label: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8').catch((e: NodeJS.ErrnoException) => {
    throw new BundleValidationError(`${label}: cannot read ${filePath}: ${e.message}`);
  });
  const parsed: unknown = JSON.parse(raw);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new BundleValidationError(`${label}: ${filePath} failed validation: ${result.error.message}`);
  }
  return result.data;
}

async function readOptionalJsonArray<T>(filePath: string, schema: z.ZodType<T>, label: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new BundleValidationError(`${label}: ${filePath} is not a JSON array`);
  return parsed.map((item, i) => {
    const result = schema.safeParse(item);
    if (!result.success) {
      throw new BundleValidationError(`${label}: ${filePath}[${i}] failed validation: ${result.error.message}`);
    }
    return result.data;
  });
}

async function readOptionalJsonl<T>(filePath: string, schema: z.ZodType<T>, label: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new BundleValidationError(`${label}: ${filePath}:${i + 1} is not valid JSON: ${(e as Error).message}`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new BundleValidationError(`${label}: ${filePath}:${i + 1} failed validation: ${result.error.message}`);
    }
    return result.data;
  });
}

export interface InspectionSiblings {
  evidence: EvidenceRecord[];
  researchSources: EvidenceRecord[];
  externalResearch: ExternalResearchRecord[];
}

/** Reads `RepoProfile` from `repoProfilePath` (required) plus its optional evidence/research
 *  siblings (see module doc). */
export async function readRepoProfile(repoProfilePath: string): Promise<RepoProfile> {
  return readRequiredJson(repoProfilePath, RepoProfileSchema, 'repoProfilePath');
}

export async function readInspectionSiblings(repoProfilePath: string): Promise<InspectionSiblings> {
  const dir = path.dirname(repoProfilePath);
  const [evidence, researchSources, externalResearch] = await Promise.all([
    readOptionalJsonl(path.join(dir, BUNDLE_FILES.evidence), EvidenceRecordSchema, 'evidence.jsonl'),
    readOptionalJsonArray(path.join(dir, BUNDLE_FILES.researchSources), EvidenceRecordSchema, 'research-sources.json'),
    readOptionalJsonl(path.join(dir, BUNDLE_FILES.externalResearch), ExternalResearchRecordSchema, 'external-research.jsonl'),
  ]);
  return { evidence, researchSources, externalResearch };
}

export interface AnalysisBundleData {
  assessment: RepositoryAssessment;
  goalResolution: GoalResolution;
  milestone: MilestoneSpec;
  orchestration: OrchestrationSpec;
  /** Which `AnalysisProvider` produced `assessment`/`goalResolution`/`milestone` — threaded
   *  through `provider.json` so `compilePacket` (which only ever receives `assessmentPath`) can
   *  attribute `PacketManifest.analysisModels` correctly. */
  providerId: string;
  repoProfile: RepoProfile;
  evidence: EvidenceRecord[];
  researchSources: EvidenceRecord[];
  externalResearch: ExternalResearchRecord[];
}

export interface AnalysisBundlePaths {
  assessmentPath: string;
  goalResolutionPath: string;
  milestonePath: string;
  orchestrationPath: string;
  providerPath: string;
  repositoryProfilePath: string;
  evidencePath: string;
  researchSourcesPath: string;
  externalResearchPath: string;
}

/** Writes every file in {@link AnalysisBundleData} into `outputDir` using the fixed layout, all
 *  via canonical JSON/JSONL rendering (deterministic key order, `\n` endings). */
export async function writeAnalysisBundle(outputDir: string, data: AnalysisBundleData): Promise<AnalysisBundlePaths> {
  const resolve = (rel: string): string => path.join(outputDir, rel);
  const paths: AnalysisBundlePaths = {
    assessmentPath: resolve(BUNDLE_FILES.assessment),
    goalResolutionPath: resolve(BUNDLE_FILES.goalResolution),
    milestonePath: resolve(BUNDLE_FILES.milestone),
    orchestrationPath: resolve(BUNDLE_FILES.orchestration),
    providerPath: resolve(BUNDLE_FILES.provider),
    repositoryProfilePath: resolve(BUNDLE_FILES.repositoryProfile),
    evidencePath: resolve(BUNDLE_FILES.evidence),
    researchSourcesPath: resolve(BUNDLE_FILES.researchSources),
    externalResearchPath: resolve(BUNDLE_FILES.externalResearch),
  };

  await Promise.all(
    [...new Set(Object.values(paths).map((p) => path.dirname(p)))].map((dir) => mkdir(dir, { recursive: true })),
  );

  await Promise.all([
    writeFile(paths.assessmentPath, canonicalJson(data.assessment), 'utf8'),
    writeFile(paths.goalResolutionPath, canonicalJson(data.goalResolution), 'utf8'),
    writeFile(paths.milestonePath, canonicalJson(data.milestone), 'utf8'),
    writeFile(paths.orchestrationPath, canonicalJson(data.orchestration), 'utf8'),
    writeFile(paths.providerPath, canonicalJson({ providerId: data.providerId }), 'utf8'),
    writeFile(paths.repositoryProfilePath, canonicalJson(data.repoProfile), 'utf8'),
    writeFile(paths.evidencePath, canonicalJsonLines(data.evidence), 'utf8'),
    writeFile(paths.researchSourcesPath, canonicalJson(data.researchSources), 'utf8'),
    writeFile(paths.externalResearchPath, canonicalJsonLines(data.externalResearch), 'utf8'),
  ]);

  return paths;
}

/** Reads a full {@link AnalysisBundleData} back given only `assessmentPath` (`compile`'s only
 *  analysis-stage input) by deriving the bundle directory and reading the fixed sibling names.
 *  `orchestration.json`, `repository-profile.json`, and `provider.json` are required;
 *  evidence/research files are optional and default to empty arrays. */
export async function readAnalysisBundle(assessmentPath: string): Promise<AnalysisBundleData> {
  const dir = path.dirname(assessmentPath);
  const resolve = (rel: string): string => path.join(dir, rel);

  const [assessment, goalResolution, milestone, orchestration, repoProfile] = await Promise.all([
    readRequiredJson(assessmentPath, RepositoryAssessmentSchema, 'assessmentPath'),
    readRequiredJson(resolve(BUNDLE_FILES.goalResolution), GoalResolutionSchema, 'goal-resolution.json'),
    readRequiredJson(resolve(BUNDLE_FILES.milestone), MilestoneSpecSchema, 'milestone.json'),
    readRequiredJson(resolve(BUNDLE_FILES.orchestration), OrchestrationSpecSchema, 'orchestration.json'),
    readRequiredJson(resolve(BUNDLE_FILES.repositoryProfile), RepoProfileSchema, 'repository-profile.json'),
  ]);

  const [evidence, researchSources, externalResearch] = await Promise.all([
    readOptionalJsonl(resolve(BUNDLE_FILES.evidence), EvidenceRecordSchema, 'evidence.jsonl'),
    readOptionalJsonArray(resolve(BUNDLE_FILES.researchSources), EvidenceRecordSchema, 'research-sources.json'),
    readOptionalJsonl(resolve(BUNDLE_FILES.externalResearch), ExternalResearchRecordSchema, 'external-research.jsonl'),
  ]);

  const providerPath = resolve(BUNDLE_FILES.provider);
  const providerRaw = await readFile(providerPath, 'utf8').catch((e: NodeJS.ErrnoException) => {
    throw new BundleValidationError(`provider.json: cannot read ${providerPath}: ${e.message}`);
  });
  let providerParsed: unknown;
  try {
    providerParsed = JSON.parse(providerRaw);
  } catch (e) {
    throw new BundleValidationError(`provider.json: ${providerPath} is not valid JSON: ${(e as Error).message}`);
  }
  const providerId =
    providerParsed !== null &&
    typeof providerParsed === 'object' &&
    'providerId' in providerParsed &&
    typeof (providerParsed as { providerId: unknown }).providerId === 'string'
      ? (providerParsed as { providerId: string }).providerId
      : '';
  if (providerId.length === 0) {
    throw new BundleValidationError(`provider.json: ${providerPath} is missing a non-empty providerId`);
  }

  return { assessment, goalResolution, milestone, orchestration, providerId, repoProfile, evidence, researchSources, externalResearch };
}
