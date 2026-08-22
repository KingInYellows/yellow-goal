import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileProtectedPathPolicy, loadProtectedPathPolicy } from '../../backend/src/inspection/policy';
import { readTrackedPublicFile } from '../../backend/src/inspection/safe-tracked-read';

describe('readTrackedPublicFile', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads an ordinary file inside the checkout', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tracked-read-'));
    await writeFile(join(dir, 'README.md'), 'hello');
    const result = await readTrackedPublicFile(dir, 'README.md');
    expect(result).toEqual({ status: 'ok', content: 'hello' });
  });

  it('refuses a symlink, including one that points outside the checkout', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tracked-read-'));
    const outside = join(dir, '..', 'outside-secret');
    await writeFile(outside, 'HOST-CREDENTIAL');
    await symlink(outside, join(dir, 'README.md'));
    const result = await readTrackedPublicFile(dir, 'README.md');
    expect(result).toEqual({ status: 'skipped', reason: 'symlink' });
  });

  it('refuses a protected-path match without opening it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tracked-read-'));
    await mkdir(join(dir, 'specs'), { recursive: true });
    await writeFile(join(dir, 'specs', 'api-token.md'), 'SECRET-TOKEN-VALUE');
    const policy = compileProtectedPathPolicy(await loadProtectedPathPolicy());
    const result = await readTrackedPublicFile(dir, 'specs/api-token.md', policy);
    expect(result).toEqual({ status: 'skipped', reason: 'protected' });
  });
});
