/**
 * `inspectRepository` — the function `backend/src/cli/commands.ts`'s `runInspect` looks up at
 * `../inspection/index` and calls as `InspectFn`. Pipeline: load + validate the request, resolve
 * the target to an exact SHA, run deterministic detectors under a read-only-before/after proof,
 * write `repo-profile.json` / `command-records.json` / `resolved-target.json` / `evidence.jsonl`
 * under the run's output directory, and return their paths.
 *
 * `deps` (clock/ghClient/ghRepository) is an optional second parameter — still assignable to the
 * CLI's `InspectFn` type, which the production wiring calls with just `args`; tests inject a fixed
 * clock and a `RecordedGhClient` here.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import type { InspectArgs, InspectResult } from '../cli/types';
import type { RepositoryGoalRequest } from '../contracts';
import { EvidenceStore, writeEvidenceJsonl } from '../evidence/store';
import { parseCanonicalRequest } from '../intake';
import { assertOutputDirNotInsideTarget } from '../paths/output-containment';
import type { GhClient } from '../providers/gh-client';
import { assertReadOnly, captureReadOnlyState } from './read-only-assertion';
import { buildRepoProfile } from './profile-builder';
import { resolveRepositoryTarget } from './resolver';

/** Re-exported so worker C's AC-3 test can reuse the exact same read-only capture/diff/assert
 *  logic via the inspection barrel, rather than reaching into inspection/read-only-assertion.ts. */
export { assertReadOnly, captureReadOnlyState, diffReadOnlyState } from './read-only-assertion';
export type { ReadOnlyState, ReadOnlyViolation } from './read-only-assertion';

export interface InspectDeps {
  clock?: () => Date;
  ghClient?: GhClient;
  /** Explicit gh repo identifier for gh-sourced facts even when the target is a local-git
   *  checkout — lets a local fixture tree pair with recorded GitHub metadata "about the same
   *  repository" (the `conflicting-pr-metadata` fixture class). Defaults to `target.repository`
   *  when it looks like `OWNER/REPO` and isn't a local path. */
  ghRepository?: string;
}

function looksLikeOwnerRepo(s: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(s) && !s.startsWith('.') && !s.startsWith('/');
}

export async function inspectRepository(args: InspectArgs, deps: InspectDeps = {}): Promise<InspectResult> {
  const clock = deps.clock ?? (() => new Date());

  const requestRaw: unknown = JSON.parse(await readFile(args.requestPath, 'utf8'));
  const request: RepositoryGoalRequest = parseCanonicalRequest(requestRaw);

  await assertOutputDirNotInsideTarget(args.outputDir, request.target.repository);
  const outputDir = resolvePath(args.outputDir);
  await mkdir(outputDir, { recursive: true });

  const ghRepository = deps.ghRepository ?? (looksLikeOwnerRepo(request.target.repository) ? request.target.repository : undefined);

  const { target, localDir } = await resolveRepositoryTarget(
    { repository: request.target.repository, requestedRef: request.target.ref },
    { clock, ghClient: deps.ghClient },
  );

  const before = localDir ? captureReadOnlyState(localDir) : null;
  const evidence = new EvidenceStore(clock);
  const { profile, commandRecords } = await buildRepoProfile(target, localDir, request.target.ref, evidence, {
    ghClient: deps.ghClient,
    ghRepository,
  });
  const after = localDir ? captureReadOnlyState(localDir) : null;
  if (before && after) assertReadOnly(before, after);

  const resolvedTargetPath = join(outputDir, 'resolved-target.json');
  const repoProfilePath = join(outputDir, 'repo-profile.json');
  const commandRecordsPath = join(outputDir, 'command-records.json');
  // The evidence ledger lands at the analysis-bundle relative layout (evidence/evidence.jsonl,
  // see analysis/bundle.ts BUNDLE_FILES) so a later `analyze --profile <this repo-profile.json>`
  // picks real inspection evidence up as a sibling instead of soft-degrading to an empty ledger.
  const evidencePath = join(outputDir, 'evidence', 'evidence.jsonl');
  await mkdir(join(outputDir, 'evidence'), { recursive: true });

  await writeFile(resolvedTargetPath, `${JSON.stringify(target, null, 2)}\n`, 'utf8');
  await writeFile(repoProfilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  await writeFile(commandRecordsPath, `${JSON.stringify(commandRecords, null, 2)}\n`, 'utf8');
  await writeEvidenceJsonl(evidencePath, evidence);

  return { repoProfilePath, resolvedTargetPath, commandRecordsPath, evidencePath };
}
