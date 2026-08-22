/**
 * Tests for inspection/resolver.ts: filesystem-based local/github disambiguation, exact-SHA
 * resolution for both providers, and the honest partial-read + toolLimitations recording for
 * github targets (no local checkout, no live clone).
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RecordedGhClient } from '../../backend/src/providers/gh-client';
import type { GhRepoView } from '../../backend/src/providers/gh-client';
import { resolveRepositoryTarget } from '../../backend/src/inspection/resolver';
import { initFixtureRepo } from '../fixtures/repositories/init-fixture';
import type { FixtureRepoHandle } from '../fixtures/repositories/init-fixture';

const FIXED_CLOCK = () => new Date('2024-06-01T00:00:00.000Z');
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github-responses');

async function readJsonFixture<T>(name: string): Promise<T> {
  const raw = await readFile(join(FIXTURES_DIR, name), 'utf8');
  return JSON.parse(raw) as T;
}

describe('inspection/resolver', () => {
  let repo: FixtureRepoHandle | undefined;
  let repoViewFixture: GhRepoView;
  let commitShaFixture: Record<string, string>;

  beforeAll(async () => {
    repoViewFixture = await readJsonFixture<GhRepoView>('repo-view.json');
    commitShaFixture = await readJsonFixture<Record<string, string>>('commit-sha.json');
  });

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('resolves a local git directory as provider "local-git" with full-read access', async () => {
    repo = await initFixtureRepo('python-app');
    const result = await resolveRepositoryTarget({ repository: repo.dir }, { clock: FIXED_CLOCK });
    expect(result.localDir).toBe(repo.dir);
    expect(result.target.provider).toBe('local-git');
    expect(result.target.sha).toBe(repo.headSha);
    expect(result.target.resolvedRef).toBe('main');
    expect(result.target.accessLevel).toBe('full-read');
    expect(result.target.toolLimitations).toEqual([]);
    expect(result.target.inspectionTimestamp).toBe('2024-06-01T00:00:00.000Z');
  });

  it('resolves an OWNER/REPO string via GhClient as provider "github" with partial-read access', async () => {
    const ghClient = new RecordedGhClient({
      repoView: repoViewFixture,
      refShas: commitShaFixture,
    });
    const result = await resolveRepositoryTarget(
      { repository: 'fixture-owner/fixture-repo' },
      { clock: FIXED_CLOCK, ghClient },
    );
    expect(result.localDir).toBeNull();
    expect(result.target.provider).toBe('github');
    expect(result.target.identity).toBe('fixture-owner/fixture-repo');
    expect(result.target.defaultBranch).toBe('main');
    expect(result.target.sha).toBe(commitShaFixture.main);
    expect(result.target.accessLevel).toBe('partial-read');
    expect(result.target.toolLimitations.length).toBeGreaterThan(0);
  });

  it('throws for a github target when the ref cannot be resolved to a SHA (fail closed)', async () => {
    const ghClient = new RecordedGhClient({ repoView: repoViewFixture, refShas: {} });
    await expect(
      resolveRepositoryTarget({ repository: 'fixture-owner/fixture-repo' }, { clock: FIXED_CLOCK, ghClient }),
    ).rejects.toThrow(/could not resolve/);
  });

  it('throws for a non-local-path string with no GhClient supplied', async () => {
    await expect(
      resolveRepositoryTarget({ repository: 'fixture-owner/fixture-repo' }, { clock: FIXED_CLOCK }),
    ).rejects.toThrow(/no GhClient was provided/);
  });

  it('honors an explicit requestedRef over the default branch', async () => {
    repo = await initFixtureRepo('python-app');
    const result = await resolveRepositoryTarget(
      { repository: repo.dir, requestedRef: 'HEAD' },
      { clock: FIXED_CLOCK },
    );
    expect(result.target.requestedRef).toBe('HEAD');
    expect(result.target.sha).toBe(repo.headSha);
  });

  it('fails closed when an explicit requestedRef resolves to a different SHA than the current checkout', async () => {
    repo = await initFixtureRepo('python-app');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    expect(spawnSync('git', ['branch', 'other-ref'], { cwd: repo.dir, env, encoding: 'utf8' }).status).toBe(0);
    writeFileSync(join(repo.dir, 'OTHER.txt'), 'other tree\n');
    expect(spawnSync('git', ['add', '-A'], { cwd: repo.dir, env, encoding: 'utf8' }).status).toBe(0);
    expect(
      spawnSync(
        'git',
        ['-c', 'user.name=goal-gen-fixtures', '-c', 'user.email=fixtures@goal-gen.local', 'commit', '-q', '-m', 'other'],
        { cwd: repo.dir, env, encoding: 'utf8' },
      ).status,
    ).toBe(0);

    await expect(
      resolveRepositoryTarget({ repository: repo.dir, requestedRef: 'other-ref' }, { clock: FIXED_CLOCK }),
    ).rejects.toThrow(/Check out that ref before inspecting/);
  });
});
