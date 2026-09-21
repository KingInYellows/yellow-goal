import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { CliUsageError, ObservedFixtureError } from './errors';
import { gitBlobSha1, sha256FileIfPresent, sha256Hex } from './implementation-revision';
import { observerToolPath } from './observed-fixture-child';
import type { CommittedSourceProfile } from './committed-source-profiles';

const READ_VERBS = new Set(['rev-parse', 'cat-file', 'ls-tree']);
const ALLOWED_BLOB_MODES = new Set(['100644', '100755']);
const REVISION_CHARS = /^[A-Za-z0-9._/^~{}-]+$/;

export function filesystemModeForBlob(mode: string): number {
  if (mode === '100755') return 0o755;
  if (mode === '100644') return 0o644;
  throw new ObservedFixtureError('BUNDLE_INVALID', `unsupported captured blob mode: ${mode}`);
}

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

export type SourceIdentity = {
  repoPath: string;
  gitDir: string;
  commonGitDir: string;
  worktree: string | null;
};

export type GitObjectCapture = {
  identity: SourceIdentity;
  gitDir: string;
  worktree: string | null;
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
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
}

function stripGitTerminatingNewline(text: string): string {
  return text.replace(/\n$/, '');
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
  return stripGitTerminatingNewline(result.stdout ?? '');
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
  return ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', `--git-dir=${gitDir}`, ...rest];
}

function withRepoPath(repoPath: string, rest: string[]): string[] {
  return ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-C', repoPath, ...rest];
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
    sha256: sha256Hex(contents),
    byteLength: contents.length,
    contents,
  };
}

function resolveReportedGitPath(repoPath: string, reported: string): string {
  return path.isAbsolute(reported) ? path.resolve(reported) : path.resolve(repoPath, reported);
}

function recoverWorktreeFromGitDir(gitDir: string): string | null {
  const pointer = path.join(gitDir, 'gitdir');
  try {
    const st = lstatSync(pointer);
    if (st.isFile() && !st.isSymbolicLink()) {
      const raw = readFileSync(pointer, 'utf8').trim();
      if (raw !== '' && !raw.includes('\0') && !raw.startsWith('-')) {
        const gitfile = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(gitDir, raw);
        return path.dirname(gitfile);
      }
    }
  } catch {
    // ordinary .git directory has no gitdir pointer
  }
  if (path.basename(gitDir) === '.git') {
    return path.dirname(gitDir);
  }
  return null;
}

function resolveAssociatedWorktree(repoPath: string, gitDir: string): string | null {
  try {
    const toplevel = runGitUtf8(withRepoPath(repoPath, ['rev-parse', '--show-toplevel']));
    if (toplevel !== '') return toplevel;
  } catch {
    // git -C <checkout>/.git has no work tree in cwd
  }
  let bare: string;
  try {
    bare = runGitUtf8(withRepoPath(repoPath, ['rev-parse', '--is-bare-repository']));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliUsageError(`not a local git repository: ${message}`);
  }
  if (bare === 'true') return null;
  const recovered = recoverWorktreeFromGitDir(gitDir);
  if (recovered !== null) return recovered;
  throw new CliUsageError(
    'acceptance capture-source requires a work tree or a bare repository, not a git directory of a non-bare checkout',
  );
}

