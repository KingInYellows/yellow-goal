import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { CliUsageError, ObservedFixtureError } from './errors';
import { gitBlobSha1, sha256Hex, runtimeLabel, type RuntimeLabel } from './implementation-revision';
import type { FixtureDecision } from './observed-fixture-decider';
import { OBSERVER_OUTPUT_LIMIT } from './observed-fixture-child';
import type { ObservedCheckOutcome } from './observed-fixture-observer';
import {
  CANDIDATE_MAX_DEPTH,
  CANDIDATE_MAX_DOCUMENT_BYTES,
  CANDIDATE_MAX_FILE_BYTES,
  CANDIDATE_MAX_FILES,
  CandidateFileContentSchemaVersion,
  CandidateOfflineSchemaVersion,
} from './candidate-offline-profiles';
import { assertSafeCandidatePath } from './candidate-offline-command';
import {
  assertCapturedRowsMatchRecordedCommit,
  filesystemModeForBlob,
  parseStoredSourceIdentity,
  type CapturedBlob,
  type CapturedBlobWithBytes,
  type SourceCanary,
  type SourceIdentity,
} from './committed-source-git';
import {
  CAPTURE_MAX_FILE_BYTES,
  CAPTURE_MAX_FILES,
  CommittedSourceSchemaVersion,
  committedSourceProfileDigest,
  getCommittedSourceProfile,
  type CommittedSourceProfile,
} from './committed-source-profiles';

export const BUNDLE_COMPLETE_MARKER = 'COMPLETE';
export const BUNDLE_MANIFEST_NAME = 'manifest.json';
export const BUNDLE_BLOBS_DIR = 'blobs';
/** Envelope + overlay document + two-check stdout/stderr. Bound before JSON.parse. */
export const CAPTURE_MANIFEST_MAX_BYTES =
  CANDIDATE_MAX_DOCUMENT_BYTES + CAPTURE_MAX_FILES * 4096 + 4 * OBSERVER_OUTPUT_LIMIT + 32 * 1024;

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
    identity?: SourceIdentity;
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
  identity?: SourceIdentity;
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
      ...(input.identity !== undefined ? { identity: input.identity } : {}),
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

export function assertFromCaptureDir(raw: string): string {
  if (raw === '' || raw.startsWith('-')) {
    throw new CliUsageError('acceptance verify-candidate --from-capture requires a bundle directory');
  }
  return path.resolve(raw);
}

const CAPTURE_COMPLETE_BYTES = `${CommittedSourceSchemaVersion}\n`;
const OFFLINE_COMPLETE_BYTES = `${CandidateOfflineSchemaVersion}\n`;

function installedCaptureProfile(id: string): CommittedSourceProfile {
  try {
    return getCommittedSourceProfile(id);
  } catch {
    throw new CliUsageError(`unknown committed-source profile in bundle: ${id}`);
  }
}

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ZERO_GIT_OBJECT_ID = '0'.repeat(40);

export function assertPersistedOverlayValues(overlay: CaptureOverlay | null | undefined): void {
  if (overlay === null || overlay === undefined) return;
  if (typeof overlay !== 'object' || Array.isArray(overlay)) {
    throw new ObservedFixtureError('BUNDLE_INVALID', 'overlay files must be a path map');
  }
  if (overlay.schemaVersion !== CandidateFileContentSchemaVersion) {
    throw new ObservedFixtureError('BUNDLE_INVALID', 'unexpected overlay schemaVersion');
  }
  if (overlay.files === null || typeof overlay.files !== 'object' || Array.isArray(overlay.files)) {
    throw new ObservedFixtureError('BUNDLE_INVALID', 'overlay files must be a path map');
  }
  const entries = Object.entries(overlay.files);
  if (entries.length > CANDIDATE_MAX_FILES) {
    throw new ObservedFixtureError('BUNDLE_INVALID', 'overlay exceeds maxFiles');
  }
  for (const [relative, text] of entries) {
    if (typeof text !== 'string') {
      throw new ObservedFixtureError('BUNDLE_INVALID', `overlay value is not a string: ${relative}`);
    }
    if (Buffer.byteLength(text, 'utf8') > CANDIDATE_MAX_FILE_BYTES) {
      throw new ObservedFixtureError('BUNDLE_INVALID', `overlay value exceeds maxFileBytes: ${relative}`);
    }
    try {
      assertSafeCandidatePath(relative, {
        maxFiles: CANDIDATE_MAX_FILES,
        maxFileBytes: CANDIDATE_MAX_FILE_BYTES,
        maxDepth: CANDIDATE_MAX_DEPTH,
      });
    } catch (err) {
      if (err instanceof CliUsageError) {
        throw new ObservedFixtureError('BUNDLE_INVALID', `overlay path is unsafe: ${relative}`);
      }
      throw err;
    }
  }
}

