import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliUsageError, ObservedFixtureError } from './errors';
import {
  CandidateFileContentSchemaVersion,
  CandidateOfflineSchemaVersion,
  type CandidateFileDocument,
  type CandidateOfflineProfile,
} from './candidate-offline-profiles';
import { runtimeLabel } from './implementation-revision';
import type { FixtureDecision, RecorderInvocation } from './observed-fixture-decider';
import {
  REPRODUCIBLE_COMMIT_MESSAGE,
  REPRODUCIBLE_GIT_DATE,
  type ObservationResult,
  type ObservedCheckOutcome,
} from './observed-fixture-observer';

export const BUNDLE_COMPLETE_MARKER = 'COMPLETE';
export const BUNDLE_MANIFEST_NAME = 'manifest.json';

export type CandidateOfflineBundle = {
  schemaVersion: typeof CandidateOfflineSchemaVersion;
  implementationRevision: string;
  runtime: { node: string };
  profile: { id: string; version: string; digest: string };
  baseRecipe: {
    files: Record<string, string>;
    commitMessage: string;
    authorDate: string;
    committerDate: string;
    branch: 'main';
  };
  candidate: CandidateFileDocument;
  identities: {
    baseRevision: string;
    candidateIdentity: { kind: 'tree'; value: string };
    candidateTree: string;
  };
  changes: {
    overlay: Record<string, string>;
    diff: string;
    newFiles: string[];
  };
  bindings: { id: string; command: string; cwd: string }[];
  outcomes: ObservedCheckOutcome[];
  recorder: RecorderInvocation | null;
  decision: FixtureDecision;
  reproduction: { argv: string[] };
};

export function buildCandidateBundle(input: {
  profile: CandidateOfflineProfile;
  digest: string;
  implementationRevision: string;
  candidate: CandidateFileDocument;
  observation: ObservationResult;
  recorder: RecorderInvocation | null;
  decision: FixtureDecision;
}): CandidateOfflineBundle {
  const newFiles = Object.keys(input.candidate.files).filter(
    (relative) => !Object.prototype.hasOwnProperty.call(input.profile.baseFiles, relative),
  );
  return {
    schemaVersion: CandidateOfflineSchemaVersion,
    implementationRevision: input.implementationRevision,
    runtime: runtimeLabel(),
    profile: { id: input.profile.id, version: input.profile.version, digest: input.digest },
    baseRecipe: {
      files: input.profile.baseFiles,
      commitMessage: REPRODUCIBLE_COMMIT_MESSAGE,
      authorDate: REPRODUCIBLE_GIT_DATE,
      committerDate: REPRODUCIBLE_GIT_DATE,
      branch: 'main',
    },
    candidate: input.candidate,
    identities: {
      baseRevision: input.observation.baseRevision,
      candidateIdentity: { kind: 'tree', value: input.observation.candidateTree },
      candidateTree: input.observation.candidateTree,
    },
    changes: {
      overlay: input.observation.overlay,
      diff: input.observation.diff,
      newFiles,
    },
    bindings: input.profile.checks.map((check) => ({ id: check.id, command: check.command, cwd: check.cwd })),
    outcomes: input.observation.checks,
    recorder: input.recorder,
    decision: input.decision,
    reproduction: { argv: ['acceptance', 'reproduce'] },
  };
}

export function assertBundleDirWritable(raw: string): string {
  if (raw === '' || raw.startsWith('-')) {
    throw new CliUsageError('acceptance verify-candidate --bundle-dir requires a directory path');
  }
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root) {
    throw new CliUsageError('acceptance verify-candidate refuses to write a bundle at filesystem root');
  }
  return resolved;
}

export function persistCandidateBundle(dir: string, bundle: CandidateOfflineBundle): void {
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
    if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CliUsageError(`acceptance verify-candidate --bundle-dir must be an empty directory: ${dir}`);
    }
    if (readdirSync(dir).length > 0) {
      throw new CliUsageError(`acceptance verify-candidate refuses to overwrite a non-empty path: ${dir}`);
    }
    return;
  }
  mkdirSync(dir, { recursive: true });
}

export function bundleComplete(dir: string): boolean {
  const markerPath = path.join(dir, BUNDLE_COMPLETE_MARKER);
  try {
    const stat = lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return false;
    }
    return readFileSync(markerPath, 'utf8') === `${CandidateOfflineSchemaVersion}\n`;
  } catch {
    return false;
  }
}

export function readPersistedBundle(dir: string): CandidateOfflineBundle {
  if (!bundleComplete(dir)) {
    throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `bundle is missing ${BUNDLE_COMPLETE_MARKER}: ${dir}`);
  }
  const raw = readFileSync(path.join(dir, BUNDLE_MANIFEST_NAME), 'utf8');
  const parsed = JSON.parse(raw) as CandidateOfflineBundle;
  if (parsed.schemaVersion !== CandidateOfflineSchemaVersion) {
    throw new ObservedFixtureError('BUNDLE_INVALID', 'unexpected candidate-offline bundle schemaVersion');
  }
  if (parsed.candidate?.schemaVersion !== CandidateFileContentSchemaVersion) {
    throw new ObservedFixtureError('BUNDLE_INVALID', 'unexpected candidate document schemaVersion');
  }
  return parsed;
}
