/**
 * Compare a request's `target.repository` with the identity inspect recorded on the repo
 * profile. Local-git inspect stores `resolvePath(repository)`; a request written as `./repo`,
 * `repo`, or `/abs/repo/` must still count as the same target. GitHub `owner/repo` identities
 * match on exact string first and never need this path step.
 */
import { resolve as resolvePath } from 'node:path';

export function sameRepositoryIdentity(left: string, right: string): boolean {
  if (left === right) return true;
  return resolvePath(left) === resolvePath(right);
}