function overlayedPathSet(overlay: CaptureOverlay | null | undefined): Set<string> {
  assertPersistedOverlayValues(overlay);
  if (overlay === null || overlay === undefined || typeof overlay !== 'object') {
    return new Set();
  }
  const files = overlay.files;
  if (files === null || files === undefined || typeof files !== 'object' || Array.isArray(files)) {
    return new Set();
  }
  return new Set(Object.keys(files));
}

function pinnedCapturedIdentity(
  selected: SelectedBlob,
  capturedByPath: Map<string, CapturedBlob>,
): CapturedBlob {
  const pinned = capturedByPath.get(selected.path);
  if (
    pinned === undefined ||
    pinned.type !== 'blob' ||
    pinned.mode !== selected.mode ||
    typeof pinned.gitSha !== 'string' ||
    !GIT_OBJECT_ID.test(pinned.gitSha) ||
    pinned.gitSha === ZERO_GIT_OBJECT_ID ||
    typeof pinned.sha256 !== 'string' ||
    !SHA256_HEX.test(pinned.sha256) ||
    typeof pinned.byteLength !== 'number' ||
    !Number.isInteger(pinned.byteLength) ||
    pinned.byteLength < 0
  ) {
    throw new ObservedFixtureError(
      'BUNDLE_INVALID',
      `selected blob is missing captured identity: ${selected.path}`,
    );
  }
  filesystemModeForBlob(selected.mode);
  filesystemModeForBlob(pinned.mode);
  return pinned;
}

function assertUnoverlaidSelectedMatchesCaptured(
  selected: SelectedBlob,
  pinned: CapturedBlob,
  contents: Buffer,
): void {
  if (
    selected.sha256 !== pinned.sha256 ||
    selected.byteLength !== pinned.byteLength ||
    gitBlobSha1(contents) !== pinned.gitSha
  ) {
    throw new ObservedFixtureError(
      'BUNDLE_INVALID',
      `selected blob does not match captured identity: ${selected.path}`,
    );
  }
}

function parseCapturedRow(row: unknown): CapturedBlob {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new ObservedFixtureError('BUNDLE_INVALID', 'captured blob row is invalid');
  }
  const rec = row as Record<string, unknown>;
  if (typeof rec.path !== 'string' || rec.path === '') {
    throw new ObservedFixtureError('BUNDLE_INVALID', 'captured blob row is invalid');
  }
  if (
    rec.type !== 'blob' ||
    typeof rec.mode !== 'string' ||
    typeof rec.gitSha !== 'string' ||
    !GIT_OBJECT_ID.test(rec.gitSha) ||
    rec.gitSha === ZERO_GIT_OBJECT_ID ||
    typeof rec.sha256 !== 'string' ||
    !SHA256_HEX.test(rec.sha256) ||
    typeof rec.byteLength !== 'number' ||
    !Number.isInteger(rec.byteLength) ||
    rec.byteLength < 0
  ) {
    throw new ObservedFixtureError('BUNDLE_INVALID', `captured blob row is invalid: ${rec.path}`);
  }
  filesystemModeForBlob(rec.mode);
  assertBundleBlobPath(rec.path);
  return {
    path: rec.path,
    mode: rec.mode,
    type: 'blob',
    gitSha: rec.gitSha,
    sha256: rec.sha256,
    byteLength: rec.byteLength,
  };
}

function assertSelectedCapturedMetadata(
  selected: readonly SelectedBlob[],
  captured: unknown,
): Map<string, CapturedBlob> {
  if (!Array.isArray(captured)) {
    throw new ObservedFixtureError('BUNDLE_INVALID', 'capture bundle is missing captured blob metadata');
  }
  const capturedByPath = new Map<string, CapturedBlob>();
  const seen = new Set<string>();
  for (const row of captured) {
    const parsed = parseCapturedRow(row);
    if (seen.has(parsed.path)) {
      throw new ObservedFixtureError('BUNDLE_INVALID', `duplicate captured blob path: ${parsed.path}`);
    }
    seen.add(parsed.path);
    capturedByPath.set(parsed.path, parsed);
  }
  const selectedPaths = new Set(selected.map((row) => row.path));
  for (const capturedPath of capturedByPath.keys()) {
    if (!selectedPaths.has(capturedPath)) {
      throw new ObservedFixtureError(
        'BUNDLE_INVALID',
        `captured blob path is not selected: ${capturedPath}`,
      );
    }
  }
  for (const row of selected) {
    pinnedCapturedIdentity(row, capturedByPath);
  }
  return capturedByPath;
}

