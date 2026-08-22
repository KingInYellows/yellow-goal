/**
 * Fixture-driven inspector coverage for the remaining fixture classes not already exercised in
 * inspect-repository.test.ts (node-plugin, protected-file, conflicting-pr-metadata,
 * injection-attempt, python-app are covered there).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectRepository } from '../../backend/src/inspection';
import { initFixtureRepo } from '../fixtures/repositories/init-fixture';
import type { FixtureRepoHandle } from '../fixtures/repositories/init-fixture';

const FIXED_CLOCK = () => new Date('2024-06-01T00:00:00.000Z');

async function writeRequest(dir: string, repository: string): Promise<string> {
  const requestPath = join(dir, 'request.json');
  await writeFile(
    requestPath,
    JSON.stringify({
      schemaVersion: 'yellow-goal/request/v1',
      requestId: 'req-fixture-class-1',
      target: { repository },
      intent: { goal: 'Inspect the fixture repository for test purposes.' },
      mode: 'review-only',
    }),
    'utf8',
  );
  return requestPath;
}

async function runInspect(fixtureClass: string) {
  const repo = await initFixtureRepo(fixtureClass);
  const workDir = await mkdtemp(join(tmpdir(), 'goal-gen-fixture-class-'));
  const requestPath = await writeRequest(workDir, repo.dir);
  const result = await inspectRepository({ requestPath, outputDir: join(workDir, 'out') }, { clock: FIXED_CLOCK });
  const profile = JSON.parse(await readFile(result.repoProfilePath, 'utf8'));
  const evidenceLedger = await readFile(result.evidencePath as string, 'utf8');
  return { repo, workDir, profile, evidenceLedger };
}

describe('inspection fixture-class coverage', () => {
  let cleanups: { repo?: FixtureRepoHandle; workDir?: string }[] = [];

  afterEach(async () => {
    for (const c of cleanups) {
      await c.repo?.cleanup();
      if (c.workDir) await rm(c.workDir, { recursive: true, force: true });
    }
    cleanups = [];
  });

  it('infra-repo: detects terraform + ansible kinds and deployment/migration material', async () => {
    const { repo, workDir, profile, evidenceLedger } = await runInspect('infra-repo');
    cleanups.push({ repo, workDir });
    expect(profile.repositoryKinds.sort()).toEqual(['ansible', 'terraform']);
    expect(evidenceLedger).toContain('deployment/migration material present');
    expect(evidenceLedger).toContain('ansible/playbook.yml');
  });

  it('multi-package-manager: detects node, python, and go kinds simultaneously', async () => {
    const { repo, workDir, profile } = await runInspect('multi-package-manager');
    cleanups.push({ repo, workDir });
    expect(profile.repositoryKinds.sort()).toEqual(['go', 'node', 'python']);
    expect(profile.manifests.length).toBe(3);
  });

  it('ci-skipped-jobs: records the always-skipped and allowed-failure jobs', async () => {
    const { repo, workDir, profile } = await runInspect('ci-skipped-jobs');
    cleanups.push({ repo, workDir });
    const workflowFact = profile.ciWorkflows.find((w: { kind: string }) => w.kind === 'workflow-file');
    expect(workflowFact).toBeDefined();
    const jobs = workflowFact.jobs as { name: string; alwaysSkipped: boolean; allowedFailure: boolean }[];
    expect(jobs.find((j) => j.name === 'integration')?.alwaysSkipped).toBe(true);
    expect(jobs.find((j) => j.name === 'lint')?.allowedFailure).toBe(true);
    expect(jobs.find((j) => j.name === 'test')?.alwaysSkipped).toBe(false);
  });

  it('misleading-readme: instruction file and manifest are both recorded as neutral facts (no judgment)', async () => {
    const { repo, workDir, profile, evidenceLedger } = await runInspect('misleading-readme');
    cleanups.push({ repo, workDir });
    expect(profile.instructionFiles).toContain('README.md');
    expect(profile.repositoryKinds).toEqual(['node']);
    // The inspector records the README's claims as an excerpt fact — it does not itself judge
    // them true or false (that's an analysis-stage concern, out of scope for inspection).
    expect(evidenceLedger).toContain('100% test coverage');
  });

  it('no-tests: the tests-surface detector records hasTests=false', async () => {
    const { repo, workDir, evidenceLedger } = await runInspect('no-tests');
    cleanups.push({ repo, workDir });
    expect(evidenceLedger).toContain('hasTests=false');
    expect(evidenceLedger).toContain('testFileCount=0');
  });

  it('python-app: the tests-surface detector records hasTests=true with the test path', async () => {
    const { repo, workDir, evidenceLedger } = await runInspect('python-app');
    cleanups.push({ repo, workDir });
    expect(evidenceLedger).toContain('hasTests=true');
    expect(evidenceLedger).toContain('tests/test_main.py');
  });
});
