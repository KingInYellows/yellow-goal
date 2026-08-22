import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
      requestId: 'req-ci-1',
      target: { repository },
      intent: { goal: 'Inspect the fixture repository for test purposes.' },
      mode: 'review-only',
    }),
    'utf8',
  );
  return requestPath;
}

describe('CI workflow reads refuse tracked symlinks', () => {
  let repo: FixtureRepoHandle | undefined;
  let workDir: string | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    if (workDir) await rm(workDir, { recursive: true, force: true });
    repo = undefined;
    workDir = undefined;
  });

  it('does not follow a tracked .github/workflows/*.yml symlink out of the repository', async () => {
    repo = await initFixtureRepo('node-plugin');
    const outside = join(repo.dir, '..', 'host-kubeconfig');
    await writeFile(outside, 'HOST-KUBECONFIG-LEAK');
    await mkdir(join(repo.dir, '.github', 'workflows'), { recursive: true });
    await symlink(outside, join(repo.dir, '.github', 'workflows', 'ci.yml'));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    expect(spawnSync('git', ['add', '-A'], { cwd: repo.dir, env, encoding: 'utf8' }).status).toBe(0);
    expect(
      spawnSync(
        'git',
        ['-c', 'user.name=goal-gen-fixtures', '-c', 'user.email=fixtures@goal-gen.local', 'commit', '-q', '-m', 'symlinked workflow'],
        { cwd: repo.dir, env, encoding: 'utf8' },
      ).status,
    ).toBe(0);

    workDir = await mkdtemp(join(tmpdir(), 'goal-gen-ci-workflow-'));
    const requestPath = await writeRequest(workDir, repo.dir);
    const result = await inspectRepository({ requestPath, outputDir: join(workDir, 'out') }, { clock: FIXED_CLOCK });
    const ledger = await readFile(result.evidencePath as string, 'utf8');
    expect(ledger).not.toContain('HOST-KUBECONFIG-LEAK');
    expect(ledger).toContain('content not read: symlink');
  });
});
