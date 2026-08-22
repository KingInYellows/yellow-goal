/**
 * Stale-target-SHA detection — the mission's "reject a stale target SHA without explicit stale
 * status" requirement. Uses a real, local fixture git repository (worker B's `initFixtureRepo`):
 * compile a packet against its live HEAD, then verify all four `stale-target-sha` branches —
 * skipped (no live target given), passed (fresh, matches), failed (stale, no acknowledgment), and
 * passed-with-explicit-acknowledgment (stale, `allowStale: true`).
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createAnalyzeRepository, RecordedAnalysisProvider } from '../../backend/src/analysis';
import { createCompilePacket, verifyPacketPath } from '../../backend/src/packets';
import { initFixtureRepo, type FixtureRepoHandle } from '../fixtures/repositories/init-fixture';

const FIXTURE_ANALYSIS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'analysis', 'node-plugin');
const PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packs', 'repository-goal-packet', 'v1');
const FIXED_CLOCK = (): Date => new Date('2026-08-22T00:00:00.000Z');

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/** Adds one new commit to a real fixture repo (moving its HEAD forward) and returns the new SHA —
 *  simulates the target repository changing after a packet was compiled against an earlier SHA. */
function addFixtureCommit(dir: string): string {
  const filePath = path.join(dir, 'STALE_MARKER.txt');
  // Plain fs write (throws on failure) — no shell involvement, matching the compiler modules'
  // no-shell discipline.
  writeFileSync(filePath, 'post-compile change\n');

  const add = spawnSync('git', ['add', '-A'], { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);

  const commit = spawnSync(
    'git',
    ['-c', 'user.name=goal-gen-fixtures', '-c', 'user.email=fixtures@goal-gen.local', 'commit', '-q', '-m', 'stale-sha test: post-compile change'],
    { cwd: dir, env: GIT_ENV, encoding: 'utf8' },
  );
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);

  const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  if (rev.status !== 0) throw new Error(`git rev-parse failed: ${rev.stderr}`);
  return rev.stdout.trim();
}

async function compileAgainstFixture(fixture: FixtureRepoHandle, workDir: string) {
  const repoProfilePath = path.join(workDir, 'repository-profile.json');
  await writeFile(
    repoProfilePath,
    JSON.stringify({
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
      instructionFiles: [],
      commands: [],
      openPullRequests: [],
      issues: [],
      ciWorkflows: [],
      releaseSignals: [],
      protectedPaths: [],
      evidenceRefs: ['ev-001'],
    }),
  );
  // Sibling evidence.jsonl (see backend/src/analysis/bundle.ts's layout convention) so the
  // fixture assessment's F-001 evidence reference ("ev-001") resolves.
  await mkdir(path.join(workDir, 'evidence'), { recursive: true });
  await copyFile(path.join(FIXTURE_ANALYSIS_DIR, 'evidence', 'evidence.jsonl'), path.join(workDir, 'evidence', 'evidence.jsonl'));

  const analyze = createAnalyzeRepository(new RecordedAnalysisProvider(FIXTURE_ANALYSIS_DIR), FIXED_CLOCK);
  const analyzeResult = await analyze({
    requestPath: path.join(FIXTURE_ANALYSIS_DIR, 'request.json'),
    repoProfilePath,
    outputDir: path.join(workDir, 'analysis'),
  });

  const compile = createCompilePacket({ clock: FIXED_CLOCK, packDirOverride: PACK_DIR });
  return compile({
    requestPath: path.join(FIXTURE_ANALYSIS_DIR, 'request.json'),
    assessmentPath: analyzeResult.assessmentPath,
    pack: 'repository-goal-packet@1',
    outputDir: path.join(workDir, 'compiled'),
  });
}

