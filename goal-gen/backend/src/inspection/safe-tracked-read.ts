/**
 * Bounded, containment-checked read of a tracked worktree path. Callers that need ordinary
 * (non-protected) file text — instruction files, manifests — must go through this helper rather
 * than `readFile` so a tracked symlink cannot follow out of the repository to a host credential.
 *
 * Does not use `inspection/git.ts` (that module is structurally metadata-only). `lstat` is used
 * so a symlink is never opened; `realpath` containment is a second belt against directory
 * components that themselves resolve outside the checkout.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { CompiledProtectedPathPolicy } from './policy';

export type TrackedReadSkipReason = 'protected' | 'symlink' | 'escape' | 'unreadable';

export type TrackedReadResult =
  | { status: 'ok'; content: string }
  | { status: 'skipped'; reason: TrackedReadSkipReason };

function isInsideRoot(resolvedFile: string, resolvedRoot: string): boolean {
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}${sep}`);
}

export async function readTrackedPublicFile(
  localDir: string,
  relPath: string,
  policy?: CompiledProtectedPathPolicy,
): Promise<TrackedReadResult> {
  if (policy?.isProtected(relPath)) return { status: 'skipped', reason: 'protected' };

  const abs = join(localDir, relPath);
  let info;
  try {
    info = await lstat(abs);
  } catch {
    return { status: 'skipped', reason: 'unreadable' };
  }
  if (info.isSymbolicLink()) return { status: 'skipped', reason: 'symlink' };
  if (!info.isFile()) return { status: 'skipped', reason: 'unreadable' };

  let resolvedFile: string;
  let resolvedRoot: string;
  try {
    resolvedFile = await realpath(abs);
    resolvedRoot = await realpath(localDir);
  } catch {
    return { status: 'skipped', reason: 'unreadable' };
  }
  if (!isInsideRoot(resolvedFile, resolvedRoot)) return { status: 'skipped', reason: 'escape' };

  try {
    return { status: 'ok', content: await readFile(abs, 'utf8') };
  } catch {
    return { status: 'skipped', reason: 'unreadable' };
  }
}
