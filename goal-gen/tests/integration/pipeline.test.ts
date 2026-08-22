/**
 * Full-pipeline integration proof: raw {repository, goal} → intake → REAL inspectRepository →
 * analyze (recorded provider) → compile → packet verify, against a real local fixture repository.
 *
 * This is the one test where worker B's real inspector output feeds worker C's analysis-bundle
 * convention end to end (their own suites each exercise one side against stubs). It also carries
 * the strictest read-only proof: branch, HEAD, `git status --porcelain` (which covers the
 * untracked set), tracked-file blob hashes, and an explicit untracked-file listing, captured
 * before and after the entire pipeline.
 *
 * The recorded analysis fixture is derived at test time: its evidence references are rewritten to
 * the FIRST id in the real inspection ledger, so the compiled packet's evidence links resolve
 * against genuinely inspected evidence — not against a parallel hand-written ledger.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { initFixtureRepo, type FixtureRepoHandle } from '../fixtures/repositories/init-fixture';
import { normalizeRequest } from '../../backend/src/intake';
import { inspectRepository } from '../../backend/src/inspection';
import { createAnalyzeRepository, RecordedAnalysisProvider } from '../../backend/src/analysis';
import { createCompilePacket, verifyPacketPath } from '../../backend/src/packets';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS_FIXTURE_DIR = path.resolve(HERE, '..', 'fixtures', 'analysis', 'node-plugin');
const PACK_DIR = path.resolve(HERE, '..', '..', 'packs', 'repository-goal-packet', 'v1');
const FIXED_CLOCK = (): Date => new Date('2026-08-22T00:00:00.000Z');

interface RepoSnapshot {
  branch: string;
  headSha: string;
  statusPorcelain: string;
  trackedHashes: string;
  untrackedFiles: string;
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
    untrackedFiles: git(['ls-files', '--others', '--exclude-standard'], repoDir),
  };
}

describe('full pipeline: intake → real inspect → analyze → compile → verify', () => {
  let fixture: FixtureRepoHandle | undefined;
  let workDir: string | undefined;

  afterEach(async () => {
    if (fixture) await fixture.cleanup();
    if (workDir) await rm(workDir, { recursive: true, force: true });
    fixture = undefined;
    workDir = undefined;
  });

  it('produces a verified packet from a raw repository+goal without touching the target', async () => {
    fixture = await initFixtureRepo('python-app');
    workDir = await mkdtemp(path.join(tmpdir(), 'pipeline-e2e-'));

    // Intake: minimal flat input — exactly the two required fields plus injected id for
    // reproducibility. Goal text chosen with odd spacing to re-verify verbatim preservation
    // at the far end of the pipeline.
    const goal = '  Add a /health endpoint  returning build metadata. ';
    // Trailing slash is what a human types for a local path; inspect records resolvePath identity.
    const request = normalizeRequest(
      { repository: `${fixture.dir}/`, goal },
      { generateRequestId: () => 'e2e-pipeline-request' },
    );
    const requestPath = path.join(workDir, 'request.json');
    await writeFile(requestPath, JSON.stringify(request, null, 2));

    const before = snapshotRepo(fixture.dir);

    // Real inspection (local-git provider; no gh client involved).
    const inspection = await inspectRepository({
      requestPath,
      outputDir: path.join(workDir, 'inspection'),
    });

    // The real ledger must be non-empty and live at the analysis-bundle sibling layout.
    const ledgerRaw = (await readFile(inspection.evidencePath as string, 'utf8')).trim();
    expect(ledgerRaw.length).toBeGreaterThan(0);
    const firstEvidenceId = (JSON.parse(ledgerRaw.split('\n')[0]!) as { id: string }).id;
    expect(firstEvidenceId).toMatch(/^ev-\d{4}$/);
    expect(inspection.evidencePath).toBe(
      path.join(path.dirname(inspection.repoProfilePath as string), 'evidence', 'evidence.jsonl'),
    );

    // Derive a recorded analysis fixture whose evidence references resolve against the REAL
    // inspection ledger (the checked-in fixture references its own hand-written ev-001).
    const derivedFixtureDir = path.join(workDir, 'derived-analysis-fixture');
    await mkdir(derivedFixtureDir, { recursive: true });
    for (const name of ['assessment.json', 'goal-resolution.json', 'milestone.json']) {
      const raw = await readFile(path.join(ANALYSIS_FIXTURE_DIR, name), 'utf8');
      const rewritten = raw.replaceAll('"ev-001"', `"${firstEvidenceId}"`);
      if (name === 'goal-resolution.json') {
        const parsed = JSON.parse(rewritten) as { requestedGoal: string };
        parsed.requestedGoal = goal;
        await writeFile(path.join(derivedFixtureDir, name), JSON.stringify(parsed));
      } else {
        await writeFile(path.join(derivedFixtureDir, name), rewritten);
      }
    }

    const analyze = createAnalyzeRepository(new RecordedAnalysisProvider(derivedFixtureDir), FIXED_CLOCK);
    const analyzed = await analyze({
      requestPath,
      repoProfilePath: inspection.repoProfilePath as string,
      outputDir: path.join(workDir, 'analysis'),
    });

    const compile = createCompilePacket({ clock: FIXED_CLOCK, packDirOverride: PACK_DIR });
    const compiled = await compile({
      requestPath,
      assessmentPath: analyzed.assessmentPath,
      pack: 'repository-goal-packet@1',
      outputDir: path.join(workDir, 'compiled'),
    });

    const validation = await verifyPacketPath(compiled.packetPath);
    expect(validation.checks.filter((c) => c.status === 'failed')).toEqual([]);
    expect(validation.overall).toBe('passed');

    // Real inspection evidence flowed all the way into the packet (never soft-degraded to empty).
    const packetDir = path.dirname(compiled.manifestPath);
    const packetLedger = (await readFile(path.join(packetDir, 'evidence', 'evidence.jsonl'), 'utf8')).trim();
    expect(packetLedger.length).toBeGreaterThan(0);
    expect(packetLedger).toContain(firstEvidenceId);

    // Manifest pins the exact inspected SHA and the verbatim goal survived intake + rendering.
    const manifest = JSON.parse(await readFile(compiled.manifestPath, 'utf8')) as {
      target: { headSha: string };
    };
    expect(manifest.target.headSha).toBe(fixture.headSha);
    const packetRequest = JSON.parse(await readFile(path.join(packetDir, 'contracts', 'request.json'), 'utf8')) as {
      intent: { goal: string };
    };
    expect(packetRequest.intent.goal).toBe(goal);

    // Read-only proof across the whole pipeline, untracked set included.
    const after = snapshotRepo(fixture.dir);
    expect(after).toEqual(before);
  });
});
