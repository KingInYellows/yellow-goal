/**
 * Shared compile/inspect guard: the compiler may write only under its own run/output directory,
 * never inside the target repository tree (read-only target invariant).
 *
 * Containment is decided on canonical real paths, not lexical `resolve()` results. A symlink
 * such as `/tmp/out → /repo/generated` must be rejected. When the output directory does not
 * exist yet, the deepest existing ancestor is realpath'd and the missing tail is reattached.
 */
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path';

function isInsideOrEqual(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(`${outer}${sep}`);
}

/**
 * Canonicalize `p` for containment: realpath the deepest existing ancestor (lstat, so a
 * symlink counts as existing even when broken), then reattach any missing tail components.
 * Throws when no ancestor exists or an existing ancestor cannot be realpath'd — fail closed
 * rather than treat an unresolvable path as outside the target.
 */
async function canonicalizeForContainment(p: string): Promise<string> {
  const abs = resolvePath(p);
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      await lstat(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`no existing ancestor of "${p}"`);
      }
      missing.push(basename(current));
      current = parent;
      continue;
    }
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch {
      throw new Error(`existing ancestor "${current}" of "${p}" could not be resolved`);
    }
  }
}

export async function assertOutputDirNotInsideTarget(outputDir: string, repository: string): Promise<void> {
  let targetStat;
  try {
    targetStat = await stat(repository);
  } catch {
    return; // not a local path at all — nothing to contain
  }
  if (!targetStat.isDirectory()) return;

  let targetCanon: string;
  let outputCanon: string;
  try {
    targetCanon = await realpath(repository);
    outputCanon = await canonicalizeForContainment(outputDir);
  } catch (e) {
    throw new Error(
      `cannot verify outputDir "${outputDir}" is outside the target repository "${repository}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (isInsideOrEqual(outputCanon, targetCanon)) {
    throw new Error(
      `outputDir "${outputDir}" is inside the target repository "${repository}" — the compiler must never write under the target's own tree`,
    );
  }
}
