/**
 * `acceptance capture-source <profile-id> <repo> <commit>` — Git object-read
 * capture of a pinned commit plus an engine-owned package-manifest/lockfile
 * profile. Not live execution. Existing record/verify-fixture/verify-candidate/
 * reproduce verbs stay intact.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandOutput } from './commands';
import { CliUsageError, ObservedFixtureError } from './errors';
import type { CapturedBlobWithBytes } from './committed-source-git';
import { implementationRevision, sha256Hex } from './implementation-revision';
import {
  CANDIDATE_MAX_DOCUMENT_BYTES,
  CandidateFileContentSchemaVersion,
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
  buildCommittedSourceBundle,
  persistCommittedSourceBundle,
  readPersistedCommittedSourceBundle,
  selectedFromBlobs,
  type CommittedSourceBundle,
} from './committed-source-bundle';
import { decideCommittedSource } from './committed-source-decider';
import {
  assertBundleDirOutsideSource,
  canariesEqual,
  captureGitObjects,
  resolveSourceIdentity,
  rereadCanary,
  snapshotFiles,
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

function writeSnapshot(files: Record<string, Buffer>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'committed-source-'));
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
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
  const snapshot = writeSnapshot(snapshotFiles(capture.blobs));
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
      canary: capture.canaryBefore,
      mutated: false,
      outcomes,
      decision,
    });
    if (bundleDir !== undefined) {
      persistCommittedSourceBundle(bundleDir, bundle, capture.blobs);
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
      fromCapture = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--from-capture=')) {
      fromCapture = path.resolve(arg.slice('--from-capture='.length));
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
  const stored = readPersistedCommittedSourceBundle(fromCapture);
  if (stored.profile.id !== profile.id) {
    throw new CliUsageError(`capture bundle profile ${stored.profile.id} does not match ${profile.id}`);
  }
  if (stored.profile.digest !== digest) {
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
        selected: stored.source.selected,
        overlay: stored.source.overlay,
        canary: { headSha256: stored.sourceIntegrity.headSha256, indexSha256: stored.sourceIntegrity.indexSha256 },
        mutated: false,
        outcomes: [],
        decision: { accepted: false, reasons: ['profile-digest-mismatch'] },
      }),
    };
  }
  const maxDocumentBytes = Math.min(CANDIDATE_MAX_DOCUMENT_BYTES, profile.maxFileBytes * profile.maxFiles);
  const raw = readBoundedUtf8File(path.resolve(candidatePath), maxDocumentBytes);
  const candidate = parseCandidateDocument(raw, profile);
  const unauthorized = unauthorizedCandidatePaths(candidate, profile);
  const overlay = {
    schemaVersion: CandidateFileContentSchemaVersion,
    files: candidate.files,
  };
  if (unauthorized.length > 0) {
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
      canary: { headSha256: stored.sourceIntegrity.headSha256, indexSha256: stored.sourceIntegrity.indexSha256 },
      mutated: false,
      outcomes: [],
      decision: {
        accepted: false,
        reasons: unauthorized.map((relative) => `unauthorized-path:${relative}`),
      },
    });
    if (bundleDir !== undefined) {
      persistCommittedSourceBundle(bundleDir, bundle, stored.blobs);
    }
    return { json, output: bundle };
  }
  const selectedBlobs = overlayBlobs(stored.blobs, candidate);
  const snapshot = writeSnapshot(snapshotFiles(selectedBlobs));
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
      canary: { headSha256: stored.sourceIntegrity.headSha256, indexSha256: stored.sourceIntegrity.indexSha256 },
      mutated: false,
      outcomes,
      decision,
    });
    if (bundleDir !== undefined) {
      persistCommittedSourceBundle(bundleDir, bundle, selectedBlobs);
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
        profile,
        digest,
        implementationRevision: implementationRevision(digest),
        requestedRev: stored.source.requestedRev,
        commit: stored.source.commit,
        captured: stored.source.captured,
        missing: stored.source.missing,
        selected: stored.source.selected,
        overlay: stored.source.overlay,
        canary: { headSha256: stored.sourceIntegrity.headSha256, indexSha256: stored.sourceIntegrity.indexSha256 },
        mutated: false,
        outcomes: [],
        decision: { accepted: false, reasons: ['profile-digest-mismatch'] },
      }),
    };
  }
  const snapshot = writeSnapshot(snapshotFiles(stored.blobs));
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
        overlay: stored.source.overlay,
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
