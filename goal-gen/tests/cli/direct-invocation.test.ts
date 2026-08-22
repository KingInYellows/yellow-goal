import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isDirectInvocation } from '../../backend/src/cli/direct-invocation';

describe('isDirectInvocation', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns false when argv[1] is missing', () => {
    expect(isDirectInvocation('file:///tmp/cli.js', undefined)).toBe(false);
    expect(isDirectInvocation('file:///tmp/cli.js', '')).toBe(false);
  });

  it('matches a relative argv path the way pathToFileURL does, not via file://${argv}', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cli-entry-'));
    const abs = path.join(dir, 'cli.js');
    await writeFile(abs, '');
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const metaUrl = pathToFileURL(abs).href;
      expect(isDirectInvocation(metaUrl, 'cli.js')).toBe(true);
      expect(metaUrl === `file://${'cli.js'}`).toBe(false);
    } finally {
      process.chdir(prev);
    }
  });

  it('matches through a symlink via realpath', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cli-entry-'));
    const real = path.join(dir, 'real.js');
    const link = path.join(dir, 'link.js');
    await writeFile(real, '');
    await symlink(real, link);
    expect(isDirectInvocation(pathToFileURL(real).href, link)).toBe(true);
  });
});