function assertSelectedHardCaps(selected: readonly SelectedBlob[]): void {
  if (selected.length > CAPTURE_MAX_FILES) {
    throw new ObservedFixtureError(
      'BUNDLE_INVALID',
      `selected blob count exceeds maxFiles (${CAPTURE_MAX_FILES})`,
    );
  }
  const seen = new Set<string>();
  for (const row of selected) {
    assertBundleBlobPath(row.path);
    if (seen.has(row.path)) {
      throw new ObservedFixtureError('BUNDLE_INVALID', `duplicate selected blob path: ${row.path}`);
    }
    seen.add(row.path);
  }
}

function assertSelectedInstalledPolicy(
  selected: readonly SelectedBlob[],
  profile: { allowedPaths: readonly string[]; maxFiles: number },
): void {
  if (selected.length > profile.maxFiles) {
    throw new ObservedFixtureError(
      'BUNDLE_INVALID',
      `selected blob count exceeds maxFiles (${profile.maxFiles})`,
    );
  }
  const allowed = new Set(profile.allowedPaths);
  for (const row of selected) {
    if (!allowed.has(row.path)) {
      throw new ObservedFixtureError(
        'BUNDLE_INVALID',
        `selected blob path is not in the installed profile allowlist: ${row.path}`,
      );
    }
  }
}

function installedPolicyApplies(bundle: CommittedSourceBundle, profile: CommittedSourceProfile): boolean {
  return bundle.profile.digest === committedSourceProfileDigest(profile);
}

export function persistCommittedSourceBundle(
  dir: string,
  bundle: CommittedSourceBundle,
  blobs: CapturedBlobWithBytes[],
  recheckOpened?: (openedRoot: string) => void,
): void {
  // Open dest as a directory and write through that handle. A dest-ancestor
  // rename+symlink after dest readdir must not persist COMPLETE into source
  // through the original pathname. Missing dest is created relative to an
  // already-opened parent handle so mkdir cannot follow a swapped ancestor.
  // Dest children (blobs/, nested dirs, leaves, COMPLETE.tmp) are opened or
  // created the same way with O_NOFOLLOW so a dest/blobs symlink is not
  // followed into the captured source. Dest and dest children are held from
  // write time. After COMPLETE is written, require destFd still is the
  // caller --bundle-dir via lstat (not a dest-dir pathname reopen) and that
  // destFd COMPLETE/manifest/blobs still are the held inodes — dest renamed
  // aside with an empty directory put back at the caller path cannot report
  // success while COMPLETE is only at aside, and dest children renamed into
  // the source cannot report success with dest having only COMPLETE. A
  // dest-dir pathname reopen after children exist holds the original dest
  // inode across dest-move, so destFd vs that fd would match after dest is
  // stolen. Missing destFd names are restored from held descriptors then
  // rolled back when destFd still is the caller path. Failed persist rolls
  // back COMPLETE, blobs, and manifest through the dest fd so a dest inode
  // moved into the captured source after dest open cannot leave those
  // artifacts there.
  const opened = openEmptyPersistDirectory(dir);
  try {
    try {
      recheckOpened?.(opened.root);
      const profile = installedCaptureProfile(bundle.profile.id);
      assertSelectedHardCaps(bundle.source.selected);
      for (const row of bundle.source.selected) {
        filesystemModeForBlob(row.mode);
      }
      for (const blob of blobs) {
        filesystemModeForBlob(blob.mode);
      }
      if (installedPolicyApplies(bundle, profile)) {
        assertSelectedInstalledPolicy(bundle.source.selected, profile);
      }
      const allowed = new Set(bundle.source.selected.map((row) => row.path));
      for (const blob of blobs) {
        if (!allowed.has(blob.path)) {
          throw new ObservedFixtureError('BUNDLE_INVALID', `refusing to persist blob outside selected set: ${blob.path}`);
        }
        assertBundleBlobPath(blob.path);
        persistBlobTree(opened.fd, blob.path, blob.contents, dir);
      }
      persistWriteLeaf(opened.fd, BUNDLE_MANIFEST_NAME, `${JSON.stringify(bundle, null, 2)}\n`, dir);
      const heldBlobs = openSync(
        persistChildPath(opened.fd, BUNDLE_BLOBS_DIR, dir),
        persistDirectoryFlags(),
      );
      let heldManifest: number | undefined;
      let heldComplete: number | undefined;
      try {
        heldManifest = openSync(
          persistChildPath(opened.fd, BUNDLE_MANIFEST_NAME, dir),
          persistFileFlags(),
        );
        persistWriteLeaf(opened.fd, `${BUNDLE_COMPLETE_MARKER}.tmp`, CAPTURE_COMPLETE_BYTES, dir);
        renameSync(
          persistChildPath(opened.fd, `${BUNDLE_COMPLETE_MARKER}.tmp`, dir),
          persistChildPath(opened.fd, BUNDLE_COMPLETE_MARKER, dir),
        );
        heldComplete = openSync(
          persistChildPath(opened.fd, BUNDLE_COMPLETE_MARKER, dir),
          persistFileFlags(),
        );
        assertPersistDestStillCallerPath(opened.fd, dir, {
          complete: heldComplete,
          manifest: heldManifest,
          blobs: heldBlobs,
        });
      } catch (err) {
        // Restore only when destFd still is the caller --bundle-dir (lstat,
        // not a dest-dir pathname reopen). Dest moved into source keeps
        // destFd pointing at the stolen inode — restoring there would put
        // leftover back into the source before dest-fd rollback. Dest
        // children stolen from destFd while dest still sits at the caller
        // path are restored then rolled back.
        if (persistDestFdStillCallerPath(opened.fd, dir)) {
          restoreMissingHeldPersistChildren(
            opened.fd,
            { complete: heldComplete ?? -1, manifest: heldManifest ?? -1, blobs: heldBlobs },
            dir,
          );
        }
        rollbackPersistWrites(opened.fd, dir);
        if (opened.created) {
          try {
            rmdirSync(opened.root);
          } catch {
            // dest may already be gone
          }
        }
        throw err;
      } finally {
        closeHeldPersistChildren({
          complete: heldComplete ?? -1,
          manifest: heldManifest ?? -1,
          blobs: heldBlobs,
        });
      }
    } catch (err) {
      rollbackPersistWrites(opened.fd, dir);
      if (opened.created) {
        try {
          rmdirSync(opened.root);
        } catch {
          // dest may already be gone
        }
      }
      throw err;
    }
  } finally {
    closeSync(opened.fd);
  }
}

