/**
 * Descriptor-relative paths for no-follow filesystem work on paths another process may swap.
 *
 * On Linux, `/proc/self/fd/<fd>/<name>` resolves through the open descriptor, not through the
 * (swappable) name the descriptor was opened by. Elsewhere there is no such path and callers get
 * `fallback` — a plain path, which is only as safe as the caller's own checks on it.
 */
import { constants as fsConstants, existsSync } from 'node:fs';

/** `O_NOFOLLOW`, or 0 where the platform lacks it. */
export const O_NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;

/** Open flags for a directory that must not be reached through a symlink. */
export const DIRECTORY_NOFOLLOW_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | O_NOFOLLOW_FLAG;

/** A path naming the open descriptor `fd` itself, or `fallback` where `/proc/self/fd` is absent. */
export function pathThroughFd(fd: number, fallback: string): string {
  const proc = `/proc/self/fd/${fd}`;
  return existsSync(proc) ? proc : fallback;
}
