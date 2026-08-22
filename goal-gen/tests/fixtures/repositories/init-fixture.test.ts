/**
 * Round-trip tests for init-fixture.ts: a checked-in fixture tree materializes into a real git
 * repo with a deterministic HEAD SHA (fixed author/committer identity + date), the rename manifest
 * (used by the `protected-file` fixture to dodge goal-gen/.gitignore's `.env` ignore rule) is
 * applied and stripped, and path-traversal fixture/rename names are rejected.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initFixtureRepo } from './init-fixture';
import type { FixtureRepoHandle } from './init-fixture';

describe('fixtures/repositories/init-fixture', () => {
  let repo: FixtureRepoHandle | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('materializes a fixture tree into a real git repo with a HEAD SHA', async () => {
    repo = await initFixtureRepo('python-app');
    expect(repo.headSha).toMatch(/^[0-9a-f]{40}$/);
    await expect(stat(join(repo.dir, 'pyproject.toml'))).resolves.toBeDefined();
    await expect(stat(join(repo.dir, '.git'))).resolves.toBeDefined();
  });

  it('produces an identical HEAD SHA across repeated materializations of the same fixture (determinism)', async () => {
    const a = await initFixtureRepo('node-plugin');
    const shaA = a.headSha;
    await a.cleanup();

    const b = await initFixtureRepo('node-plugin');
    const shaB = b.headSha;
    repo = b;

    expect(shaB).toBe(shaA);
  });

  it('different fixture classes materialize to different HEAD SHAs', async () => {
    const a = await initFixtureRepo('python-app');
    const shaA = a.headSha;
    await a.cleanup();

    const b = await initFixtureRepo('node-plugin');
    repo = b;

    expect(b.headSha).not.toBe(shaA);
  });

  it('applies the rename manifest (dotenv.fixture -> .env) and strips the manifest file itself', async () => {
    repo = await initFixtureRepo('protected-file');
    const envContent = await readFile(join(repo.dir, '.env'), 'utf8');
    expect(envContent).toContain('FIXTURE-NOT-A-SECRET');

    await expect(stat(join(repo.dir, 'dotenv.fixture'))).rejects.toThrow();
    await expect(stat(join(repo.dir, '__fixture-manifest.json'))).rejects.toThrow();
    await expect(stat(join(repo.dir, 'key.pem'))).resolves.toBeDefined();
  });

  it('rejects a fixture name that attempts to escape the fixtures root', async () => {
    await expect(initFixtureRepo('../../etc')).rejects.toThrow(/escapes the fixtures root/);
  });

  it('rejects a fixture name that does not exist', async () => {
    await expect(initFixtureRepo('does-not-exist-fixture-class')).rejects.toThrow(/not found/);
  });
});
