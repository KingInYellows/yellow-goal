/**
 * Test/fixture `AnalysisProvider`: reads a canned `{assessment, goalResolution, milestone}`
 * response from a fixture directory (`tests/fixtures/analysis/<fixtureId>/`) instead of calling
 * a model. Deterministic and pure — the same fixture directory always returns the same validated
 * output, which is what makes the "deterministic assessment→packet path is pure" property
 * testable without live model calls (`.claude/specs/packet-compiler.md` "Testing").
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GoalResolutionSchema, MilestoneSpecSchema, RepositoryAssessmentSchema } from '../contracts';
import { AnalysisProviderError, type AnalysisProvider, type AnalysisProviderInput, type AnalysisProviderOutput } from './types';

async function readValidated<T>(filePath: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { message: string } } }, label: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    throw new AnalysisProviderError(`RecordedAnalysisProvider: cannot read ${label} at ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed: unknown = JSON.parse(raw);
  const result = schema.safeParse(parsed);
  if (!result.success || result.data === undefined) {
    throw new AnalysisProviderError(`RecordedAnalysisProvider: ${label} at ${filePath} failed validation: ${result.error?.message}`);
  }
  return result.data;
}

/**
 * Reads `assessment.json`, `goal-resolution.json`, `milestone.json` from `fixtureDir` and
 * returns them verbatim (validated) on every `analyze()` call, ignoring the input — one provider
 * instance always answers with the one fixture it was constructed against.
 */
export class RecordedAnalysisProvider implements AnalysisProvider {
  readonly providerId = 'recorded-fixture';

  constructor(private readonly fixtureDir: string) {}

  async analyze(_input: AnalysisProviderInput): Promise<AnalysisProviderOutput> {
    const [assessment, goalResolution, milestone] = await Promise.all([
      readValidated(path.join(this.fixtureDir, 'assessment.json'), RepositoryAssessmentSchema, 'assessment.json'),
      readValidated(path.join(this.fixtureDir, 'goal-resolution.json'), GoalResolutionSchema, 'goal-resolution.json'),
      readValidated(path.join(this.fixtureDir, 'milestone.json'), MilestoneSpecSchema, 'milestone.json'),
    ]);
    return { assessment, goalResolution, milestone };
  }
}
