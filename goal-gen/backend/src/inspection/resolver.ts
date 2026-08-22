/**
 * Resolves `request.target.repository` (a local filesystem path OR an `OWNER/REPO` GitHub
 * identifier) into a `ResolvedRepositoryTarget` — exact SHA, timestamps, and honest access
 * limitations.
 *
 * Disambiguation is filesystem-based (does a directory with a `.git` entry exist at this path?),
 * never a regex guess against the string shape — a local path can look exactly like `owner/repo`.
 *
 * `local-git` targets get `accessLevel: 'full-read'`: the file tree is inspectable directly via
 * `inspection/git.ts` against the local checkout. `github` targets (no local directory) get
 * `accessLevel: 'partial-read'`: `GhClient` supplies PR/issue/CI/release/milestone metadata, but
 * file-tree-dependent detectors (instruction files, manifests, commands, protected-path metadata,
 * tests-surface) cannot run and that limitation is recorded on `toolLimitations` rather than
 * silently skipped or worked around with a live clone — see the Phase 2 delta sent to main:
 * `GhClient` is scoped to metadata by the charter, and cloning a bare `OWNER/REPO` would require
 * live network access the test suite explicitly forbids.
 *
 * Fails closed: no `ResolvedRepositoryTarget` is ever produced without a concrete resolved SHA
 * (the schema requires one) — an unresolvable ref throws rather than substituting a placeholder.
 */
import { stat } from 'node:fs/promises';
import { resolve as resolvePath, join } from 'node:path';
import { ResolvedRepositoryTargetSchema } from '../contracts';
import type { ResolvedRepositoryTarget } from '../contracts';
import type { GhClient } from '../providers/gh-client';
import { defaultBranch, revParse, symbolicRef } from './git';

export interface ResolveTargetInput {
  repository: string;
  requestedRef?: string;
}

export interface ResolveTargetDeps {
  clock: () => Date;
  ghClient?: GhClient;
}

export interface ResolvedTargetResult {
  target: ResolvedRepositoryTarget;
  /** Local directory to read the file tree from, or null when unavailable (see file-top comment). */
  localDir: string | null;
}

async function isLocalGitDirectory(pathCandidate: string): Promise<boolean> {
  try {
    const dirStat = await stat(pathCandidate);
    if (!dirStat.isDirectory()) return false;
    await stat(join(pathCandidate, '.git')); // exists as file (worktree/submodule) or directory
    return true;
  } catch {
    return false;
  }
}

export async function resolveRepositoryTarget(
  input: ResolveTargetInput,
  deps: ResolveTargetDeps,
): Promise<ResolvedTargetResult> {
  const { repository } = input;
  // The canonical request's ref carries an 'AUTO' sentinel (intake default, from the vendored
  // request template) meaning "whatever the repository's default branch / HEAD is" — it is never
  // a literal git ref, so translate it to undefined before resolution.
  const requestedRef = input.requestedRef === 'AUTO' ? undefined : input.requestedRef;

  if (await isLocalGitDirectory(repository)) {
    const localDir = resolvePath(repository);
    const branch = defaultBranch(localDir);
    const worktreeSha = revParse(localDir, 'HEAD');
    if (!worktreeSha) {
      throw new Error(`local-git target "${repository}" has no resolvable HEAD (empty or corrupt repo?)`);
    }

    // Detectors read the current worktree. The recorded SHA must be that tree — otherwise the
    // packet would claim evidence for one commit while analyzing another. AUTO inspects HEAD;
    // an explicit ref is accepted only when it already is the current checkout.
    let ref: string;
    let sha: string;
    if (requestedRef === undefined) {
      ref = symbolicRef(localDir, 'HEAD')?.replace(/^refs\/heads\//, '') ?? branch ?? 'HEAD';
      sha = worktreeSha;
    } else {
      const resolved = revParse(localDir, requestedRef);
      if (!resolved) {
        throw new Error(`local-git target "${repository}" has no resolvable ref "${requestedRef}" (empty or corrupt repo?)`);
      }
      if (resolved !== worktreeSha) {
        throw new Error(
          `requested ref "${requestedRef}" resolved to ${resolved} but the current checkout HEAD is ${worktreeSha}. ` +
            'Check out that ref before inspecting so the packet SHA matches the inspected tree.',
        );
      }
      ref = requestedRef;
      sha = resolved;
    }

    const target = ResolvedRepositoryTargetSchema.parse({
      schemaVersion: 'yellow-goal/resolved-repository-target/v1',
      provider: 'local-git',
      identity: localDir,
      defaultBranch: branch,
      requestedRef: requestedRef ?? ref,
      resolvedRef: ref,
      sha,
      inspectionTimestamp: deps.clock().toISOString(),
      accessLevel: 'full-read',
      toolLimitations: [],
    });
    return { target, localDir };
  }

  if (!deps.ghClient) {
    throw new Error(
      `"${repository}" is not a local git directory and no GhClient was provided to resolve it as a GitHub target`,
    );
  }
  const repoView = await deps.ghClient.repoView(repository);
  const branch = repoView?.defaultBranchRef?.name ?? null;
  const ref = requestedRef ?? branch ?? 'HEAD';
  const sha = await deps.ghClient.resolveRefSha(repository, ref);
  if (!sha) {
    throw new Error(`could not resolve an exact SHA for github target "${repository}" at ref "${ref}"`);
  }
  const target = ResolvedRepositoryTargetSchema.parse({
    schemaVersion: 'yellow-goal/resolved-repository-target/v1',
    provider: 'github',
    identity: repository,
    defaultBranch: branch,
    requestedRef: requestedRef ?? ref,
    resolvedRef: ref,
    sha,
    inspectionTimestamp: deps.clock().toISOString(),
    accessLevel: 'partial-read',
    toolLimitations: [
      'no local checkout for this github-hosted target: instruction-file, manifest, command, ' +
        'protected-path, and tests-surface detectors did not run; only gh-sourced PR/issue/CI/' +
        'release/milestone metadata is available',
    ],
  });
  return { target, localDir: null };
}