function persistDirectoryFlags(): number {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  return fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | noFollow;
}

function persistRootForFd(fd: number, dir: string): string {
  const proc = `/proc/self/fd/${fd}`;
  return existsSync(proc) ? proc : realpathSync(dir);
}

function persistFileFlags(): number {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const nonblock = fsConstants.O_NONBLOCK ?? 0;
  return fsConstants.O_RDONLY | noFollow | nonblock;
}

function persistWriteFileFlags(): number {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
}

function assertPersistChildName(name: string, dir: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw emptyPersistUsage(dir);
  }
}

function persistChildPath(parentFd: number, name: string, dir: string): string {
  assertPersistChildName(name, dir);
  const proc = `/proc/self/fd/${parentFd}`;
  if (!existsSync(proc)) {
    throw emptyPersistUsage(dir);
  }
  return path.join(proc, name);
}

function rollbackPersistWrites(dirFd: number, dir: string): void {
  for (const name of [
    `${BUNDLE_COMPLETE_MARKER}.tmp`,
    BUNDLE_COMPLETE_MARKER,
    BUNDLE_MANIFEST_NAME,
    BUNDLE_BLOBS_DIR,
  ]) {
    try {
      rmSync(persistChildPath(dirFd, name, dir), { recursive: true, force: true });
    } catch {
      // dest child may already be gone or dest unlinked
    }
  }
}

function persistWriteAll(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    const n = writeSync(fd, buf, offset, buf.length - offset);
    if (n <= 0) {
      throw new ObservedFixtureError('BUNDLE_INVALID', 'persist write truncated');
    }
    offset += n;
  }
}

function persistOpenDirChild(parentFd: number, name: string, dir: string): number {
  const flags = persistDirectoryFlags();
  const child = persistChildPath(parentFd, name, dir);
  try {
    return openSync(child, flags);
  } catch (err) {
    if (fsErrorCode(err) !== 'ENOENT') {
      throw emptyPersistUsage(dir);
    }
  }
  try {
    mkdirSync(child);
  } catch {
    throw emptyPersistUsage(dir);
  }
  try {
    return openSync(child, flags);
  } catch {
    try {
      rmdirSync(child);
    } catch {
      // dest child may already be gone
    }
    throw emptyPersistUsage(dir);
  }
}

