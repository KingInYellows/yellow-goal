import { describe, expect, it } from 'vitest';
import { parsePorcelainPaths } from '../../backend/src/executors/worktree';

describe('parsePorcelainPaths', () => {
  it('returns the destination of a rename (git -z emits destination first, then source)', () => {
    // Verified against real git: `git mv site.json other.txt; git status --porcelain -z`.
    expect(parsePorcelainPaths('R  other.txt\0site.json\0')).toEqual(['other.txt']);
  });

  it('does not treat the rename source as its own entry, and keeps following entries', () => {
    expect(parsePorcelainPaths('R  new.txt\0old.txt\0 M a.txt\0?? b.txt\0')).toEqual(['new.txt', 'a.txt', 'b.txt']);
  });

  it('returns single paths for non-rename entries and [] for empty input', () => {
    expect(parsePorcelainPaths('')).toEqual([]);
    expect(parsePorcelainPaths('?? x\0!! foo/bar.txt\0')).toEqual(['x', 'foo/bar.txt']);
  });
});
