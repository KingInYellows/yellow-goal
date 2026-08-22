/**
 * `analysis/` barrel. `backend/src/cli/commands.ts` dynamically imports this module and calls the
 * exported `analyzeRepository` — see that file's `loadOptionalModule('../analysis/index')` /
 * `NotWiredError('analyze', ...)` usage. `analyzeRepository` here is the CLI-wired default (uses
 * the live `ClaudeCliAnalysisProvider`); tests use `createAnalyzeRepository` with
 * `RecordedAnalysisProvider` instead, so the live provider's `.analyze()` is never actually
 * invoked by the test suite.
 */
import { readFile } from 'node:fs/promises';
import type { AnalyzeArgs, AnalyzeFn, AnalyzeResult } from '../cli/types';
import type { RepositoryGoalRequest } from '../contracts';
import { parseCanonicalRequest } from '../intake';
import { readInspectionSiblings, readRepoProfile, writeAnalysisBundle } from './bundle';
import { ClaudeCliAnalysisProvider, type ClaudeInvocation, type ClaudeInvocationResult } from './claude-cli-provider';
import { resolveDefaultOrchestrationProfile, resolveDefaultOrchestrationSpec } from './orchestration-defaults';
import { assertValidAnalysisOutput } from './output-validation';
import type { AnalysisProvider } from './types';

export * from './types';
export { RecordedAnalysisProvider } from './recorded-provider';
export { ClaudeCliAnalysisProvider, type ClaudeInvocation, type ClaudeInvocationResult } from './claude-cli-provider';
export {
  DEFAULT_ORCHESTRATION_PROFILE_ID,
  resolveDefaultOrchestrationProfile,
  resolveDefaultOrchestrationSpec,
} from './orchestration-defaults';
export {
  assertValidAnalysisOutput,
  validateFindingsAgainstSchema,
  type FindingsValidationResult,
} from './output-validation';
export { renderSchemaSkeleton, requiredKeysOf } from './prompt-schema-skeleton';
export {
  BUNDLE_FILES,
  BundleValidationError,
  readAnalysisBundle,
  readInspectionSiblings,
  readRepoProfile,
  writeAnalysisBundle,
  type AnalysisBundleData,
  type AnalysisBundlePaths,
  type InspectionSiblings,
} from './bundle';

async function readRequest(requestPath: string): Promise<RepositoryGoalRequest> {
  const raw = await readFile(requestPath, 'utf8');
  return parseCanonicalRequest(JSON.parse(raw));
}

/**
 * Builds an `AnalyzeFn` bound to a specific `AnalysisProvider` and clock. `clock` is injectable
 * (never inline `Date.now()`) so `orchestration.json`'s `resolvedAt` can be pinned in
 * determinism tests.
 */
export function createAnalyzeRepository(
  provider: AnalysisProvider,
  clock: () => Date = () => new Date(),
): AnalyzeFn {
  return async (args: AnalyzeArgs): Promise<AnalyzeResult> => {
    const request = await readRequest(args.requestPath);
    const repoProfile = await readRepoProfile(args.repoProfilePath);
    const { evidence, researchSources, externalResearch } = await readInspectionSiblings(args.repoProfilePath);

    const providerOutput = await provider.analyze({
      request,
      repoProfile,
      evidence,
      externalResearch,
    });

    // Deep validation gate, BEFORE anything is written to outputDir. Catches what a provider's
    // own top-level schema parse cannot: RepositoryAssessmentSchema.findings is loosely typed
    // (z.record(unknown())[]), so an out-of-enum Finding.severity/.classification passes provider
    // validation silently — see output-validation.ts's file-top comment. This runs regardless of
    // which AnalysisProvider produced the output (recorded or live), so a bad fixture or a future
    // provider bug is caught here too, not just inside ClaudeCliAnalysisProvider's own repair
    // logic. Throws and writes nothing if invalid — no silent fallback, no partial bundle.
    assertValidAnalysisOutput(providerOutput);
    const { assessment, goalResolution, milestone } = providerOutput;

    // Orchestration is deterministic pack policy, not model output — resolved here rather than
    // by the AnalysisProvider (see orchestration-defaults.ts doc comment).
    const orchestrationProfile = resolveDefaultOrchestrationProfile(clock);
    const orchestration = resolveDefaultOrchestrationSpec(orchestrationProfile);

    const paths = await writeAnalysisBundle(args.outputDir, {
      assessment,
      goalResolution,
      milestone,
      orchestration,
      providerId: provider.providerId,
      repoProfile,
      evidence,
      researchSources,
      externalResearch,
    });

    return {
      assessmentPath: paths.assessmentPath,
      goalResolutionPath: paths.goalResolutionPath,
      milestonePath: paths.milestonePath,
      orchestrationPath: paths.orchestrationPath,
      repositoryProfilePath: paths.repositoryProfilePath,
      providerId: provider.providerId,
      orchestrationProfileId: orchestrationProfile.id,
    };
  };
}

/** CLI-wired default. Constructing `ClaudeCliAnalysisProvider` has no side effects (no process is
 *  spawned until `.analyze()` runs), so importing this module — which every test that imports
 *  anything else from this barrel also does — never itself invokes the live provider. */
export const analyzeRepository: AnalyzeFn = createAnalyzeRepository(new ClaudeCliAnalysisProvider());
