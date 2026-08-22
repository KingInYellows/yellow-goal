import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectRepository } from '../../backend/src/inspection';
import { initFixtureRepo } from '../fixtures/repositories/init-fixture';
import type { FixtureRepoHandle } from '../fixtures/repositories/init-fixture';

const FIXED_CLOCK = () => new Date('2024-06-01T00:00:00.000Z');

describe('manifest detector — nested package manifests', () => {
  let repo: FixtureRepoHandle | undefined;
  let workDir: string | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    if (workDir) await rm(workDir, { recursive: true, force: true });
    repo = undefined;
    workDir = undefined;
  });

  it('detects package.json below the repository root (monorepo packages/)', async () => {
    repo = await initFixtureRepo('node-plugin');
    await mkdir(join(repo.dir, 'packages', 'api'), { recursive: true });
    await writeFile(join(repo.dir, 'packages', 'api', 'package.json'), JSON.stringify({ name: 'api', scripts: { test: 'vitest run' } }));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    expect(spawnSync('git', ['add', '-A'], { cwd: repo.dir, env, encoding: 'utf8' }).status).toBe(0);
    expect(
      spawnSync(
        'git',
        ['-c', 'user.name=goal-gen-fixtures', '-c', 'user.email=fixtures@goal-gen.local', 'commit', '-q', '-m', 'nested package'],
        { cwd: repo.dir, env, encoding: 'utf8' },
      ).status,
    ).toBe(0);

    workDir = await mkdtemp(join(tmpdir(), 'goal-gen-manifests-'));
    await writeFile(
      join(workDir, 'request.json'),
      JSON.stringify({
        schemaVersion: 'yellow-goal/request/v1',
        requestId: 'req-nested-1',
        target: { repository: repo.dir },
        intent: { goal: 'Inspect the fixture repository for test purposes.' },
        mode: 'review-only',
      }),
    );
    const result = await inspectRepository({ requestPath: join(workDir, 'request.json'), outputDir: join(workDir, 'out') }, { clock: FIXED_CLOCK });
    const profile = JSON.parse(await readFile(result.repoProfilePath, 'utf8')) as {
      manifests: { path: string }[];
      commands: { id: string }[];
    };
    expect(profile.manifests.map((m) => m.path).sort()).toEqual(['package.json', 'packages/api/package.json']);
    expect(profile.commands.map((c) => c.id)).toContain('cmd-npm-packages-api-package-json-test');
  });
});
