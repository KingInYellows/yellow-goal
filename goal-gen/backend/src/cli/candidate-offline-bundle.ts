import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { CliUsageError, ObservedFixtureError } from './errors';
import { DIRECTORY_NOFOLLOW_FLAGS, O_NOFOLLOW_FLAG, pathThroughFd } from './fd-path';
import {
  CandidateFileContentSchemaVersion,
  CandidateOfflineSchemaVersion,
  type CandidateFileDocument,
  type CandidateOfflineProfile,
} from './candidate-offline-profiles';
import { runtimeLabel, type RuntimeLabel } from './implementation-revision';
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
  runtime: RuntimeLabel;
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

/**
 * Writes the bundle into `dir` for `acceptance verify-candidate --bundle-dir`: an absent `dir` is
 * created (with any missing parents), an existing one must be an empty real directory. The
 * directory is then opened `O_NOFOLLOW` once and every file is created through that descriptor with
 * `O_EXCL|O_NOFOLLOW` and fsynced, so a symlink swapped in for the directory or a planted file is
 * refused rather than followed or overwritten. `COMPLETE` is renamed into place last.
 */
export function persistCandidateBundle(dir: string, bundle: CandidateOfflineBundle): void {
  requireEmptyDirectory(dir);
  const dirFd = openSync(dir, DIRECTORY_NOFOLLOW_FLAGS);
  try {
    writeBundleInto(dirFd, dir, bundle);
  } finally {
    closeSync(dirFd);
  }
}

/**
 * The real-run bundle writer (AGX-R8a): `dir` must not exist, and its parent must still be the
 * canonical directory the manifest approved. The parent is opened and held `O_NOFOLLOW`, checked
 * against `path.dirname(dir)` through its descriptor, and the bundle directory is created (mode
 * 0700) and opened relative to that descriptor — so swapping the parent or an ancestor for a symlink
 * cannot redirect the write. The new directory must be owned by this user. After the write, the held
 * directory must still be the entry named `dir` under the still-approved parent (same dev/ino), so a
 * directory renamed away mid-write is reported rather than silently accepted. Throws on any mismatch.
 *
 * `heldParentFd`, when passed, is the reservation's parent descriptor. It is not closed here, and
 * the directory is created through it, so a replacement at the approved path is not written. That
 * path fails closed where `/proc/self/fd` is absent. Without a held descriptor the parent is opened
 * here; a rename after the final in-write check is still not detected.
 */
export function persistCandidateBundleExclusive(dir: string, bundle: CandidateOfflineBundle, heldParentFd?: number): void {
  const parent = path.dirname(dir);
  const ownsParent = heldParentFd === undefined;
  const parentFd = heldParentFd ?? openSync(parent, DIRECTORY_NOFOLLOW_FLAGS);
  try {
    const proc = `/proc/self/fd/${parentFd}`;
    if (!ownsParent && !existsSync(proc)) throw new Error(`bundle parent ${parent} cannot be written through its held descriptor`);
    const parentPath = ownsParent ? pathThroughFd(parentFd, parent) : proc;
    const heldParent = realpathSync(parentPath);
    if (heldParent !== parent) throw new Error(`bundle parent ${parent} now resolves to ${heldParent}`);
    const created = path.join(parentPath, path.basename(dir));
    mkdirSync(created, 0o700);
    const dirFd = openSync(created, DIRECTORY_NOFOLLOW_FLAGS);
    try {
      if (typeof process.getuid === 'function' && fstatSync(dirFd).uid !== process.getuid()) {
        throw new Error(`bundle directory ${dir} is not owned by this user`);
      }
      writeBundleInto(dirFd, dir, bundle);
      assertBundleBound(parentFd, parent, path.basename(dir), dirFd);
    } finally {
      closeSync(dirFd);
    }
    fsyncSync(parentFd);
  } finally {
    if (ownsParent) closeSync(parentFd);
  }
}

/**
 * Throws unless the held parent still resolves to `parent` and its entry `name` is the very
 * directory `dirFd` holds (same dev/ino).
 */
export function assertBundleBound(parentFd: number, parent: string, name: string, dirFd: number): void {
  const parentPath = pathThroughFd(parentFd, parent);
  const held = realpathSync(parentPath);
  if (held !== parent) throw new Error(`bundle parent ${parent} now resolves to ${held}`);
  const named = lstatSync(path.join(parentPath, name));
  const opened = fstatSync(dirFd);
  if (named.dev !== opened.dev || named.ino !== opened.ino) {
    throw new Error(`bundle directory ${path.join(parent, name)} was replaced or renamed during the write`);
  }
}

function writeBundleInto(dirFd: number, dir: string, bundle: CandidateOfflineBundle): void {
  const root = pathThroughFd(dirFd, realpathSync(dir));
  const markerTmp = `${BUNDLE_COMPLETE_MARKER}.tmp`;
  writeChildExclusive(root, BUNDLE_MANIFEST_NAME, `${JSON.stringify(bundle, null, 2)}\n`);
  writeChildExclusive(root, markerTmp, `${bundle.schemaVersion}\n`);
  renameSync(path.join(root, markerTmp), path.join(root, BUNDLE_COMPLETE_MARKER));
  fsyncSync(dirFd);
}

function writeChildExclusive(root: string, name: string, data: string): void {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW_FLAG;
  const fd = openSync(path.join(root, name), flags, 0o644);
  try {
    writeFileSync(fd, data, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