function persistWriteLeaf(parentFd: number, name: string, contents: Buffer | string, dir: string): void {
  const flags = persistWriteFileFlags();
  const leaf = persistChildPath(parentFd, name, dir);
  const buf = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
  let fd: number;
  try {
    fd = openSync(leaf, flags);
  } catch {
    throw emptyPersistUsage(dir);
  }
  try {
    persistWriteAll(fd, buf);
  } finally {
    closeSync(fd);
  }
}

function persistBlobTree(destFd: number, relative: string, contents: Buffer, dir: string): void {
  const parts = relative.split('/');
  const extras: number[] = [];
  try {
    let parentFd = persistOpenDirChild(destFd, BUNDLE_BLOBS_DIR, dir);
    extras.push(parentFd);
    for (const part of parts.slice(0, -1)) {
      parentFd = persistOpenDirChild(parentFd, part, dir);
      extras.push(parentFd);
    }
    const leafName = parts[parts.length - 1];
    if (leafName === undefined) {
      throw emptyPersistUsage(dir);
    }
    persistWriteLeaf(parentFd, leafName, contents, dir);
  } finally {
    for (let i = extras.length - 1; i >= 0; i--) {
      try {
        closeSync(extras[i]!);
      } catch {
        // already closed
      }
    }
  }
}

function fsErrorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return undefined;
}

function emptyPersistUsage(dir: string): CliUsageError {
  return new CliUsageError(`acceptance capture-source --bundle-dir must be an empty directory: ${dir}`);
}

type HeldPersistChildren = {
  complete: number;
  manifest: number;
  blobs: number;
};

function closeHeldPersistChildren(held: HeldPersistChildren): void {
  for (const fd of [held.complete, held.manifest, held.blobs]) {
    if (fd < 0) continue;
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
}

function persistDestFdStillCallerPath(dirFd: number, dir: string): boolean {
  try {
    const opened = fstatSync(dirFd);
    const atPath = lstatSync(path.resolve(dir));
    return (
      opened.isDirectory() &&
      atPath.isDirectory() &&
      !atPath.isSymbolicLink() &&
      opened.dev === atPath.dev &&
      opened.ino === atPath.ino
    );
  } catch {
    return false;
  }
}

function restoreHeldPersistChild(dirFd: number, heldFd: number, name: string, dir: string): void {
  if (heldFd < 0) return;
  const current = realpathSync(`/proc/self/fd/${heldFd}`);
  renameSync(current, persistChildPath(dirFd, name, dir));
}

function restoreMissingHeldPersistChildren(
  dirFd: number,
  held: HeldPersistChildren,
  dir: string,
): void {
  for (const [heldFd, name, flags] of [
    [held.complete, BUNDLE_COMPLETE_MARKER, persistFileFlags()],
    [held.manifest, BUNDLE_MANIFEST_NAME, persistFileFlags()],
    [held.blobs, BUNDLE_BLOBS_DIR, persistDirectoryFlags()],
  ] as const) {
    if (heldFd < 0) continue;
    let destChild: number | undefined;
    try {
      destChild = openSync(persistChildPath(dirFd, name, dir), flags);
    } catch {
      try {
        restoreHeldPersistChild(dirFd, heldFd, name, dir);
      } catch {
        // dest child may already be unlinked
      }
      continue;
    }
    try {
      closeSync(destChild);
    } catch {
      // already closed
    }
  }
}

function assertHeldChildStillAtDest(
  dirFd: number,
  heldFd: number,
  name: string,
  dir: string,
  expectDirectory: boolean,
): void {
  const flags = expectDirectory ? persistDirectoryFlags() : persistFileFlags();
  const heldStat = fstatSync(heldFd);
  if (heldStat.isDirectory() !== expectDirectory || heldStat.isFile() === expectDirectory) {
    throw emptyPersistUsage(dir);
  }
  let destChild: number | undefined;
  try {
    destChild = openSync(persistChildPath(dirFd, name, dir), flags);
  } catch {
    throw emptyPersistUsage(dir);
  }
  try {
    const destStat = fstatSync(destChild);
    if (destStat.dev !== heldStat.dev || destStat.ino !== heldStat.ino) {
      throw emptyPersistUsage(dir);
    }
  } finally {
    closeSync(destChild);
  }
}

function assertPersistDestStillCallerPath(
  dirFd: number,
  dir: string,
  held: HeldPersistChildren,
): void {
  // Do not reopen dest by pathname once children exist. A dest-dir
  // pathname fd stays the original dest inode after dest is renamed, so
  // destFd vs that fd would match after dest-move leftover. lstat of the
  // caller path is the dest that is still at --bundle-dir.
  if (!persistDestFdStillCallerPath(dirFd, dir)) {
    throw emptyPersistUsage(dir);
  }
  if (peekCompleteMarkerFromOpened(dirFd, dir) !== CommittedSourceSchemaVersion) {
    throw emptyPersistUsage(dir);
  }
  for (const [heldFd, name, expectDirectory] of [
    [held.complete, BUNDLE_COMPLETE_MARKER, false],
    [held.manifest, BUNDLE_MANIFEST_NAME, false],
    [held.blobs, BUNDLE_BLOBS_DIR, true],
  ] as const) {
    assertHeldChildStillAtDest(dirFd, heldFd, name, dir, expectDirectory);
  }
}

function finishEmptyPersistDirectory(
  fd: number,
  dir: string,
  created: boolean,
): { fd: number; root: string; created: boolean } {
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) {
      throw emptyPersistUsage(dir);
    }
    const root = persistRootForFd(fd, dir);
    if (readdirSync(root).length > 0) {
      throw new CliUsageError(`acceptance capture-source refuses to overwrite a non-empty path: ${dir}`);
    }
    return { fd, root, created };
  } catch (err) {
    if (created) {
      try {
        rmdirSync(persistRootForFd(fd, dir));
      } catch {
        // dest may already be gone
      }
    }
    closeSync(fd);
    throw err;
  }
}

