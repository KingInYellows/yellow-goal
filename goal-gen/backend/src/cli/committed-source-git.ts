import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CliUsageError, ObservedFixtureError } from './errors';
import { sha256FileIfPresent, sha256Hex } from './implementation-revision';
import { observerToolPath } from './observed-fixture-child';
import type { CommittedSourceProfile } from './committed-source-profiles';

const READ_VERBS = new Set(['rev-parse', 'cat-file', 'ls-tree']);
const ALLOWED_BLOB_MODES = new Set(['100644', '100755']);
const REVISION_CHARS = /^[A-Za-z0-9._/^~{}-]+$/;

export type CapturedBlob = {
  path: string;
  mode: string;
  type: 'blob';
  gitSha: string;
  sha256: string;
  byteLength: number;
};

export type SourceCanary = {
  headSha256: string;
  indexSha256: string;
};

export type GitObjectCapture = {
  gitDir: string;
  requestedRev: string;
  commit: string;
  captured: CapturedBlob[];
  missing: string[];
  canaryBefore: SourceCanary;
};

export function gitReadArgvVerb(args: readonly string[]): string | undefined {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '-c' || arg === '-C') {
      i += 2;
      continue;
    }
    if (arg.startsWith('--git-dir=') || arg.startsWith('-')) {
      i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

export function assertGitReadArgv(args: readonly string[]): void {
  const verb = gitReadArgvVerb(args);
  if (verb === undefined || !READ_VERBS.has(verb)) {
    throw new ObservedFixtureError(
      'GIT_WRITE_REFUSED',
      `git object-read helper refuses verb: ${verb ?? '(none)'}`,
      { argv: [...args] },
    );
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: observerToolPath(),
    LANG: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function runGitUtf8(args: string[]): string {
  assertGitReadArgv(args);
  const result = spawnSync('git', args, {
    env: gitEnv(),
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || 'git failed').trim();
    throw new ObservedFixtureError('GIT_READ_FAILED', `git ${args.join(' ')}: ${detail}`, {
      argv: args,
      status: result.status,
    });
  }
  return (result.stdout ?? '').trim();
}

function runGitBuffer(args: string[], maxBuffer: number): Buffer {
  assertGitReadArgv(args);
  const result = spawnSync('git', args, {
    env: gitEnv(),
    timeout: 15_000,
    maxBuffer,
  });
  if (result.status !== 0) {
    const detail = (result.stderr?.toString('utf8') || result.error?.message || 'git failed').trim();
    throw new ObservedFixtureError('GIT_READ_FAILED', `git ${args.join(' ')}: ${detail}`, {
      argv: args,
      status: result.status,
    });
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
}

function withGitDir(gitDir: string, rest: string[]): string[] {
  return ['-c', 'core.hooksPath=/dev/null', `--git-dir=${gitDir}`, ...rest];
}

export function assertLocalRepoPath(raw: string): string {
  if (raw === '' || raw.startsWith('-')) {
    throw new CliUsageError('acceptance capture-source requires a local repository path');
  }
  if (raw.includes('\0') || /:\/\//.test(raw) || raw.startsWith('git@')) {
    throw new CliUsageError('acceptance capture-source refuses network or URL repositories');
  }
  return path.resolve(raw);
}

function assertRevision(raw: string): string {
  if (raw === '' || raw.startsWith('-') || raw.includes('\0') || !REVISION_CHARS.test(raw)) {
    throw new CliUsageError(`unsafe revision: ${raw}`);
  }
  return raw;
}

function readCanary(gitDir: string): SourceCanary {
  const headPath = path.resolve(gitDir, runGitUtf8(withGitDir(gitDir, ['rev-parse', '--git-path', 'HEAD'])));
  const indexPath = path.resolve(gitDir, runGitUtf8(withGitDir(gitDir, ['rev-parse', '--git-path', 'index'])));
  return {
    headSha256: sha256FileIfPresent(headPath),
    indexSha256: sha256FileIfPresent(indexPath),
  };
}

export function canariesEqual(before: SourceCanary, after: SourceCanary): boolean {
  return before.headSha256 === after.headSha256 && before.indexSha256 === after.indexSha256;
}

function parseLsTree(line: string, expectedPath: string): { mode: string; type: string; sha: string } | undefined {
  if (line === '') return undefined;
  const match = /^(?<mode>[0-7]{6}) (?<type>blob|tree|commit|tag) (?<sha>[0-9a-f]{40})\t(?<path>.+)$/.exec(line);
  if (match === null || match.groups === undefined) {
    throw new ObservedFixtureError('GIT_READ_FAILED', `unexpected ls-tree line for ${expectedPath}`);
  }
  const mode = match.groups.mode;
  const type = match.groups.type;
  const sha = match.groups.sha;
  const listed = match.groups.path;
  if (mode === undefined || type === undefined || sha === undefined || listed === undefined) {
    throw new ObservedFixtureError('GIT_READ_FAILED', `unexpected ls-tree line for ${expectedPath}`);
  }
  if (listed !== expectedPath) {
    throw new ObservedFixtureError('GIT_READ_FAILED', `ls-tree path mismatch for ${expectedPath}`);
  }
  return { mode, type, sha };
}

export type CapturedBlobWithBytes = CapturedBlob & { contents: Buffer };

function captureBlob(
  gitDir: string,
  commit: string,
  relative: string,
  maxFileBytes: number,
): CapturedBlobWithBytes | 'missing' | 'oversized' {
  const line = runGitUtf8(withGitDir(gitDir, ['ls-tree', '--full-tree', commit, '--', relative]));
  const parsed = parseLsTree(line, relative);
  if (parsed === undefined || parsed.type !== 'blob' || !ALLOWED_BLOB_MODES.has(parsed.mode)) {
    return 'missing';
  }
  const sizeText = runGitUtf8(withGitDir(gitDir, ['cat-file', '-s', parsed.sha]));
  const size = Number.parseInt(sizeText, 10);
  if (!Number.isFinite(size) || size < 0) {
    throw new ObservedFixtureError('GIT_READ_FAILED', `invalid blob size for ${relative}`);
  }
  if (size > maxFileBytes) {
    return 'oversized';
  }
  const contents = runGitBuffer(withGitDir(gitDir, ['cat-file', 'blob', parsed.sha]), maxFileBytes + 1);
  if (contents.length > maxFileBytes) {
    return 'oversized';
  }
  return {
    path: relative,
    mode: parsed.mode,
    type: 'blob',
    gitSha: parsed.sha,
    sha256: sha256Hex(contents.toString('utf8')),
    byteLength: contents.length,
    contents,
  };
}

export function captureGitObjects(
  repo: string,
  requestedRev: string,
  profile: CommittedSourceProfile,
): GitObjectCapture & { blobs: CapturedBlobWithBytes[] } {
  const repoPath = assertLocalRepoPath(repo);
  const revision = assertRevision(requestedRev);
  let gitDir: string;
  try {
    gitDir = runGitUtf8(['-c', 'core.hooksPath=/dev/null', '-C', repoPath, 'rev-parse', '--absolute-git-dir']);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliUsageError(`not a local git repository: ${message}`);
  }
  let commit: string;
  try {
    commit = runGitUtf8(withGitDir(gitDir, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliUsageError(`cannot resolve revision ${revision}: ${message}`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new CliUsageError(`revision did not resolve to a full commit object ID: ${commit}`);
  }
  const canaryBefore = readCanary(gitDir);
  if (profile.allowedPaths.length > profile.maxFiles) {
    throw new ObservedFixtureError('PROFILE_INVALID', 'profile allowlist exceeds maxFiles');
  }
  const blobs: CapturedBlobWithBytes[] = [];
  const missing: string[] = [];
  for (const relative of profile.allowedPaths) {
    const captured = captureBlob(gitDir, commit, relative, profile.maxFileBytes);
    if (captured === 'missing' || captured === 'oversized') {
      missing.push(relative);
      continue;
    }
    blobs.push(captured);
  }
  return {
    gitDir,
    requestedRev: revision,
    commit,
    captured: blobs.map(({ contents: _contents, ...meta }) => meta),
    missing,
    canaryBefore,
    blobs,
  };
}

export function rereadCanary(gitDir: string): SourceCanary {
  return readCanary(gitDir);
}

export function blobText(blob: CapturedBlobWithBytes): string {
  return blob.contents.toString('utf8');
}

export function snapshotFiles(blobs: CapturedBlobWithBytes[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const blob of blobs) {
    files[blob.path] = blobText(blob);
  }
  return files;
}
