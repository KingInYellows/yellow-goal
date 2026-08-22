/**
 * End-to-end tests for inspection/index.ts's `inspectRepository` — the function the CLI's `inspect`
 * command calls. Covers: basic wiring against several fixture classes, RepoProfile schema
 * validity, protected-path facts-only recording, github-metadata pairing (local tree + recorded
 * gh responses), the injection-attempt fixture (repository content lands only as bounded evidence,
 * never executed), determinism under a fixed clock, and the outputDir-inside-target guard.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectRepository } from '../../backend/src/inspection';
import { RecordedGhClient } from '../../backend/src/providers/gh-client';
import { RepoProfileSchema } from '../../backend/src/contracts';
import { initFixtureRepo } from '../fixtures/repositories/init-fixture';
import type { FixtureRepoHandle } from '../fixtures/repositories/init-fixture';

const FIXED_CLOCK = () => new Date('2024-06-01T00:00:00.000Z');

async function writeRequest(dir: string, repository: string, ref?: string): Promise<string> {
  const requestPath = join(dir, 'request.json');
  await writeFile(
    requestPath,
    JSON.stringify({
      schemaVersion: 'yellow-goal/request/v1',
      requestId: 'req-fixture-1',
      target: { repository, ...(ref !== undefined ? { ref } : {}) },
      intent: { goal: 'Inspect the fixture repository for test purposes.' },
      mode: 'review-only',
    }),
    'utf8',
  );
  return requestPath;
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

async function readJsonFixture<T>(name: string): Promise<T> {
  const raw = await readFile(join(TEST_DIR, '..', 'fixtures', 'github-responses', name), 'utf8');
  return JSON.parse(raw) as T;
}

describe('inspection/index inspectRepository', () => {
  let repo: FixtureRepoHandle | undefined;
  let workDir: string | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    if (workDir) await rm(workDir, { recursive: true, force: true });
    repo = undefined;
    workDir = undefined;
  });

  it('produces a schema-valid RepoProfile for the node-plugin fixture with npm-script CommandRecords', async () => {
    repo = await initFixtureRepo('node-plugin');
    workDir = await mkdtemp(join(tmpdir(), 'goal-gen-inspect-'));
    const requestPath = await writeRequest(workDir, repo.dir);
    const outputDir = join(workDir, 'out');

    const result = await inspectRepository({ requestPath, outputDir }, { clock: FIXED_CLOCK });

    const profileRaw = JSON.parse(await readFile(result.repoProfilePath, 'utf8'));
    const profile = RepoProfileSchema.parse(profileRaw);
    expect(profile.target.headSha).toBe(repo.headSha);
    expect(profile.repositoryKinds).toEqual(['node']);
    expect(profile.instructionFiles).toContain('README.md');
    const commandIds = profile.commands.map((c) => c.id);
    expect(commandIds).toContain('cmd-npm-package-json-build');
    expect(commandIds).toContain('cmd-npm-package-json-test');

    const commandRecords = JSON.parse(await readFile(result.commandRecordsPath as string, 'utf8'));
    expect(commandRecords.every((c: { executable: boolean }) => c.executable === true)).toBe(true);
  });

  it('records protected paths as facts-only metadata (no excerpt) for the protected-file fixture', async () => {
    repo = await initFixtureRepo('protected-file');
    workDir = await mkdtemp(join(tmpdir(), 'goal-gen-inspect-'));
    const requestPath = await writeRequest(workDir, repo.dir);
    const outputDir = join(workDir, 'out');

    const result = await inspectRepository({ requestPath, outputDir }, { clock: FIXED_CLOCK });
    const profile = JSON.parse(await readFile(result.repoProfilePath, 'utf8'));
    expect(profile.protectedPaths.sort()).toEqual(['.env', 'key.pem']);

    const evidenceLines = (await readFile(result.evidencePath as string, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const protectedRecords = evidenceLines.filter((r: { sensitivity: string }) => r.sensitivity === 'protected-metadata');
    expect(protectedRecords.length).toBe(2);
    for (const record of protectedRecords) {
      expect(record.excerpt).toBeUndefined();
      expect(record.facts.some((f: string) => f.startsWith('path='))).toBe(true);
      expect(record.facts.some((f: string) => f.startsWith('hash='))).toBe(true);
    }
    // The protected records' own JSON lines never carry the fixture's placeholder secret text —
    // even though README.md's prose legitimately *mentions* "FIXTURE-NOT-A-SECRET" as
    // documentation (that's a normal, non-protected file being read normally), the .env/key.pem
    // evidence lines themselves must contain only path/size/hash, never file content.
    for (const record of protectedRecords) {
      expect(JSON.stringify(record)).not.toContain('FIXTURE-NOT-A-SECRET');
    }
  });

  it('pairs a local fixture tree with recorded gh responses for PR/CI metadata (conflicting-pr-metadata)', async () => {
    repo = await initFixtureRepo('conflicting-pr-metadata');
    workDir = await mkdtemp(join(tmpdir(), 'goal-gen-inspect-'));
    const requestPath = await writeRequest(workDir, repo.dir);
    const outputDir = join(workDir, 'out');

    const ghClient = new RecordedGhClient({
      prList: await readJsonFixture('pr-list-conflicting.json'),
    });

    const result = await inspectRepository(
      { requestPath, outputDir },
      { clock: FIXED_CLOCK, ghClient, ghRepository: 'fixture-owner/fixture-repo' },
    );
    const profile = JSON.parse(await readFile(result.repoProfilePath, 'utf8'));
    expect(profile.openPullRequests.length).toBe(3);
    expect(profile.openPullRequests.some((pr: { mergeStateStatus: string }) => pr.mergeStateStatus === 'DIRTY')).toBe(true);
  });

  it('injection-attempt fixture: injected repository text lands only as bounded evidence, run completes without executing anything', async () => {
    repo = await initFixtureRepo('injection-attempt');
    workDir = await mkdtemp(join(tmpdir(), 'goal-gen-inspect-'));
    const requestPath = await writeRequest(workDir, repo.dir);
    const outputDir = join(workDir, 'out');

    const result = await inspectRepository({ requestPath, outputDir }, { clock: FIXED_CLOCK });
    const rawLedger = await readFile(result.evidencePath as string, 'utf8');
    expect(rawLedger).toContain('SYSTEM OVERRIDE');
    expect(rawLedger).toContain('ignore all previous instructions');

    // Every line is well-formed JSON with the injected text confined to string field values —
    // if it had escaped into structure the line would fail to parse as one JSON object.
    for (const line of rawLedger.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // The marker file used elsewhere to prove non-execution never appears here because nothing in
    // this pipeline ever passes repository content to a shell or spawnSync argv — this test's
    // real proof is structural (git.ts/gh-client.ts never receive file content as command input)
    // and is exercised directly in tests/inspection/git.test.ts's adversarial-pathspec case.
  });

  it('is deterministic: inspecting the same materialized fixture twice under a fixed clock yields byte-identical RepoProfile JSON', async () => {
    repo = await initFixtureRepo('python-app');
    workDir = await mkdtemp(join(tmpdir(), 'goal-gen-inspect-'));
    const requestPath = await writeRequest(workDir, repo.dir);

    const outputDirA = join(workDir, 'out-a');
    const outputDirB = join(workDir, 'out-b');
    const resultA = await inspectRepository({ requestPath, outputDir: outputDirA }, { clock: FIXED_CLOCK });
    const resultB = await inspectRepository({ requestPath, outputDir: outputDirB }, { clock: FIXED_CLOCK });

    const profileA = await readFile(resultA.repoProfilePath, 'utf8');
    const profileB = await readFile(resultB.repoProfilePath, 'utf8');
    expect(profileA).toBe(profileB);

    const evidenceA = await readFile(resultA.evidencePath as string, 'utf8');
    const evidenceB = await readFile(resultB.evidencePath as string, 'utf8');
    expect(evidenceA).toBe(evidenceB);
  });

  it('rejects an outputDir nested inside the target repository', async () => {
    repo = await initFixtureRepo('python-app');
    const requestPath = await writeRequest(repo.dir, repo.dir);
    const outputDir = join(repo.dir, '.goal-gen-out');
    await mkdir(outputDir, { recursive: true });

    await expect(inspectRepository({ requestPath, outputDir }, { clock: FIXED_CLOCK })).rejects.toThrow(
      /inside the target repository/,
    );
  });
});