export function resolveSourceIdentity(repo: string): SourceIdentity {
  const repoPath = assertLocalRepoPath(repo);
  let gitDir: string;
  try {
    gitDir = runGitUtf8(withRepoPath(repoPath, ['rev-parse', '--absolute-git-dir']));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliUsageError(`not a local git repository: ${message}`);
  }
  let commonGitDir: string;
  try {
    commonGitDir = resolveReportedGitPath(
      repoPath,
      runGitUtf8(withRepoPath(repoPath, ['rev-parse', '--git-common-dir'])),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliUsageError(`not a local git repository: ${message}`);
  }
  const worktree = resolveAssociatedWorktree(repoPath, gitDir);
  return { repoPath, gitDir, commonGitDir, worktree };
}

function nearestExistingRealPath(candidate: string): string {
  let current = path.resolve(candidate);
  const { root } = path.parse(current);
  for (;;) {
    if (existsSync(current)) {
      return realpathSync(current);
    }
    if (current === root) return current;
    current = path.dirname(current);
  }
}

/** Resolve symlink ancestors now; persist must write only to this verified path. */
export function canonicalizeBundleDir(bundleDir: string): string {
  const resolved = path.resolve(bundleDir);
  let current = resolved;
  const { root } = path.parse(current);
  const missing: string[] = [];
  while (!existsSync(current) && current !== root) {
    missing.unshift(path.basename(current));
    current = path.dirname(current);
  }
  let realBase = current;
  try {
    if (existsSync(current)) realBase = realpathSync(current);
  } catch {
    realBase = current;
  }
  return missing.length === 0 ? realBase : path.join(realBase, ...missing);
}

function relativePathWithinRoot(rel: string): boolean {
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function pathContainedBy(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  if (relativePathWithinRoot(rel)) {
    return true;
  }
  // Missing stored roots stay at the lexical miss. Catching realpath ENOENT as
  // contained would refuse every overlay dest after the captured checkout is gone.
  if (!existsSync(resolvedRoot)) {
    return false;
  }
  try {
    const realRoot = realpathSync(resolvedRoot);
    const realCandidate = nearestExistingRealPath(resolvedCandidate);
    const relReal = path.relative(realRoot, realCandidate);
    return relativePathWithinRoot(relReal);
  } catch {
    return true;
  }
}

export function assertBundleDirOutsideSource(bundleDir: string, identity: SourceIdentity): void {
  if (pathContainedBy(identity.gitDir, bundleDir) || pathContainedBy(identity.commonGitDir, bundleDir)) {
    throw new CliUsageError('acceptance --bundle-dir must not be inside the source git directory');
  }
  if (identity.worktree !== null && pathContainedBy(identity.worktree, bundleDir)) {
    throw new CliUsageError('acceptance --bundle-dir must not be inside the source worktree');
  }
}

/**
 * Stored identity roots that do not exist are a lexical miss (gone captured
 * checkout). A well-formed absolute replacement under an unrelated missing
 * root must not disable containment of the still-live captured checkout.
 * Bind dest against captured HEAD/index canaries: if dest sits inside a git
 * checkout whose canaries match **and** the index is present on both sides,
 * refuse like dest-inside-source. HEAD bytes plus a missing index are not
 * source identity.
 */
export function assertBundleDirOutsideCanaryMatchedSource(bundleDir: string, canary: SourceCanary): void {
  let current = path.resolve(bundleDir);
  const { root } = path.parse(current);
  const seen = new Set<string>();
  for (;;) {
    if (!seen.has(current) && existsSync(current)) {
      seen.add(current);
      let identity: SourceIdentity | undefined;
      try {
        identity = resolveSourceIdentity(current);
      } catch {
        identity = undefined;
      }
      if (identity !== undefined && destBindCanariesMatch(canary, rereadCanary(identity.gitDir))) {
        assertBundleDirOutsideSource(bundleDir, identity);
      }
    }
    if (current === root) break;
    current = path.dirname(current);
  }
}

function gitDirContainsBlob(gitDir: string, sha: string): boolean {
  try {
    runGitUtf8(withGitDir(gitDir, ['cat-file', '-e', sha]));
    return true;
  } catch {
    return false;
  }
}

function gitDirLooksLikeCapturedSource(
  gitDir: string,
  commit: string | undefined,
  capturedShas: readonly string[],
): boolean {
  if (commit !== undefined && gitDirContainsBlob(gitDir, commit)) return true;
  return capturedShas.length > 0 && capturedShas.every((sha) => gitDirContainsBlob(gitDir, sha));
}

/**
 * Identity roots, stored HEAD/index canaries, and recorded commit/gitSha are
 * independently retargetable in the same untrusted manifest. Bind dest against
 * the recorded source.commit or the full captured gitSha set in a live
 * checkout — not `shas.some(one blob)`, which classifies an unrelated dest
 * that happens to share package.json as captured source. Overlay replacement
 * bytes are not probes. A dest that shares only one captured blob, or none,
 * is not the captured source.
 */
export function assertBundleDirOutsideCapturedObjectStore(
  bundleDir: string,
  captured: readonly CapturedBlob[],
  commit?: string,
): void {
  const shas = [
    ...new Set(
      captured
        .map((row) => row?.gitSha)
        .filter((sha): sha is string => typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha)),
    ),
  ];
  const commitSha = typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit) ? commit : undefined;
  if (shas.length === 0 && commitSha === undefined) return;
  let current = path.resolve(bundleDir);
  const { root } = path.parse(current);
  const seen = new Set<string>();
  for (;;) {
    if (!seen.has(current) && existsSync(current)) {
      seen.add(current);
      let identity: SourceIdentity | undefined;
      try {
        identity = resolveSourceIdentity(current);
      } catch {
        identity = undefined;
      }
      if (identity !== undefined && gitDirLooksLikeCapturedSource(identity.gitDir, commitSha, shas)) {
        assertBundleDirOutsideSource(bundleDir, identity);
      }
    }
    if (current === root) break;
    current = path.dirname(current);
  }
}

