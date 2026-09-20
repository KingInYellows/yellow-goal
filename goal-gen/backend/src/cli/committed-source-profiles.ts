import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex, trustedCheckerIdentity } from './implementation-revision';
import type { ObservedCheckSpec } from './observed-fixture-profiles';

const checksDir = path.dirname(fileURLToPath(import.meta.url)) + '/committed-source-checks';

export const CommittedSourceSchemaVersion = 'yellow-goal/committed-source-capture/v1' as const;

export const CAPTURE_MAX_FILES = 8;
export const CAPTURE_MAX_FILE_BYTES = 256 * 1024;
export const CAPTURE_MAX_DEPTH = 8;

export type CommittedSourceProfileId = 'package-manifest-lockfile';

export type CommittedSourceProfile = {
  id: CommittedSourceProfileId;
  version: string;
  timeoutMs: number;
  requiredCheckIds: string[];
  checks: ObservedCheckSpec[];
  allowedPaths: string[];
  maxFiles: number;
  maxFileBytes: number;
  maxDepth: number;
};

function nodeCheck(script: string): string[] {
  return [process.execPath, path.join(checksDir, script)];
}

function packageManifestLockfileProfile(): CommittedSourceProfile {
  const manifestLock: ObservedCheckSpec = {
    id: 'manifest-lock-agreement',
    argv: nodeCheck('manifest-lock-agreement.mjs'),
    command: 'committed-source:package-manifest-lockfile:manifest-lock-agreement',
    cwd: '.',
  };
  const packaging: ObservedCheckSpec = {
    id: 'packaging-entry',
    argv: nodeCheck('packaging-entry.mjs'),
    command: 'committed-source:package-manifest-lockfile:packaging-entry',
    cwd: '.',
  };
  return {
    id: 'package-manifest-lockfile',
    version: '1',
    timeoutMs: 5_000,
    requiredCheckIds: [manifestLock.id, packaging.id],
    checks: [manifestLock, packaging],
    allowedPaths: ['goal-gen/package.json', 'goal-gen/package-lock.json', 'goal-gen/bin/goal-gen.mjs'],
    maxFiles: CAPTURE_MAX_FILES,
    maxFileBytes: CAPTURE_MAX_FILE_BYTES,
    maxDepth: CAPTURE_MAX_DEPTH,
  };
}

export function listCommittedSourceProfiles(): CommittedSourceProfile[] {
  return [packageManifestLockfileProfile()];
}

export function getCommittedSourceProfile(id: string): CommittedSourceProfile {
  const match = listCommittedSourceProfiles().find((profile) => profile.id === id);
  if (!match) {
    throw new Error(`unknown committed-source profile: ${id}`);
  }
  return match;
}

export function committedSourceProfileDigest(profile: CommittedSourceProfile): string {
  return sha256Hex(
    JSON.stringify({
      id: profile.id,
      version: profile.version,
      timeoutMs: profile.timeoutMs,
      requiredCheckIds: profile.requiredCheckIds,
      allowedPaths: profile.allowedPaths,
      maxFiles: profile.maxFiles,
      maxFileBytes: profile.maxFileBytes,
      maxDepth: profile.maxDepth,
      checkers: profile.checks.map(trustedCheckerIdentity),
    }),
  );
}