describe('stale-target-sha detection', () => {
  let fixture: FixtureRepoHandle | undefined;
  let workDir: string | undefined;

  afterEach(async () => {
    if (fixture) await fixture.cleanup();
    if (workDir) await rm(workDir, { recursive: true, force: true });
    fixture = undefined;
    workDir = undefined;
  });

  it('skipped: no liveTargetPath supplied — staleness not evaluated, but explicitly recorded', async () => {
    fixture = await initFixtureRepo('node-plugin');
    workDir = await mkdtemp(path.join(tmpdir(), 'stale-sha-skip-'));
    const compiled = await compileAgainstFixture(fixture, workDir);

    const result = await verifyPacketPath(compiled.packetPath);
    const check = result.checks.find((c) => c.id === 'stale-target-sha');
    expect(check).toBeDefined();
    expect(check!.status).toBe('skipped');
    expect(check!.details).toContain('no live target supplied');
    expect(result.overall).toBe('passed');
  });

  it('passed: liveTargetPath supplied, fresh — manifest SHA matches live HEAD', async () => {
    fixture = await initFixtureRepo('node-plugin');
    workDir = await mkdtemp(path.join(tmpdir(), 'stale-sha-fresh-'));
    const compiled = await compileAgainstFixture(fixture, workDir);

    const result = await verifyPacketPath(compiled.packetPath, { liveTargetPath: fixture.dir });
    const check = result.checks.find((c) => c.id === 'stale-target-sha');
    expect(check!.status).toBe('passed');
    expect(check!.details).toBeUndefined();
    expect(result.overall).toBe('passed');
  });

  it('failed: liveTargetPath supplied, stale, allowStale not set — rejects, naming both SHAs, overall invalid', async () => {
    fixture = await initFixtureRepo('node-plugin');
    workDir = await mkdtemp(path.join(tmpdir(), 'stale-sha-stale-'));
    const compiled = await compileAgainstFixture(fixture, workDir);
    const manifestSha = fixture.headSha;

    const liveSha = addFixtureCommit(fixture.dir);
    expect(liveSha).not.toBe(manifestSha);

    const result = await verifyPacketPath(compiled.packetPath, { liveTargetPath: fixture.dir });
    const check = result.checks.find((c) => c.id === 'stale-target-sha');
    expect(check!.status).toBe('failed');
    expect(check!.details).toContain(manifestSha);
    expect(check!.details).toContain(liveSha);
    expect(result.overall).toBe('failed');
  });

  it('passed with explicit acknowledgment: liveTargetPath supplied, stale, allowStale=true — never a silent pass', async () => {
    fixture = await initFixtureRepo('node-plugin');
    workDir = await mkdtemp(path.join(tmpdir(), 'stale-sha-ack-'));
    const compiled = await compileAgainstFixture(fixture, workDir);
    const manifestSha = fixture.headSha;

    const liveSha = addFixtureCommit(fixture.dir);

    const result = await verifyPacketPath(compiled.packetPath, { liveTargetPath: fixture.dir, allowStale: true });
    const check = result.checks.find((c) => c.id === 'stale-target-sha');
    expect(check!.status).toBe('passed');
    expect(check!.details).toBe(`STALE ACKNOWLEDGED: manifest=${manifestSha} live=${liveSha}`);
    // The overall result still passes, but the acknowledgment is explicit and machine-readable in
    // this one check's details — never silently indistinguishable from a genuinely fresh packet.
    expect(result.overall).toBe('passed');
  });

  it('fail-closed: a manifest with no target.headSha cannot slip past an explicit --target gate', async () => {
    // Fresh-re-review finding: a forged packet could omit target.headSha, routing the check into
    // 'unavailable' (which never flips overall) and silently bypassing the staleness gate the
    // operator explicitly turned on. With liveTargetPath set, the missing field must FAIL.
    fixture = await initFixtureRepo('node-plugin');
    workDir = await mkdtemp(path.join(tmpdir(), 'stale-sha-forged-'));
    const compiled = await compileAgainstFixture(fixture, workDir);

    // Tamper the uncompressed packet directory: strip target.headSha from MANIFEST.json.
    const packetDir = path.dirname(compiled.manifestPath);
    const manifest = JSON.parse(await readFile(compiled.manifestPath, 'utf8')) as { target: { headSha?: string } };
    delete manifest.target.headSha;
    await writeFile(compiled.manifestPath, JSON.stringify(manifest));

    const gated = await verifyPacketPath(packetDir, { liveTargetPath: fixture.dir });
    const gatedCheck = gated.checks.find((c) => c.id === 'stale-target-sha');
    expect(gatedCheck!.status).toBe('failed');
    expect(gatedCheck!.details).toContain('fail-closed');
    expect(gated.overall).toBe('failed');

    // Without an explicit gate the same absence stays 'unavailable' (harmless: nothing to bypass) —
    // that one check alone must not fail the packet (other checks will flag the tampering).
    const ungated = await verifyPacketPath(packetDir);
    const ungatedCheck = ungated.checks.find((c) => c.id === 'stale-target-sha');
    expect(ungatedCheck!.status).toBe('unavailable');
  });

  it('fail-closed: an explicit --target whose HEAD cannot be resolved fails overall', async () => {
    fixture = await initFixtureRepo('node-plugin');
    workDir = await mkdtemp(path.join(tmpdir(), 'stale-sha-unresolved-'));
    const compiled = await compileAgainstFixture(fixture, workDir);

    const notGit = path.join(workDir, 'not-a-repo');
    await mkdir(notGit);
    const result = await verifyPacketPath(compiled.packetPath, { liveTargetPath: notGit });
    const check = result.checks.find((c) => c.id === 'stale-target-sha');
    expect(check!.status).toBe('failed');
    expect(check!.details).toContain('could not resolve live HEAD');
    expect(result.overall).toBe('failed');
  });
});
