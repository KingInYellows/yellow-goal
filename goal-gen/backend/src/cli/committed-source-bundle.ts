import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliUsageError, ObservedFixtureError } from './errors';
import { runtimeLabel, type RuntimeLabel } from './implementation-revision';
import type { FixtureDecision } from './observed-fixture-decider';
import type { ObservedCheckOutcome } from './observed-fixture-observer';
import {
  CommittedSourceSchemaVersion,
  type CommittedSourceProfile,
} from './committed-source-profiles';
import type { CapturedBlob, SourceCanary } from './committed-source-git';

export const BUNDLE_COMPLETE_MARKER = 'COMPLETE';
export const BUNDLE_MANIFEST_NAME = 'manifest.json';

export type CommittedSourceBundle = {
  schemaVersion: typeof CommittedSourceSchemaVersion;
  implementationRevision: string;
  runtime: RuntimeLabel;
  profile: { id: string; version: string; digest: string };
  source: {
    requestedRev: string;
    commit: string;
    captured: CapturedBlob[];
    missing: string[];
  };
  exclusions: ['dirty', 'staged', 'untracked', 'ignored'];
  sourceIntegrity: SourceCanary & { mutated: boolean };
  bindings: { id: string; command: string; cwd: string }[];
  outcomes: ObservedCheckOutcome[];
  recorder: null;
  decision: FixtureDecision;
};

export function buildCommittedSourceBundle(input: {
  profile: CommittedSourceProfile;
  digest: string;
  implementationRevision: string;
  requestedRev: string;
  commit: string;
  captured: CapturedBlob[];
  missing: string[];
  canary: SourceCanary;
  mutated: boolean;
  outcomes: ObservedCheckOutcome[];
  decision: FixtureDecision;
}): CommittedSourceBundle {
  return {
    schemaVersion: CommittedSourceSchemaVersion,
    implementationRevision: input.implementationRevision,
    runtime: runtimeLabel(),
    profile: { id: input.profile.id, version: input.profile.version, digest: input.digest },
    source: {
      requestedRev: input.requestedRev,
      commit: input.commit,
      captured: input.captured,
      missing: input.missing,
    },
    exclusions: ['dirty', 'staged', 'untracked', 'ignored'],
    sourceIntegrity: { ...input.canary, mutated: input.mutated },
    bindings: input.profile.checks.map((check) => ({ id: check.id, command: check.command, cwd: check.cwd })),
    outcomes: input.outcomes,
    recorder: null,
    decision: input.decision,
  };
}

export function assertBundleDirWritable(raw: string): string {
  if (raw === '' || raw.startsWith('-')) {
    throw new CliUsageError('acceptance capture-source --bundle-dir requires a directory path');
  }
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root) {
    throw new CliUsageError('acceptance capture-source refuses to write a bundle at filesystem root');
  }
  return resolved;
}

export function persistCommittedSourceBundle(dir: string, bundle: CommittedSourceBundle): void {
  requireEmptyDirectory(dir);
  const manifestPath = path.join(dir, BUNDLE_MANIFEST_NAME);
  const markerPath = path.join(dir, BUNDLE_COMPLETE_MARKER);
  const markerTmp = `${markerPath}.tmp`;
  writeFileSync(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  writeFileSync(markerTmp, `${bundle.schemaVersion}\n`, 'utf8');
  renameSync(markerTmp, markerPath);
}

function requireEmptyDirectory(dir: string): void {
  if (existsSync(dir)) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CliUsageError(`acceptance capture-source --bundle-dir must be an empty directory: ${dir}`);
    }
    if (readdirSync(dir).length > 0) {
      throw new CliUsageError(`acceptance capture-source refuses to overwrite a non-empty path: ${dir}`);
    }
    return;
  }
  mkdirSync(dir, { recursive: true });
}

export function bundleComplete(dir: string): boolean {
  const markerPath = path.join(dir, BUNDLE_COMPLETE_MARKER);
  try {
    const stat = lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    return readFileSync(markerPath, 'utf8') === `${CommittedSourceSchemaVersion}\n`;
  } catch {
    return false;
  }
}

export function readPersistedCommittedSourceBundle(dir: string): CommittedSourceBundle {
  if (!bundleComplete(dir)) {
    throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `bundle is missing ${BUNDLE_COMPLETE_MARKER}: ${dir}`);
  }
  const raw = readFileSync(path.join(dir, BUNDLE_MANIFEST_NAME), 'utf8');
  const parsed = JSON.parse(raw) as CommittedSourceBundle;
  if (parsed.schemaVersion !== CommittedSourceSchemaVersion) {
    throw new ObservedFixtureError('BUNDLE_INVALID', 'unexpected committed-source bundle schemaVersion');
  }
  return parsed;
}