function openEmptyPersistDirectory(dir: string): { fd: number; root: string; created: boolean } {
  const flags = persistDirectoryFlags();
  const resolved = path.resolve(dir);
  try {
    const fd = openSync(resolved, flags);
    return finishEmptyPersistDirectory(fd, resolved, false);
  } catch (err) {
    if (fsErrorCode(err) !== 'ENOENT') {
      throw emptyPersistUsage(dir);
    }
  }
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    const name = path.basename(current);
    const parentPath = path.dirname(current);
    if (name === '' || name === '.' || name === '..' || parentPath === current) {
      throw emptyPersistUsage(dir);
    }
    missing.push(name);
    let parentFd: number;
    try {
      parentFd = openSync(parentPath, flags);
    } catch (err) {
      if (fsErrorCode(err) !== 'ENOENT') {
        throw emptyPersistUsage(dir);
      }
      current = parentPath;
      continue;
    }
    let childFd: number | undefined;
    let created = false;
    let fallback = parentPath;
    try {
      for (let i = missing.length - 1; i >= 0; i--) {
        const childName = missing[i];
        if (childName === undefined) {
          throw emptyPersistUsage(dir);
        }
        const child = persistChildPath(parentFd, childName, dir);
        try {
          childFd = openSync(child, flags);
        } catch (openErr) {
          if (fsErrorCode(openErr) !== 'ENOENT') {
            throw emptyPersistUsage(dir);
          }
          try {
            mkdirSync(child);
          } catch {
            throw emptyPersistUsage(dir);
          }
          if (i === 0) created = true;
          try {
            childFd = openSync(child, flags);
          } catch {
            try {
              rmdirSync(child);
            } catch {
              // dest may already be gone
            }
            throw emptyPersistUsage(dir);
          }
        }
        if (childFd === undefined) {
          throw emptyPersistUsage(dir);
        }
        closeSync(parentFd);
        parentFd = childFd;
        fallback = child;
        childFd = undefined;
      }
      return finishEmptyPersistDirectory(parentFd, fallback, created);
    } catch (err) {
      if (childFd !== undefined) {
        try {
          closeSync(childFd);
        } catch {
          // already closed
        }
      }
      try {
        closeSync(parentFd);
      } catch {
        // already closed
      }
      throw err;
    }
  }
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

