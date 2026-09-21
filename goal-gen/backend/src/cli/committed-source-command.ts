/**
 * `acceptance capture-source <profile-id> <repo> <commit>` — Git object-read
 * capture of a pinned commit plus an engine-owned package-manifest/lockfile
 * profile. Not live execution. Existing record/verify-fixture/verify-candidate/
 * reproduce verbs stay intact.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandOutput } from './commands';
import { CliUsageError, ObservedFixtureError } from './errors';
import { implementationRevision, sha256Hex } from './implementation-revision';
import {
  CANDIDATE_MAX_DEPTH,
  CANDIDATE_MAX_DOCUMENT_BYTES,
  CANDIDATE_MAX_FILE_BYTES,
  CANDIDATE_MAX_FILES,
  CandidateFileContentSchemaVersion,
  CandidateOfflineSchemaVersion,
  type CandidateFileDocument,
} from './candidate-offline-profiles';
import {
  parseCandidateDocument,
  readBoundedUtf8File,
  unauthorizedCandidatePaths,
} from './candidate-offline-command';
import { OBSERVER_OUTPUT_LIMIT, observerToolPath, runBoundedArgv } from './observed-fixture-child';
import type { ObservedCheckOutcome } from './observed-fixture-observer';
import {
  assertBundleDirWritable,
  assertFromCaptureDir,
  assertPersistedOverlayValues,
  buildCommittedSourceBundle,
  peekCompleteMarker,
  persistCommittedSourceBundle,
  readPersistedCommittedSourceBundle,
  selectedFromBlobs,
  type CaptureOverlay,
  type CommittedSourceBundle,
} from './committed-source-bundle';
import { decideCommittedSource } from './committed-source-decider';
import {
  assertBundleDirOutsideCanaryMatchedSource,
  assertBundleDirOutsideCapturedObjectStore,
  assertBundleDirOutsideSource,
  assertBundleDirOutsideSourceWhenIdentityUnauthenticated,
  canariesEqual,
  canonicalizeBundleDir,
  captureGitObjects,
  filesystemModeForBlob,
  overlayContainmentIdentities,
  parseStoredSourceIdentity,
  resolveSourceIdentity,
  rereadCanary,
  type CapturedBlobWithBytes,
  type SourceIdentity,
} from './committed-source-git';
import {
  committedSourceProfileDigest,
  getCommittedSourceProfile,
  listCommittedSourceProfiles,
  type CommittedSourceProfile,
} from './committed-source-profiles';

function knownProfiles(): string {
  return listCommittedSourceProfiles()
    .map((profile) => profile.id)
    .join('|');
}

function parseCaptureArgv(argv: string[]): { json: boolean; bundleDir?: string; positionals: string[] } {
  const positionals: string[] = [];
  let json = false;
  let bundleDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--bundle-dir') {
      const next = argv[i + 1];
      if (next === undefined) throw new CliUsageError('acceptance capture-source --bundle-dir requires a directory path');
      bundleDir = assertBundleDirWritable(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--bundle-dir=')) {
      bundleDir = assertBundleDirWritable(arg.slice('--bundle-dir='.length));
      continue;
    }
    positionals.push(arg);
  }
  return { json, bundleDir, positionals };
}

function writeSnapshot(blobs: CapturedBlobWithBytes[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'committed-source-'));
  for (const blob of blobs) {
    const full = path.join(dir, blob.path);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, blob.contents);
    chmodSync(full, filesystemModeForBlob(blob.mode));
  }
  return dir;
}

async function runChecks(
  profile: CommittedSourceProfile,
  snapshot: string,
): Promise<ObservedCheckOutcome[]> {
  const home = path.join(snapshot, '.capture-home');
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: observerToolPath(),
    LANG: 'C',
    HOME: home,
    TMPDIR: home,
  };
  const outcomes: ObservedCheckOutcome[] = [];
  for (const check of profile.checks) {
    const run = await runBoundedArgv({
      argv: check.argv,
      cwd: snapshot,
      env,
      timeoutMs: profile.timeoutMs,
      outputLimit: OBSERVER_OUTPUT_LIMIT,
    });
    if (run.spawnError !== undefined) {
      outcomes.push({
        id: check.id,
        command: check.command,
        cwd: check.cwd,
        status: 'not-run',
        reason: `spawn-failed:${run.spawnError}`,
      });
      continue;
    }
    if (run.timedOut) {
      outcomes.push({
        id: check.id,
        command: check.command,
        cwd: check.cwd,
        status: 'blocked',
        reason: 'deadline-exceeded',
        signal: run.signal,
        exitStatus: run.exitStatus,
        deadlineExceeded: true,
      });
      continue;
    }
    const passed = run.exitStatus === 0 && run.signal === undefined;
    outcomes.push({
      id: check.id,
      command: check.command,
      cwd: check.cwd,
      status: passed ? 'passed' : 'failed',
      exitStatus: run.exitStatus,
      signal: run.signal,
      stdout: run.stdout,
      stderr: run.stderr,
      outputTruncated: run.stdoutTruncated || run.stderrTruncated,
    });
  }
  return outcomes;
}

export async function runCommittedSourceCapture(argv: string[]): Promise<CommandOutput<CommittedSourceBundle>> {
  const { json, bundleDir, positionals } = parseCaptureArgv(argv);
  if (positionals.length !== 3) {
    throw new CliUsageError(
      `acceptance capture-source requires <profile-id> <repo> <commit> (profiles: ${knownProfiles()})`,
    );
  }
  const [profileId, repo, commitArg] = positionals;
  if (profileId === undefined || repo === undefined || commitArg === undefined) {
    throw new CliUsageError('acceptance capture-source requires <profile-id> <repo> <commit>');
  }
  if (profileId.endsWith('.json')) {
    throw new CliUsageError('imported JSON is not an authorization route for the profile id');
  }
  let profile: CommittedSourceProfile;
  try {
    profile = getCommittedSourceProfile(profileId);
  } catch {
    throw new CliUsageError(`unknown committed-source profile: ${profileId} (profiles: ${knownProfiles()})`);
  }
  const digest = committedSourceProfileDigest(profile);
  if (bundleDir !== undefined) {
    assertBundleDirOutsideSource(bundleDir, resolveSourceIdentity(repo));
  }
  const capture = captureGitObjects(repo, commitArg, profile);
  if (bundleDir !== undefined) {
    assertBundleDirOutsideSource(bundleDir, capture.identity);
  }
  const snapshot = writeSnapshot(capture.blobs);
  try {
    const outcomes = await runChecks(profile, snapshot);
    const canaryAfter = rereadCanary(capture.gitDir);
    if (!canariesEqual(capture.canaryBefore, canaryAfter)) {
      throw new ObservedFixtureError('SOURCE_MUTATED', 'source HEAD or index bytes changed during capture', {
        before: capture.canaryBefore,
        after: canaryAfter,
      });
    }
    const decision = decideCommittedSource({
      profile,
      outcomes,
      missing: capture.missing,
      faults: [],
    });
    const bundle = buildCommittedSourceBundle({
      profile,
      digest,
      implementationRevision: implementationRevision(digest),
      requestedRev: capture.requestedRev,
      commit: capture.commit,
      captured: capture.captured,
      missing: capture.missing,
      selected: selectedFromBlobs(capture.blobs),
      overlay: null,
      identity: capture.identity,
      canary: capture.canaryBefore,
      mutated: false,
      outcomes,
      decision,
    });
    if (bundleDir !== undefined) {
      persistCaptureCommittedSourceBundle(bundleDir, capture.identity, bundle, capture.blobs);
    }
    return { json, output: bundle };
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function parseFromCaptureArgv(argv: string[]): {
  json: boolean;
  bundleDir?: string;
  fromCapture?: string;
  positionals: string[];
} {
  const positionals: string[] = [];
  let json = false;
  let bundleDir: string | undefined;
  let fromCapture: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--bundle-dir') {
      const next = argv[i + 1];
      if (next === undefined) throw new CliUsageError('acceptance verify-candidate --bundle-dir requires a directory path');
      bundleDir = assertBundleDirWritable(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--bundle-dir=')) {
      bundleDir = assertBundleDirWritable(arg.slice('--bundle-dir='.length));
      continue;
    }
    if (arg === '--from-capture') {
      const next = argv[i + 1];
      if (next === undefined) throw new CliUsageError('acceptance verify-candidate --from-capture requires a bundle directory');
      fromCapture = assertFromCaptureDir(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--from-capture=')) {
      fromCapture = assertFromCaptureDir(arg.slice('--from-capture='.length));
      continue;
    }
    positionals.push(arg);
  }
  return { json, bundleDir, fromCapture, positionals };
}

function overlayBlobs(
  base: CapturedBlobWithBytes[],
  candidate: CandidateFileDocument,
): CapturedBlobWithBytes[] {
  const byPath = new Map(base.map((blob) => [blob.path, blob]));
  for (const [relative, text] of Object.entries(candidate.files)) {
    const prior = byPath.get(relative);
    // Overlay replaces already-captured allowlisted paths only. Missing capture
    // paths stay missing; selected bytes are captured blobs, not new files.
    if (prior === undefined) continue;
    const contents = Buffer.from(text, 'utf8');
    byPath.set(relative, {
      ...prior,
      contents,
      sha256: sha256Hex(contents),
      byteLength: contents.length,
    });
  }
  return [...byPath.values()];
}

function mergeOverlayFiles(
  prior: CaptureOverlay | null,
  candidateFiles: Record<string, string>,
  blobs: CapturedBlobWithBytes[],
): Record<string, string> {
  // Chained --from-capture and unauthorized persist keep prior overlay bytes
  // in blobs/ for omitted paths (overlayBlobs / stored.blobs). Persist must
  // keep those keys so reproduce still waives selected-to-captured identity
  // and CS-13 replay stays unauthorized-path. Skip prior keys that are not in
  // stored blobs (CS-13 unauthorized extra.txt is overlay metadata only).
  const blobPaths = new Set(blobs.map((blob) => blob.path));
  const merged: Record<string, string> = {};
  if (prior !== null) {
    for (const [relative, text] of Object.entries(prior.files)) {
      if (!blobPaths.has(relative)) continue;
      merged[relative] = text;
    }
  }
  for (const [relative, text] of Object.entries(candidateFiles)) {
    merged[relative] = text;
  }
  return merged;
}

function persistedOverlayUnauthorizedPaths(
  overlay: CaptureOverlay | null,
  profile: CommittedSourceProfile,
): string[] {
  if (overlay === null) return [];
  assertPersistedOverlayValues(overlay);
  return unauthorizedCandidatePaths(overlay, profile);
}

function assertOverlayBundleDirOutsideCapturedSource(
  bundleDir: string,
  stored: CommittedSourceBundle & { blobs: CapturedBlobWithBytes[] },
): void {
  const parsed = parseStoredSourceIdentity(stored.source.identity);
  if (parsed === undefined) {
    throw new ObservedFixtureError(
      'BUNDLE_INVALID',
      'overlay --bundle-dir requires a valid retained source.identity',
    );
  }
  for (const identity of overlayContainmentIdentities(parsed)) {
    assertBundleDirOutsideSource(bundleDir, identity);
  }
  assertBundleDirOutsideCanaryMatchedSource(bundleDir, {
    headSha256: stored.sourceIntegrity.headSha256,
    indexSha256: stored.sourceIntegrity.indexSha256,
  });
  assertBundleDirOutsideCapturedObjectStore(bundleDir, stored.source.captured, stored.source.commit);
  assertBundleDirOutsideSourceWhenIdentityUnauthenticated(
    bundleDir,
    parsed,
    stored.blobs,
    stored.source.overlay,
  );
}

function persistCaptureCommittedSourceBundle(
  bundleDir: string,
  identity: SourceIdentity,
  bundle: CommittedSourceBundle,
  blobs: CapturedBlobWithBytes[],
): void {
  const anchored = canonicalizeBundleDir(bundleDir);
  assertBundleDirOutsideSource(anchored, identity);
  assertBundleDirOutsideSource(bundleDir, identity);
  persistCommittedSourceBundle(anchored, bundle, blobs, (openedRoot) => {
    assertBundleDirOutsideSource(openedRoot, identity);
    assertBundleDirOutsideSource(anchored, identity);
    assertBundleDirOutsideSource(bundleDir, identity);
  });
}

function persistOverlayCommittedSourceBundle(
  bundleDir: string,
  stored: CommittedSourceBundle & { blobs: CapturedBlobWithBytes[] },
  bundle: CommittedSourceBundle,
  blobs: CapturedBlobWithBytes[],
): void {
  const anchored = canonicalizeBundleDir(bundleDir);
  assertOverlayBundleDirOutsideCapturedSource(anchored, stored);
  assertOverlayBundleDirOutsideCapturedSource(bundleDir, stored);
  persistCommittedSourceBundle(anchored, bundle, blobs, (openedRoot) => {
    assertOverlayBundleDirOutsideCapturedSource(openedRoot, stored);
    assertOverlayBundleDirOutsideCapturedSource(anchored, stored);
    assertOverlayBundleDirOutsideCapturedSource(bundleDir, stored);
  });
}

export async function runCommittedSourceOverlay(argv: string[]): Promise<CommandOutput<CommittedSourceBundle>> {
  const { json, bundleDir, fromCapture, positionals } = parseFromCaptureArgv(argv);
  if (fromCapture === undefined) {
    throw new CliUsageError('acceptance verify-candidate --from-capture requires a bundle directory');
  }
  if (!existsSync(fromCapture) || !lstatSync(fromCapture).isDirectory()) {
    throw new CliUsageError('acceptance verify-candidate --from-capture requires a capture bundle directory');
  }
  if (positionals.length !== 2) {
    throw new CliUsageError(
      `acceptance verify-candidate --from-capture requires <profile-id> <candidate.json> (profiles: ${knownProfiles()})`,
    );
  }
  const [profileId, candidatePath] = positionals;
  if (profileId === undefined || candidatePath === undefined) {
    throw new CliUsageError('acceptance verify-candidate --from-capture requires <profile-id> <candidate.json>');
  }
  if (profileId !== 'package-manifest-lockfile') {
    throw new CliUsageError(
      `acceptance verify-candidate --from-capture requires profile package-manifest-lockfile (got ${profileId})`,
    );
  }
  let profile: CommittedSourceProfile;
  try {
    profile = getCommittedSourceProfile(profileId);
  } catch {
    throw new CliUsageError(`unknown committed-source profile: ${profileId} (profiles: ${knownProfiles()})`);
  }
  const digest = committedSourceProfileDigest(profile);
  if (peekCompleteMarker(fromCapture) === CandidateOfflineSchemaVersion) {
    throw new CliUsageError(
      'acceptance verify-candidate --from-capture requires a committed-source capture bundle',
    );
  }
  const stored = readPersistedCommittedSourceBundle(fromCapture);
  if (bundleDir !== undefined) {
    assertOverlayBundleDirOutsideCapturedSource(bundleDir, stored);
  }
  if (stored.profile.id !== profile.id) {
    throw new CliUsageError(`capture bundle profile ${stored.profile.id} does not match ${profile.id}`);
  }
  if (stored.profile.digest !== digest) {
    const bundle = buildCommittedSourceBundle({
      profile: { ...profile, version: stored.profile.version },
      digest: stored.profile.digest,
      implementationRevision: stored.implementationRevision,
      requestedRev: stored.source.requestedRev,
      commit: stored.source.commit,
      captured: stored.source.captured,
      missing: stored.source.missing,
      selected: stored.source.selected,
      overlay: stored.source.overlay,
      identity: stored.source.identity,
      canary: { headSha256: stored.sourceIntegrity.headSha256, indexSha256: stored.sourceIntegrity.indexSha256 },
      mutated: false,
      outcomes: [],
      decision: { accepted: false, reasons: ['profile-digest-mismatch'] },
    });
    if (bundleDir !== undefined) {
      persistOverlayCommittedSourceBundle(bundleDir, stored, bundle, stored.blobs);
    }
    return { json, output: bundle };
  }
  const maxDocumentBytes = Math.min(CANDIDATE_MAX_DOCUMENT_BYTES, profile.maxFileBytes * profile.maxFiles);
  const raw = readBoundedUtf8File(path.resolve(candidatePath), maxDocumentBytes);
  const candidate = parseCandidateDocument(raw, {
    maxFiles: Math.min(profile.maxFiles, CANDIDATE_MAX_FILES),
    maxFileBytes: Math.min(profile.maxFileBytes, CANDIDATE_MAX_FILE_BYTES),
    maxDepth: Math.min(profile.maxDepth, CANDIDATE_MAX_DEPTH),
  });
  const unauthorized = unauthorizedCandidatePaths(candidate, profile);
  if (unauthorized.length > 0) {
    const overlay = {
      schemaVersion: CandidateFileContentSchemaVersion,
      files: mergeOverlayFiles(stored.source.overlay, candidate.files, stored.blobs),
    };
    const bundle = buildCommittedSourceBundle({
      profile,
      digest,
      implementationRevision: implementationRevision(digest),
      requestedRev: stored.source.requestedRev,
      commit: stored.source.commit,
      captured: stored.source.captured,
      missing: stored.source.missing,
      selected: selectedFromBlobs(stored.blobs),
      overlay,
      identity: stored.source.identity,
      canary: { headSha256: stored.sourceIntegrity.headSha256, indexSha256: stored.sourceIntegrity.indexSha256 },
      mutated: false,
      outcomes: [],
      decision: {
        accepted: false,
        reasons: unauthorized.map((relative) => `unauthorized-path:${relative}`),
      },
    });
    if (bundleDir !== undefined) {
      persistOverlayCommittedSourceBundle(bundleDir, stored, bundle, stored.blobs);
    }
    return { json, output: bundle };
  }
  const overlay = {
    schemaVersion: CandidateFileContentSchemaVersion,
    files: mergeOverlayFiles(stored.source.overlay, candidate.files, stored.blobs),
  };
  const selectedBlobs = overlayBlobs(stored.blobs, candidate);
  const snapshot = writeSnapshot(selectedBlobs);
  try {
    const outcomes = await runChecks(profile, snapshot);
    const decision = decideCommittedSource({
      profile,
      outcomes,
      missing: stored.source.missing,
      faults: [],
    });
    const bundle = buildCommittedSourceBundle({
      profile,
      digest,
      implementationRevision: implementationRevision(digest),
      requestedRev: stored.source.requestedRev,
      commit: stored.source.commit,
      captured: stored.source.captured,
      missing: stored.source.missing,
      selected: selectedFromBlobs(selectedBlobs),
      overlay,
      identity: stored.source.identity,
      canary: { headSha256: stored.sourceIntegrity.headSha256, indexSha256: stored.sourceIntegrity.indexSha256 },
      mutated: false,
      outcomes,
      decision,
    });
    if (bundleDir !== undefined) {
      persistOverlayCommittedSourceBundle(bundleDir, stored, bundle, selectedBlobs);
    }
    return { json, output: bundle };
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

export async function runCommittedSourceReproduce(argv: string[]): Promise<CommandOutput<CommittedSourceBundle>> {
  const json = argv.includes('--json');
  const positionals = argv.filter((value) => value !== '--json');
  if (positionals.length !== 1) {
    throw new CliUsageError('acceptance reproduce requires <bundle-dir>');
  }
  const bundleDir = path.resolve(positionals[0]!);
  const stored = readPersistedCommittedSourceBundle(bundleDir);
  let profile: CommittedSourceProfile;
  try {
    profile = getCommittedSourceProfile(stored.profile.id);
  } catch {
    throw new CliUsageError(`unknown committed-source profile in bundle: ${stored.profile.id}`);
  }
  const digest = committedSourceProfileDigest(profile);
  if (digest !== stored.profile.digest) {
    return {
      json,
      output: buildCommittedSourceBundle({
        profile: { ...profile, version: stored.profile.version },
        digest: stored.profile.digest,
        implementationRevision: stored.implementationRevision,
        requestedRev: stored.source.requestedRev,
        commit: stored.source.commit,
        captured: stored.source.captured,
        missing: stored.source.missing,
        selected: stored.source.selected,
        overlay: stored.source.overlay,
        identity: stored.source.identity,
        canary: { headSha256: stored.sourceIntegrity.headSha256, indexSha256: stored.sourceIntegrity.indexSha256 },
        mutated: false,
        outcomes: [],
        decision: { accepted: false, reasons: ['profile-digest-mismatch'] },
      }),
    };
  }
  const overlay = stored.source.overlay;
  const unauthorized = persistedOverlayUnauthorizedPaths(overlay, profile);
  if (unauthorized.length > 0) {
    return {
      json,
      output: buildCommittedSourceBundle({
        profile,
        digest,
        implementationRevision: implementationRevision(digest),
        requestedRev: stored.source.requestedRev,
        commit: stored.source.commit,
        captured: stored.source.captured,
        missing: stored.source.missing,
        selected: selectedFromBlobs(stored.blobs),
        overlay,
        identity: stored.source.identity,
        canary: { headSha256: stored.sourceIntegrity.headSha256, indexSha256: stored.sourceIntegrity.indexSha256 },
        mutated: false,
        outcomes: [],
        decision: {
          accepted: false,
          reasons: unauthorized.map((relative) => `unauthorized-path:${relative}`),
        },
      }),
    };
  }
  const snapshot = writeSnapshot(stored.blobs);
  try {
    const outcomes = await runChecks(profile, snapshot);
    const decision = decideCommittedSource({
      profile,
      outcomes,
      missing: stored.source.missing,
      faults: [],
    });
    return {
      json,
      output: buildCommittedSourceBundle({
        profile,
        digest,
        implementationRevision: implementationRevision(digest),
        requestedRev: stored.source.requestedRev,
        commit: stored.source.commit,
        captured: stored.source.captured,
        missing: stored.source.missing,
        selected: selectedFromBlobs(stored.blobs),
        overlay,
        identity: stored.source.identity,
        canary: { headSha256: stored.sourceIntegrity.headSha256, indexSha256: stored.sourceIntegrity.indexSha256 },
        mutated: false,
        outcomes,
        decision,
      }),
    };
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}
