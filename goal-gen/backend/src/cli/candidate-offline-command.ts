/**
 * `acceptance verify-candidate <profile-id> <candidate.json>` — FILE-CONTENT overlay
 * onto an engine-owned profile. `acceptance reproduce <bundle-dir>` reruns trusted
 * checks from the installed package; stored `accepted: true` is not re-verification.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import type { CommandOutput } from './commands';
import { CliUsageError, ObservedFixtureError } from './errors';
import { implementationRevision } from './implementation-revision';
import {
  buildCandidateBundle,
  persistCandidateBundle,
  readPersistedBundle,
  assertBundleDirWritable,
  type CandidateOfflineBundle,
} from './candidate-offline-bundle';
import { decideCandidateOffline } from './candidate-offline-decider';
import {
  CandidateFileContentSchemaVersion,
  CANDIDATE_MAX_DEPTH,
  CANDIDATE_MAX_DOCUMENT_BYTES,
  CANDIDATE_MAX_FILE_BYTES,
  CANDIDATE_MAX_FILES,
  candidateProfileDigest,
  getCandidateOfflineProfile,
  listCandidateOfflineProfiles,
  type CandidateFileDocument,
  type CandidateOfflineProfile,
} from './candidate-offline-profiles';
import {
  buildRecorderFixture,
  invokeInstalledRecorder,
  recorderRepresentable,
} from './observed-fixture-command';
import { observeFixture, removeObservationRepo } from './observed-fixture-observer';

function knownProfiles(): string {
  return listCandidateOfflineProfiles()
    .map((profile) => profile.id)
    .join('|');
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const FORBIDDEN_PATH_NAMES = new Set(['__proto__', 'constructor', 'prototype', '.git']);

export type CandidatePathLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxDepth: number;
};

export function parseCandidateDocument(raw: string, profile: CandidatePathLimits): CandidateFileDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CliUsageError('candidate document is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError('candidate document must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== CandidateFileContentSchemaVersion) {
    throw new CliUsageError(`candidate schemaVersion must be ${CandidateFileContentSchemaVersion}`);
  }
  if (typeof record.files !== 'object' || record.files === null || Array.isArray(record.files)) {
    throw new CliUsageError('candidate files must be an object of path → string contents');
  }
  const files = Object.create(null) as Record<string, string>;
  const entries = Object.entries(record.files as Record<string, unknown>);
  if (entries.length > profile.maxFiles) {
    throw new CliUsageError(`candidate exceeds maxFiles (${profile.maxFiles})`);
  }
  for (const [relative, contents] of entries) {
    assertSafeCandidatePath(relative, profile);
    if (typeof contents !== 'string') {
      throw new CliUsageError(`candidate file ${relative} must be a string`);
    }
    if (Buffer.byteLength(contents, 'utf8') > profile.maxFileBytes) {
      throw new CliUsageError(`candidate file ${relative} exceeds maxFileBytes (${profile.maxFileBytes})`);
    }
    files[relative] = contents;
  }
  return { schemaVersion: CandidateFileContentSchemaVersion, files };
}

export function assertSafeCandidatePath(relative: string, profile: CandidatePathLimits): void {
  if (relative === '' || relative.startsWith('/') || relative.startsWith('\\') || relative.startsWith('-')) {
    throw new CliUsageError(`unsafe candidate path: ${relative}`);
  }
  if (relative.includes('\0') || relative.includes('\\')) {
    throw new CliUsageError(`unsafe candidate path: ${relative}`);
  }
  const parts = relative.split('/');
  if (
    parts.length > profile.maxDepth ||
    parts.some(
      (part) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        FORBIDDEN_PATH_NAMES.has(part) ||
        !SAFE_SEGMENT.test(part),
    )
  ) {
    throw new CliUsageError(`unsafe candidate path: ${relative}`);
  }
}

export function unauthorizedCandidatePaths(
  candidate: CandidateFileDocument,
  profile: { allowedPaths: readonly string[] },
): string[] {
  return Object.keys(candidate.files).filter((relative) => !profile.allowedPaths.includes(relative));
}

/**
 * Read at most `maxBytes` from an untrusted file. Allocates cap+1, never the
 * full file size, so a huge candidate cannot exhaust the heap before USAGE.
 */
export function readBoundedUtf8File(filePath: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : 'UNKNOWN';
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'ENOENT') {
      throw new CliUsageError(`cannot read candidate document: ${message}`);
    }
    throw new ObservedFixtureError('IO_ERROR', `cannot read candidate document ${filePath}: ${message}`, {
      path: filePath,
      code,
    });
  }
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    const n = readSync(fd, buf, 0, maxBytes + 1, 0);
    if (n > maxBytes) {
      throw new CliUsageError(`candidate document exceeds maxDocumentBytes (${maxBytes})`);
    }
    return buf.subarray(0, n).toString('utf8');
  } catch (err) {
    if (err instanceof CliUsageError || err instanceof ObservedFixtureError) throw err;
    const code = err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : 'UNKNOWN';
    const message = err instanceof Error ? err.message : String(err);
    throw new ObservedFixtureError('IO_ERROR', `cannot read candidate document ${filePath}: ${message}`, {
      path: filePath,
      code,
    });
  } finally {
    closeSync(fd);
  }
}

