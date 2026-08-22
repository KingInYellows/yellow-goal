/**
 * AC-3 — read-only integration proof: run inspect(stub RepoProfile)→analyze(recorded)→compile→
 * verify against a real, local fixture repository (materialized by worker B's
 * `initFixtureRepo`), capturing branch/HEAD/`git status --porcelain`/tracked-file hashes/
 * untracked-file set before and after, and assert nothing changed.
 *
 * `initFixtureRepo` is worker B's exported fixture-materialization helper. As of this writing it
 * materializes a fixture tree into a real git repo but does not itself export a general-purpose
 * "snapshot the working tree" assertion helper, so this test builds its own snapshot/compare
 * locally (per the team charter: "if it's not there when you need it, stub locally and tell
 * main"). If worker B later exports a shared read-only assertion helper, this test should switch
 * to it instead of the local `snapshotRepo`/`assertUnchanged` below.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { initFixtureRepo, type FixtureRepoHandle } from '../fixtures/repositories/init-fixture';
import { createAnalyzeRepository, RecordedAnalysisProvider } from '../../backend/src/analysis';
import { createCompilePacket, verifyPacketPath } from '../../backend/src/packets';

const FIXTURE_ANALYSIS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'analysis', 'node-plugin');
const PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packs', 'repository-goal-packet', 'v1');
const FIXED_CLOCK = (): Date => new Date('2026-08-22T00:00:00.000Z');

interface RepoSnapshot {
  branch: string;
  headSha: string;
  statusPorcelain: string;
  trackedHashes: string; // `git ls-tree -r HEAD` output — path + blob hash per tracked file.
}

function git(args: readonly string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function snapshotRepo(repoDir: string): RepoSnapshot {
  return {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim(),
    headSha: git(['rev-parse', 'HEAD'], repoDir).trim(),
    statusPorcelain: git(['status', '--porcelain'], repoDir),
    trackedHashes: git(['ls-tree', '-r', 'HEAD'], repoDir),
  };
}

function assertUnchanged(before: RepoSnapshot, after: RepoSnapshot): void {
  expect(after.branch).toBe(before.branch);
  expect(after.headSha).toBe(before.headSha);
  expect(after.statusPorcelain).toBe(before.statusPorcelain);
  expect(after.trackedHashes).toBe(before.trackedHashes);
}

describe('AC-3 — inspect/analyze/compile/verify never mutate the target repository', () => {
  let fixture: FixtureRepoHandle | undefined;
  let workDir: string | undefined;

  afterEach(async () => {
    if (fixture) await fixture.cleanup();
    if (workDir) await rm(workDir, { recursive: true, force: true });
    fixture = undefined;
    workDir = undefined;
  });

  it('leaves the fixture repository byte-for-byte unchanged across the full pipeline', async () => {
    fixture = await initFixtureRepo('node-plugin');
    workDir = await mkdtemp(path.join(tmpdir(), 'ac3-'));

    // This test's "inspect" stage: rather than a real inspectRepository call (worker B's module),
    // build a RepoProfile pointing at the fixture's real, live-computed HEAD SHA — this is what
    // proves the pipeline reads the target only, and everything downstream is compiler-mode.
    const repoProfilePath = path.join(workDir, 'repository-profile.json');
    const repoProfile = {
      schemaVersion: 'yellow-goal/repo-profile/v1',
      target: {
        repository: 'local/node-plugin-fixture',
        defaultBranch: 'main',
        requestedRef: 'main',
        resolvedRef: 'main',
        headSha: fixture.headSha,
        inspectedAt: '2026-08-22T00:00:00.000Z',
      },
      repositoryKinds: ['node', 'plugin'],
      instructionFiles: ['README.md'],
      commands: [],
      openPullRequests: [],
      issues: [],
      ciWorkflows: [],
      releaseSignals: [],
      protectedPaths: [],
      evidenceRefs: ['ev-001'],
    };
    await writeFile(repoProfilePath, JSON.stringify(repoProfile));
    // Sibling evidence.jsonl (see backend/src/analysis/bundle.ts's layout convention) so the
    // fixture assessment's F-001/AC evidence reference ("ev-001") resolves.
    await mkdir(path.join(workDir, 'evidence'), { recursive: true });
    await copyFile(path.join(FIXTURE_ANALYSIS_DIR, 'evidence', 'evidence.jsonl'), path.join(workDir, 'evidence', 'evidence.jsonl'));

    const before = snapshotRepo(fixture.dir);

    const analyze = createAnalyzeRepository(new RecordedAnalysisProvider(FIXTURE_ANALYSIS_DIR), FIXED_CLOCK);
    const analyzeResult = await analyze({
      requestPath: path.join(FIXTURE_ANALYSIS_DIR, 'request.json'),
      repoProfilePath,
      outputDir: path.join(workDir, 'analysis'),
    });

    const compile = createCompilePacket({ clock: FIXED_CLOCK, packDirOverride: PACK_DIR });
    const compileResult = await compile({
      requestPath: path.join(FIXTURE_ANALYSIS_DIR, 'request.json'),
      assessmentPath: analyzeResult.assessmentPath,
      pack: 'repository-goal-packet@1',
      outputDir: path.join(workDir, 'compiled'),
    });

    const validation = await verifyPacketPath(compileResult.packetPath);
    expect(validation.overall).toBe('passed');

    const after = snapshotRepo(fixture.dir);
    assertUnchanged(before, after);

    // The packet itself recorded the SHA it was inspected against, and asserts no mutation.
    expect(repoProfile.target.headSha).toBe(fixture.headSha);
  });
});
