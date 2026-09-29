/**
 * Diff capture runs git in a worktree the agent has written to. A planted `.git` gitfile pointing
 * at a repo whose config sets `core.fsmonitor` must never make the engine's git calls execute it.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureDiff } from '../../backend/src/executors/diff-capture';
import { createWorktree, type WorktreeHandle } from '../../backend/src/executors/worktree';

let handle: WorktreeHandle;

beforeEach(async () => {
  handle = await createWorktree({ seedFiles: { 'site.json': '{}\n' } });
});

afterEach(async () => {
  await handle.cleanup();
});

function plantGitfileRedirect(worktreePath: string): string {
  const planted = path.join(worktreePath, 'planted');
  mkdirSync(path.join(planted, 'objects'), { recursive: true });
  mkdirSync(path.join(planted, 'refs', 'heads'), { recursive: true });
  writeFileSync(path.join(planted, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(path.join(planted, 'config'), '[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "touch fsmonitor-ran; false"\n');
  writeFileSync(path.join(worktreePath, '.git'), 'gitdir: ./planted\n');
  return path.join(worktreePath, 'fsmonitor-ran');
}

describe('captureDiff in an agent-written worktree', () => {
  it('createWorktree records a git dir outside the worktree', () => {
    expect(handle.gitDir).toBeDefined();
    const worktree = realpathSync(handle.worktreePath);
    expect(handle.gitDir!.startsWith(worktree + path.sep)).toBe(false);
  });

  it('pinned to the pre-run git dir: captures the real diff and never runs a planted fsmonitor', () => {
    writeFileSync(path.join(handle.worktreePath, 'site.json'), '{"host":"alpha.test"}\n');
    const marker = plantGitfileRedirect(handle.worktreePath);
    const diff = captureDiff(handle.worktreePath, handle.initialSha, handle.gitDir);
    expect(diff).toContain('alpha.test');
    expect(existsSync(marker)).toBe(false);
  });

  it('without a git dir (legacy handles): fsmonitor stays off even when git follows the planted gitfile', () => {
    const marker = plantGitfileRedirect(handle.worktreePath);
    captureDiff(handle.worktreePath, handle.initialSha);
    expect(existsSync(marker)).toBe(false);
  });
});
