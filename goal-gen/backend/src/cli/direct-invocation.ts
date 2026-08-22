/**
 * Entry-script guard shared by the compiler CLI. Compares `import.meta.url` to `process.argv[1]`
 * via `pathToFileURL` (and realpath when the argv path exists) so relative argv, symlink
 * installs, and Windows drive letters still match — `file://${argv[1]}` string equality does not.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isDirectInvocation(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1.length === 0) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    try {
      return metaUrl === pathToFileURL(argv1).href;
    } catch {
      return false;
    }
  }
}
