/**
 * `writeFileExclusive` cleanup on failure: a write that fails after the exclusive create must
 * remove the file it created (or a retry is refused as already existing), and when that removal
 * also fails the rethrown error must carry both failures. `node:fs/promises` is wrapped so a test
 * can fail the handle write and the unlink on demand; everything else is the real filesystem.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ write: undefined as Error | undefined, unlink: undefined as Error | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const realWriteFile = handle.writeFile.bind(handle);
      handle.writeFile = (async (...writeArgs: Parameters<typeof realWriteFile>) => {
        if (faults.write) throw faults.write;
        return realWriteFile(...writeArgs);
      }) as typeof handle.writeFile;
      return handle;
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (faults.unlink) throw faults.unlink;
      return actual.unlink(...args);
    },
  };
});

import { writeFileExclusive } from '../../backend/src/cli/run-approval';

const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'write-file-exclusive-'));
  faults.write = undefined;
  faults.unlink = undefined;
});

afterEach(async () => {
  faults.write = undefined;
  faults.unlink = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('writeFileExclusive cleanup on failure', () => {
  it('writes the file when nothing fails', async () => {
    const file = path.join(dir, 'ok.json');
    await writeFileExclusive(file, 'data');
    expect(await readFile(file, 'utf8')).toBe('data');
  });

  it('removes the file it created and rethrows the original error when the write fails', async () => {
    const file = path.join(dir, 'partial.json');
    const writeErr = errno('ENOSPC');
    faults.write = writeErr;
    await expect(writeFileExclusive(file, 'data')).rejects.toBe(writeErr);
    expect(existsSync(file)).toBe(false);
    // The path is free again, so a retry is not refused as existing.
    faults.write = undefined;
    await writeFileExclusive(file, 'data');
    expect(await readFile(file, 'utf8')).toBe('data');
  });

  it('reports both failures when the cleanup unlink also fails', async () => {
    const file = path.join(dir, 'stuck.json');
    const writeErr = errno('ENOSPC');
    const unlinkErr = errno('EACCES');
    faults.write = writeErr;
    faults.unlink = unlinkErr;
    const thrown = await writeFileExclusive(file, 'data').catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('could not be removed');
    const cause = (thrown as Error).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toEqual([writeErr, unlinkErr]);
  });
});