function identityPathsEqual(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  try {
    if (existsSync(resolvedLeft) && existsSync(resolvedRight)) {
      return realpathSync(resolvedLeft) === realpathSync(resolvedRight);
    }
  } catch {
    return false;
  }
  return false;
}

function storedIdentityResolvesCoherently(identity: SourceIdentity): boolean {
  const candidates = [identity.repoPath, identity.gitDir];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let live: SourceIdentity;
    try {
      live = resolveSourceIdentity(candidate);
    } catch {
      continue;
    }
    if (
      identityPathsEqual(live.gitDir, identity.gitDir) &&
      identityPathsEqual(live.commonGitDir, identity.commonGitDir)
    ) {
      return true;
    }
  }
  return false;
}

function destBindCanariesMatch(stored: SourceCanary, live: SourceCanary): boolean {
  // HEAD bytes plus a missing index are not source identity. Capture
  // SOURCE_MUTATED still uses canariesEqual, including missing index.
  if (stored.indexSha256 === 'missing' || live.indexSha256 === 'missing') return false;
  return canariesEqual(stored, live);
}

function storedIdentityAuthenticatesProvenance(
  identity: SourceIdentity,
  storedBlobs: readonly CapturedBlobWithBytes[],
): boolean {
  if (!storedIdentityResolvesCoherently(identity)) return false;
  // Overlay-all leaves overlay replacement bytes that a coherent
  // replacement identity does not contain. A subset of unoverlayed blobs
  // (one shared package.json, or two shared json+lock after overlaying
  // bin) is a partial object-set match and must not skip dest-in-live-git
  // — dest inside the original captured checkout stays refused. Every
  // stored blob content must authenticate in stored gitDir before
  // coherence can skip that scan. Bind provenance to the original capture
  // bytes, not a shared-blob count.
  if (storedBlobs.length === 0) return false;
  return storedBlobs.every((blob) => gitDirContainsBlob(identity.gitDir, gitBlobSha1(blob.contents)));
}

function overlayedBlobPaths(overlay: { files?: unknown } | null | undefined): Set<string> {
  if (overlay === null || overlay === undefined || typeof overlay !== 'object') {
    return new Set();
  }
  const files = overlay.files;
  if (files === null || files === undefined || typeof files !== 'object' || Array.isArray(files)) {
    return new Set();
  }
  return new Set(Object.keys(files as Record<string, unknown>));
}

function gitDirContainsOriginalCapturedObjectSet(
  gitDir: string,
  originalBlobs: readonly CapturedBlobWithBytes[],
): boolean {
  return (
    originalBlobs.length > 0 &&
    originalBlobs.every((blob) => gitDirContainsBlob(gitDir, gitBlobSha1(blob.contents)))
  );
}

/**
 * Forged missing identity plus rewritten commit/gitSha plus retargeted canaries
 * make every dest-bind miss. Fail closed unless retained roots resolve as a
 * coherent source identity (live gitDir/commonGitDir match stored) **and**
 * every stored blob content authenticates in that gitDir. Overlay-all
 * replacement bytes do not authenticate in a coherent replacement identity,
 * so coherence alone cannot skip the dest-in-live-git-checkout scan. A
 * singleton unoverlayed blob (one shared package.json) or two shared
 * unoverlayed blobs (json+lock after overlaying bin) is a partial match
 * and cannot skip that scan. One existing unrelated repoPath (for example
 * tmpdir) does not skip that scan. Honest gone-source overlay into an unrelated
 * empty dest has no git ancestor and still persists.
 *
 * Authorized overlay replacement bytes are not Git objects in the original
 * captured object store. When `source.overlay` names those paths and remaining
 * stored blobs are original captured bytes, dest-in-live-git classifies a dest
 * ancestor as captured source only if that checkout contains the original
 * captured object set — not every unrelated evidence git, and not overlay
 * replacement bytes as probes. Overlay-all (no remaining original blobs) still
 * fail-closes on any live git ancestor.
 */