function parseVerifyArgv(argv: string[]): { json: boolean; bundleDir?: string; positionals: string[] } {
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
      if (next === undefined) throw new CliUsageError('acceptance verify-candidate --bundle-dir requires a directory path');
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

async function verifyWithProfile(
  profile: CandidateOfflineProfile,
  candidate: CandidateFileDocument,
  unauthorized: string[],
): Promise<{
  observation: Awaited<ReturnType<typeof observeFixture>>;
  bundle: CandidateOfflineBundle;
}> {
  const digest = candidateProfileDigest(profile);
  if (unauthorized.length > 0) {
    const observation = {
      repo: '',
      cleanupDir: '',
      baseRevision: '',
      candidateTree: '',
      diff: '',
      overlay: { ...profile.baseFiles, ...candidate.files },
      checks: [],
      faults: [],
    };
    const decision = decideCandidateOffline({ profile, observation, unauthorized });
    return {
      observation,
      bundle: buildCandidateBundle({
        profile,
        digest,
        implementationRevision: implementationRevision(digest),
        candidate,
        observation,
        recorder: null,
        decision,
      }),
    };
  }
  const observation = await observeFixture(profile, { files: candidate.files });
  try {
    let recorder;
    if (
      observation.faults.length === 0 &&
      observation.candidateTree !== '' &&
      observation.checks.length > 0 &&
      recorderRepresentable(observation.checks)
    ) {
      recorder = await invokeInstalledRecorder(buildRecorderFixture(profile, observation));
    }
    const decision = decideCandidateOffline({ profile, observation, recorder, unauthorized });
    const bundle = buildCandidateBundle({
      profile,
      digest,
      implementationRevision: implementationRevision(digest),
      candidate,
      observation,
      recorder: recorder ?? null,
      decision,
    });
    return { observation, bundle };
  } finally {
    await removeObservationRepo(observation.cleanupDir);
  }
}

export async function runCandidateOfflineVerify(argv: string[]): Promise<CommandOutput<CandidateOfflineBundle>> {
  const { json, bundleDir, positionals } = parseVerifyArgv(argv);
  if (positionals.length !== 2) {
    throw new CliUsageError(
      `acceptance verify-candidate requires <profile-id> <candidate.json> (profiles: ${knownProfiles()})`,
    );
  }
  const [profileId, candidatePath] = positionals;
  if (profileId === undefined || candidatePath === undefined) {
    throw new CliUsageError('acceptance verify-candidate requires <profile-id> <candidate.json>');
  }
  if (profileId.endsWith('.json')) {
    throw new CliUsageError('imported JSON is not an authorization route for the profile id');
  }

  let profile: CandidateOfflineProfile;
  try {
    profile = getCandidateOfflineProfile(profileId);
  } catch {
    throw new CliUsageError(`unknown candidate-offline profile: ${profileId} (profiles: ${knownProfiles()})`);
  }

  const resolvedCandidate = path.resolve(candidatePath);
  const maxDocumentBytes = Math.min(profile.maxDocumentBytes, CANDIDATE_MAX_DOCUMENT_BYTES);
  const raw = readBoundedUtf8File(resolvedCandidate, maxDocumentBytes);
  const candidate = parseCandidateDocument(raw, {
    maxFiles: Math.min(profile.maxFiles, CANDIDATE_MAX_FILES),
    maxFileBytes: Math.min(profile.maxFileBytes, CANDIDATE_MAX_FILE_BYTES),
    maxDepth: Math.min(profile.maxDepth, CANDIDATE_MAX_DEPTH),
  });
  const unauthorized = unauthorizedCandidatePaths(candidate, profile);
  const { bundle } = await verifyWithProfile(profile, candidate, unauthorized);
  if (bundleDir !== undefined) {
    persistCandidateBundle(bundleDir, bundle);
  }
  return { json, output: bundle };
}

export async function runCandidateOfflineReproduce(argv: string[]): Promise<CommandOutput<CandidateOfflineBundle>> {
  const json = argv.includes('--json');
  const positionals = argv.filter((value) => value !== '--json');
  if (positionals.length !== 1) {
    throw new CliUsageError('acceptance reproduce requires <bundle-dir>');
  }
  const bundleDir = path.resolve(positionals[0]!);
  const stored = readPersistedBundle(bundleDir);
  let profile: CandidateOfflineProfile;
  try {
    profile = getCandidateOfflineProfile(stored.profile.id);
  } catch {
    throw new CliUsageError(`unknown candidate-offline profile in bundle: ${stored.profile.id}`);
  }
  const digest = candidateProfileDigest(profile);
  if (digest !== stored.profile.digest) {
    return {
      json,
      output: {
        ...stored,
        recorder: null,
        decision: { accepted: false, reasons: ['profile-digest-mismatch'] },
        reproduction: { argv: ['acceptance', 'reproduce', bundleDir] },
      },
    };
  }
  const candidate = parseCandidateDocument(JSON.stringify(stored.candidate), profile);
  const unauthorized = unauthorizedCandidatePaths(candidate, profile);
  const { bundle } = await verifyWithProfile(profile, candidate, unauthorized);
  bundle.reproduction = { argv: ['acceptance', 'reproduce', bundleDir] };
  return { json, output: bundle };
}