function peekCompleteMarkerFromOpened(dirFd: number, dir: string): string | undefined {
  const captureSize = Buffer.byteLength(CAPTURE_COMPLETE_BYTES, 'utf8');
  const offlineSize = Buffer.byteLength(OFFLINE_COMPLETE_BYTES, 'utf8');
  const fileFlags = persistFileFlags() | (fsConstants.O_NONBLOCK ?? 0);
  let fd: number | undefined;
  try {
    const leaf = path.join(persistRootForFd(dirFd, dir), BUNDLE_COMPLETE_MARKER);
    // O_NOFOLLOW rejects a swapped symlink (ELOOP). O_NONBLOCK so a
    // swapped FIFO cannot block this open until a writer appears.
    fd = openSync(leaf, fileFlags);
    const opened = fstatSync(fd);
    if (!opened.isFile()) return undefined;
    if (opened.size !== captureSize && opened.size !== offlineSize) return undefined;
    const buf = Buffer.alloc(opened.size);
    const n = readSync(fd, buf, 0, opened.size, 0);
    if (n !== opened.size) return undefined;
    const text = buf.toString('utf8');
    if (text === CAPTURE_COMPLETE_BYTES) return CommittedSourceSchemaVersion;
    if (text === OFFLINE_COMPLETE_BYTES) return CandidateOfflineSchemaVersion;
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

export function peekCompleteMarker(dir: string): string | undefined {
  let dirFd: number | undefined;
  try {
    dirFd = openSync(dir, persistDirectoryFlags());
    return peekCompleteMarkerFromOpened(dirFd, dir);
  } catch {
    return undefined;
  } finally {
    if (dirFd !== undefined) {
      try {
        closeSync(dirFd);
      } catch {
        // already closed
      }
    }
  }
}

export function bundleComplete(dir: string): boolean {
  return peekCompleteMarker(dir) === CommittedSourceSchemaVersion;
}

function readBoundedManifestFromOpened(dirFd: number, dir: string): string {
  const fileFlags = persistFileFlags() | (fsConstants.O_NONBLOCK ?? 0);
  const leaf = path.join(persistRootForFd(dirFd, dir), BUNDLE_MANIFEST_NAME);
  let fd: number;
  try {
    // O_NOFOLLOW rejects a swapped symlink (ELOOP). O_NONBLOCK so a
    // swapped FIFO cannot block this open until a writer appears.
    fd = openSync(leaf, fileFlags);
  } catch (err) {
    const code = fsErrorCode(err);
    if (code === 'ELOOP') {
      throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `${BUNDLE_MANIFEST_NAME} is not a regular file`);
    }
    throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `bundle is missing ${BUNDLE_MANIFEST_NAME}: ${dir}`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `${BUNDLE_MANIFEST_NAME} is not a regular file`);
    }
    if (opened.size > CAPTURE_MANIFEST_MAX_BYTES) {
      throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `${BUNDLE_MANIFEST_NAME} exceeds maxBytes`);
    }
    const buf = Buffer.alloc(opened.size);
    const n = readSync(fd, buf, 0, opened.size, 0);
    if (n !== opened.size) {
      throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `${BUNDLE_MANIFEST_NAME} bytes truncated`);
    }
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function readBoundedSelectedBlob(
  destFd: number,
  dir: string,
  relative: string,
  maxBytes: number,
  expectedLength: number,
): Buffer {
  assertBundleBlobPath(relative);
  const parts = relative.split('/');
  const dirFlags = persistDirectoryFlags();
  const fileFlags = persistFileFlags();
  const blobsFallback = path.join(dir, BUNDLE_BLOBS_DIR);
  let dirFd: number;
  try {
    dirFd = openSync(path.join(persistRootForFd(destFd, dir), BUNDLE_BLOBS_DIR), dirFlags);
  } catch (err) {
    const code = fsErrorCode(err);
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob path contains a symlink: ${relative}`);
    }
    throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob missing: ${relative}`);
  }
  try {
    for (const part of parts.slice(0, -1)) {
      const child = path.join(persistRootForFd(dirFd, blobsFallback), part);
      let next: number;
      try {
        next = openSync(child, dirFlags);
      } catch (err) {
        const code = fsErrorCode(err);
        // O_DIRECTORY|O_NOFOLLOW on a symlink is ENOTDIR on Linux (the
        // symlink inode is not a directory) and ELOOP on some kernels.
        if (code === 'ELOOP' || code === 'ENOTDIR') {
          throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob path contains a symlink: ${relative}`);
        }
        throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob missing: ${relative}`);
      }
      closeSync(dirFd);
      dirFd = next;
    }
    const leafName = parts[parts.length - 1];
    if (leafName === undefined) {
      throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob missing: ${relative}`);
    }
    const leaf = path.join(persistRootForFd(dirFd, blobsFallback), leafName);
    let fd: number;
    try {
      // persistFileFlags includes O_NOFOLLOW (symlink ELOOP) and
      // O_NONBLOCK so a swapped FIFO cannot block this open until a writer
      // appears; fstat of the opened inode then rejects non-regular files.
      fd = openSync(leaf, fileFlags);
    } catch (err) {
      const code = fsErrorCode(err);
      if (code === 'ELOOP' || code === 'ENXIO') {
        throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob is not a regular file: ${relative}`);
      }
      throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob missing: ${relative}`);
    }
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) {
        throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob is not a regular file: ${relative}`);
      }
      if (
        !Number.isInteger(expectedLength) ||
        expectedLength < 0 ||
        expectedLength > maxBytes ||
        opened.size > maxBytes
      ) {
        throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob exceeds maxFileBytes: ${relative}`);
      }
      if (opened.size !== expectedLength) {
        throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob bytes do not match manifest: ${relative}`);
      }
      const buf = Buffer.alloc(opened.size);
      const n = readSync(fd, buf, 0, opened.size, 0);
      if (n !== opened.size) {
        throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `selected blob bytes do not match manifest: ${relative}`);
      }
      return buf;
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(dirFd);
  }
}

