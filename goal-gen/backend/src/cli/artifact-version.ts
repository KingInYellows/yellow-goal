import { readFile } from 'node:fs/promises';

/** The package artifact identity, shared by version and offline discovery. */
export async function readArtifactVersion(): Promise<string> {
  const raw = await readFile(new URL('../../../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json has no version — cannot report engine identity');
  }
  return pkg.version;
}