export function assertBundleDirOutsideSourceWhenIdentityUnauthenticated(
  bundleDir: string,
  stored: SourceIdentity,
  storedBlobs: readonly CapturedBlobWithBytes[],
  overlay?: { files: Record<string, string> } | null,
): void {
  if (storedIdentityAuthenticatesProvenance(stored, storedBlobs)) return;
  const overlayed = overlayedBlobPaths(overlay);
  const originalBlobs = storedBlobs.filter((blob) => !overlayed.has(blob.path));
  const classifyByOriginal = overlayed.size > 0 && originalBlobs.length > 0;
  let current = path.resolve(bundleDir);
  const { root } = path.parse(current);
  const seen = new Set<string>();
  for (;;) {
    if (!seen.has(current) && existsSync(current)) {
      seen.add(current);
      let identity: SourceIdentity | undefined;
      try {
        identity = resolveSourceIdentity(current);
      } catch {
        identity = undefined;
      }
      if (identity !== undefined) {
        if (!classifyByOriginal || gitDirContainsOriginalCapturedObjectSet(identity.gitDir, originalBlobs)) {
          assertBundleDirOutsideSource(bundleDir, identity);
        }
      }
    }
    if (current === root) break;
    current = path.dirname(current);
  }
}

export function assertCapturedRowsMatchRecordedCommit(
  identity: SourceIdentity | undefined,
  commit: string,
  captured: readonly CapturedBlob[],
): void {
  if (identity === undefined) {
    throw new ObservedFixtureError(
      'BUNDLE_INVALID',
      'capture bundle is missing a valid source.identity',
    );
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new ObservedFixtureError('BUNDLE_INVALID', 'capture bundle source.commit is not a full commit object ID');
  }
  if (!existsSync(identity.gitDir)) return;
  for (const row of captured) {
    let line: string;
    try {
      line = runGitUtf8(withGitDir(identity.gitDir, ['ls-tree', '--full-tree', commit, '--', row.path]));
    } catch {
      throw new ObservedFixtureError(
        'BUNDLE_INVALID',
        `captured blob does not match source.commit: ${row.path}`,
      );
    }
    const parsed = parseLsTree(line, row.path);
    if (
      parsed === undefined ||
      parsed.type !== 'blob' ||
      parsed.sha !== row.gitSha ||
      parsed.mode !== row.mode
    ) {
      throw new ObservedFixtureError(
        'BUNDLE_INVALID',
        `captured blob does not match source.commit: ${row.path}`,
      );
    }
  }
}

function isAbsoluteIdentityPath(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && path.isAbsolute(value) && !value.startsWith('-');
}

export function parseStoredSourceIdentity(value: unknown): SourceIdentity | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  if (!isAbsoluteIdentityPath(rec.repoPath)) return undefined;
  if (!isAbsoluteIdentityPath(rec.gitDir)) return undefined;
  if (!isAbsoluteIdentityPath(rec.commonGitDir)) return undefined;
  if (rec.worktree !== null && !isAbsoluteIdentityPath(rec.worktree)) return undefined;
  return {
    repoPath: rec.repoPath,
    gitDir: rec.gitDir,
    commonGitDir: rec.commonGitDir,
    worktree: rec.worktree,
  };
}

/** Stored roots always; live re-resolve of `repoPath` is extra when that alias still exists. */
export function overlayContainmentIdentities(stored: SourceIdentity): SourceIdentity[] {
  const identities: SourceIdentity[] = [stored];
  try {
    identities.push(resolveSourceIdentity(stored.repoPath));
  } catch {
    // captured checkout gone, or repoPath is no longer a git directory
  }
  return identities;
}

export function captureGitObjects(
  repo: string,
  requestedRev: string,
  profile: CommittedSourceProfile,
): GitObjectCapture & { blobs: CapturedBlobWithBytes[] } {
  const identity = resolveSourceIdentity(repo);
  const revision = assertRevision(requestedRev);
  let commit: string;
  try {
    commit = runGitUtf8(withGitDir(identity.gitDir, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliUsageError(`cannot resolve revision ${revision}: ${message}`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new CliUsageError(`revision did not resolve to a full commit object ID: ${commit}`);
  }
  const canaryBefore = readCanary(identity.gitDir);
  if (profile.allowedPaths.length > profile.maxFiles) {
    throw new ObservedFixtureError('PROFILE_INVALID', 'profile allowlist exceeds maxFiles');
  }
  const blobs: CapturedBlobWithBytes[] = [];
  const missing: string[] = [];
  for (const relative of profile.allowedPaths) {
    const captured = captureBlob(identity.gitDir, commit, relative, profile.maxFileBytes);
    if (captured === 'missing' || captured === 'oversized') {
      missing.push(relative);
      continue;
    }
    blobs.push(captured);
  }
  return {
    identity,
    gitDir: identity.gitDir,
    worktree: identity.worktree,
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

export function snapshotFiles(blobs: CapturedBlobWithBytes[]): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const blob of blobs) {
    files[blob.path] = blob.contents;
  }
  return files;
}