function openBundleRoot(dir: string): number {
  try {
    return openSync(dir, persistDirectoryFlags());
  } catch {
    throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `bundle is missing ${BUNDLE_COMPLETE_MARKER}: ${dir}`);
  }
}

export function readPersistedCommittedSourceBundle(
  dir: string,
): CommittedSourceBundle & { blobs: CapturedBlobWithBytes[] } {
  const dirFd = openBundleRoot(dir);
  try {
    if (peekCompleteMarkerFromOpened(dirFd, dir) !== CommittedSourceSchemaVersion) {
      throw new ObservedFixtureError('BUNDLE_INCOMPLETE', `bundle is missing ${BUNDLE_COMPLETE_MARKER}: ${dir}`);
    }
    const raw = readBoundedManifestFromOpened(dirFd, dir);
    let parsed: CommittedSourceBundle;
    try {
      parsed = JSON.parse(raw) as CommittedSourceBundle;
    } catch {
      throw new ObservedFixtureError('BUNDLE_INVALID', `${BUNDLE_MANIFEST_NAME} is not valid JSON`);
    }
    if (parsed.schemaVersion !== CommittedSourceSchemaVersion) {
      throw new ObservedFixtureError('BUNDLE_INVALID', 'unexpected committed-source bundle schemaVersion');
    }
    if (!Array.isArray(parsed.source?.selected)) {
      throw new ObservedFixtureError('BUNDLE_INCOMPLETE', 'capture bundle is missing selected blob metadata');
    }
    const profile = installedCaptureProfile(parsed.profile.id);
    assertSelectedHardCaps(parsed.source.selected);
    const digestMatches = installedPolicyApplies(parsed, profile);
    if (digestMatches) {
      assertSelectedInstalledPolicy(parsed.source.selected, profile);
    }
    const capturedByPath = assertSelectedCapturedMetadata(parsed.source.selected, parsed.source.captured);
    assertCapturedRowsMatchRecordedCommit(
      parseStoredSourceIdentity(parsed.source.identity),
      parsed.source.commit,
      [...capturedByPath.values()],
    );
    const overlayed = overlayedPathSet(parsed.source.overlay);
    const blobs: CapturedBlobWithBytes[] = [];
    const readCap = digestMatches ? Math.min(profile.maxFileBytes, CAPTURE_MAX_FILE_BYTES) : CAPTURE_MAX_FILE_BYTES;
    for (const selected of parsed.source.selected) {
      const contents = readBoundedSelectedBlob(dirFd, dir, selected.path, readCap, selected.byteLength);
      if (contents.length !== selected.byteLength || sha256Hex(contents) !== selected.sha256) {
        throw new ObservedFixtureError(
          'BUNDLE_INCOMPLETE',
          `selected blob bytes do not match manifest: ${selected.path}`,
        );
      }
      const pinned = pinnedCapturedIdentity(selected, capturedByPath);
      if (!overlayed.has(selected.path)) {
        assertUnoverlaidSelectedMatchesCaptured(selected, pinned, contents);
      }
      blobs.push({
        path: selected.path,
        mode: selected.mode,
        type: 'blob',
        gitSha: pinned.gitSha,
        sha256: selected.sha256,
        byteLength: selected.byteLength,
        contents,
      });
    }
    return { ...parsed, blobs };
  } finally {
    try {
      closeSync(dirFd);
    } catch {
      // already closed
    }
  }
}
