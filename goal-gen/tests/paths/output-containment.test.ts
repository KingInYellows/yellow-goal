import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertOutputDirNotInsideTarget } from '../../backend/src/paths/output-containment';

describe('assertOutputDirNotInsideTarget', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('allows an output directory that is a sibling of the target', async () => {
    dir = await mkdtemp(join(tmpdir(), 'output-contain-'));
    const target = join(dir, 'repo');
    const output = join(dir, 'out');
    await mkdir(target);
    await mkdir(output);
    await expect(assertOutputDirNotInsideTarget(output, target)).resolves.toBeUndefined();
  });

  it('rejects an output directory nested inside the target', async () => {
    dir = await mkdtemp(join(tmpdir(), 'output-contain-'));
    const target = join(dir, 'repo');
    const output = join(target, 'out');
    await mkdir(output, { recursive: true });
    await expect(assertOutputDirNotInsideTarget(output, target)).rejects.toThrow(/inside the target repository/);
  });

  it('is a no-op when the repository is not a local directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'output-contain-'));
    await expect(assertOutputDirNotInsideTarget(dir, 'owner/repo')).resolves.toBeUndefined();
  });

  it('rejects an output path that is a symlink into the target', async () => {
    dir = await mkdtemp(join(tmpdir(), 'output-contain-'));
    const target = join(dir, 'repo');
    const generated = join(target, 'generated');
    const outputLink = join(dir, 'out');
    await mkdir(generated, { recursive: true });
    await symlink(generated, outputLink);
    await expect(assertOutputDirNotInsideTarget(outputLink, target)).rejects.toThrow(/inside the target repository/);
  });

  it('rejects a not-yet-created output whose existing ancestor is a symlink into the target', async () => {
    dir = await mkdtemp(join(tmpdir(), 'output-contain-'));
    const target = join(dir, 'repo');
    const generated = join(target, 'generated');
    const outputLink = join(dir, 'out');
    await mkdir(generated, { recursive: true });
    await symlink(generated, outputLink);
    await expect(assertOutputDirNotInsideTarget(join(outputLink, 'nested'), target)).rejects.toThrow(
      /inside the target repository/,
    );
  });

  it('allows an output symlink that resolves outside the target', async () => {
    dir = await mkdtemp(join(tmpdir(), 'output-contain-'));
    const target = join(dir, 'repo');
    const outside = join(dir, 'outside-out');
    const outputLink = join(dir, 'out');
    await mkdir(target);
    await mkdir(outside);
    await symlink(outside, outputLink);
    await expect(assertOutputDirNotInsideTarget(outputLink, target)).resolves.toBeUndefined();
  });

  it('fails closed when an existing output ancestor cannot be resolved', async () => {
    dir = await mkdtemp(join(tmpdir(), 'output-contain-'));
    const target = join(dir, 'repo');
    const outputLink = join(dir, 'out');
    await mkdir(target);
    await symlink(join(dir, 'missing-target'), outputLink);
    await expect(assertOutputDirNotInsideTarget(outputLink, target)).rejects.toThrow(/cannot verify outputDir/);
  });
});
