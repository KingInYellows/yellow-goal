import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliUsageError, ObservedFixtureError } from './errors';
import { sha256Hex, runtimeLabel, type RuntimeLabel } from './implementation-revision';
import type { FixtureDecision } from './observed-fixture-decider';
import type { ObservedCheckOutcome } from './observed-fixture-observer';
import {
  CommittedSourceSchemaVersion,
  type CommittedSourceProfile,
} from './committed-source-profiles';
import type { CapturedBlob, CapturedBlobWithBytes, SourceCanary } from './committed-source-git';
import { CandidateFileContentSchemaVersion } from './candidate-offline-profiles';

export const BUNDLE_COMPLETE_MARKER = 'COMPLETE';
export const BUNDLE_MANIFEST_NAME = 'manifest.json';
export const BUNDLE_BLOBS_DIR = 'blobs';

export type SelectedBlob = {
  path: string;
  mode: string;
  sha256: string;
  byteLength: number;
};

export type CaptureOverlay = {
  schemaVersion: typeof CandidateFileContentSchemaVersion;
  files: Record<string, string>;
};

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
    selected: SelectedBlob[];
    overlay: CaptureOverlay | null;
  };
  exclusions: ['dirty', 'staged', 'untracked', 'ignored'];
  sourceIntegrity: SourceCanary & { mutated: boolean };
  bindings: { id: string; command: string; cwd: string }[];
  outcomes: ObservedCheckOutcome[];
  recorder: null;
  decision: FixtureDecision;
};

export function selectedFromBlobs(blobs: CapturedBlobWithBytes[]): SelectedBlob[] {
  return blobs.map((blob) => ({
    path: blob.path,
    mode: blob.mode,
    sha256: blob.sha256,
    byteLength: blob.byteLength,
  }));
}

export function buildCommittedSourceBundle(input: {
  profile: CommittedSourceProfile;
  digest: string;
  implementationRevision: string;
  requestedRev: string;
  commit: string;
  captured: CapturedBlob[];
  missing: string[];
  selected: SelectedBlob[];
  overlay: CaptureOverlay | null;
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
      selected: input.selected,
      overlay: input.overlay,
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

export function persistCommittedSourceBundle(
  dir: string,
  bundle: CommittedSourceBundle,
  blobs: CapturedBlobWithBytes[],
): void {
  requireEmptyDirectory(dir);
  const allowed = new Set(bundle.source.selected.map((row) => row.path));
  for (const blob of blobs) {
    if (!allowed.has(blob.path)) {
      throw new ObservedFixtureError('BUNDLE_INVALID', `refusing to persist blob outside selected set: ${blob.path}`);
    }
    assertBundleBlobPath(blob.path);
    const full = path.join(dir, BUNDLE_BLOBS_DIR, blob.path);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, blob.contents);
  }
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

function assertBundleBlobPath(relative: string): void {
  if (relative === '' || relative.startsWith('/') || relative.includes('\0') || relative.includes('\\')) {
    throw new ObservedFixtureError('BUNDLE_INVALID', `unsafe persisted blob path: ${relative}`);
  }
  const parts = relative.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new ObservedFixtureError('BUNDLE_INVALID', `unsafe persisted blob path: ${relative}`);
  }
}

export function peekCompleteMarker(dir: string): string | undefined {
  const markerPath = path.join(dir, BUNDLE_COMPLETE_MARKER);
  try {
    const stat = lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return readFileSync(markerPath, 'utf8').replace(/\n$/, '');
  } catch {
    return undefined;
  }
}

export function bundleComplete(dir: string): boolean {
  return peekCompleteMarker(dir) === CommittedSourceSchemaVersion;
}

export function readPersistedCommittedSourceBundle(
  dir: string,
): CommittedSourceBundle & { blobs: CapturedBlobWithBytes[] } {
  if (!bundleComplete(dir)) {
    throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `bundle is missing ${BUNDLE_COMPLETE_MARKER}: ${dir}`);
  }
  const raw = readFileSync(path.join(dir, BUNDLE_MANIFEST_NAME), 'utf8');
  const parsed = JSON.parse(raw) as CommittedSourceBundle;
  if (parsed.schemaVersion !== CommittedSourceSchemaVersion) {
    throw new ObservedFixtureError('BUNDLE_INVALID', 'unexpected committed-source bundle schemaVersion');
  }
  if (!Array.isArray(parsed.source?.selected)) {
    throw new ObservedFixtureError('BUNDLE_INCOMPLETE', 'capture bundle is missing selected blob metadata');
  }
  const capturedByPath = new Map(parsed.source.captured.map((row) => [row.path, row]));
  const blobs: CapturedBlobWithBytes[] = [];
  for (const selected of parsed.source.selected) {
    assertBundleBlobPath(selected.path);
    const full = path.join(dir, BUNDLE_BLOBS_DIR, selected.path);
    let contents: Buffer;
    try {
      const stat = lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob is not a regular file: ${selected.path}`);
      }
      contents = readFileSync(full);
    } catch (err) {
      if (err instanceof ObservedFixtureError) throw err;
      throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob missing: ${selected.path}`);
    }
    if (contents.length !== selected.byteLength || sha256Hex(contents) !== selected.sha256) {
      throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob bytes do not match manifest: ${selected.path}`);
    }
    const pinned = capturedByPath.get(selected.path);
    blobs.push({
      path: selected.path,
      mode: selected.mode,
      type: 'blob',
      gitSha: pinned?.gitSha ?? '0'.repeat(40),
      sha256: selected.sha256,
      byteLength: selected.byteLength,
      contents,
    });
  }
  return { ...parsed, blobs };
}
