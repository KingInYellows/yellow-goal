/**
 * Materializes a checked-in fixture repository tree (`tests/fixtures/repositories/<class>/`) into a
 * fresh, real git repository in a temp dir, with a deterministic commit (fixed author/committer
 * identity + date) so every machine produces the identical HEAD SHA for the same fixture tree.
 *
 * Deliberately separate from `backend/src/inspection/git.ts`: that module is metadata-only by
 * design (no exported init/add/commit — see its file-top comment) and must stay that way. This
 * helper needs to WRITE a throwaway repo (git init/add/commit against a temp copy of fixture
 * source files, never against the real target repository), so it keeps its own small, private,
 * isolated-env spawn wrapper rather than importing one meant to guarantee read-only-content
 * inspection.
 *
 * Rename manifest: `goal-gen/.gitignore` ignores `.env`/`.env.*` repo-wide, so a fixture source
 * file literally named `.env` would silently fail to get committed into this monorepo. Fixture
 * classes that need such a filename in the MATERIALIZED repo (e.g. `protected-file`) instead check
 * in a safely-named source file and list a rename in an optional `__fixture-manifest.json` at the
 * fixture root: `{ "renames": { "sourceName": "targetName" } }`. The manifest itself is fixture
 * metadata, not simulated repo content, so it is never copied into the materialized repo.
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_ROOT = dirname(fileURLToPath(import.meta.url));
const MANIFEST_NAME = '__fixture-manifest.json';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** Fixed so the same fixture tree always produces the same commit SHA, on any machine/timezone. */
const FIXTURE_COMMIT_DATE = '2024-01-01T00:00:00+00:00';
const FIXTURE_AUTHOR_NAME = 'goal-gen-fixtures';
const FIXTURE_AUTHOR_EMAIL = 'fixtures@goal-gen.local';

function runGit(args: readonly string[], cwd: string, extraEnv?: NodeJS.ProcessEnv): void {
  const r: SpawnSyncReturns<string> = spawnSync('git', args, {
    cwd,
    env: { ...GIT_ENV, ...extraEnv },
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });
  if (r.error) throw new Error(`git ${args.join(' ')} failed to spawn: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${r.status}: ${(r.stderr ?? '').trim()}`);
  }
}

function runGitCapture(args: readonly string[], cwd: string): string {
  const r: SpawnSyncReturns<string> = spawnSync('git', args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });
  if (r.error || r.status !== 0) {
    const detail = r.error ? r.error.message : (r.stderr ?? '').trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
  return r.stdout ?? '';
}

interface FixtureManifest {
  renames?: Record<string, string>;
}

async function readManifest(dir: string): Promise<FixtureManifest> {
  const manifestPath = join(dir, MANIFEST_NAME);
  try {
    const raw = await readFile(manifestPath, 'utf8');
    return JSON.parse(raw) as FixtureManifest;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

export interface FixtureRepoHandle {
  /** Absolute path to the materialized, git-initialized repo. */
  dir: string;
  /** HEAD SHA of the deterministic fixture commit. */
  headSha: string;
  /** Remove the temp dir. Idempotent. */
  cleanup(): Promise<void>;
}

/**
 * Copies `tests/fixtures/repositories/<fixtureName>/` into a fresh temp dir, applies any rename
 * manifest, and creates a single deterministic commit. Rejects `fixtureName` values that would
 * escape the fixtures root (defensive, even though callers are trusted test code).
 */
export async function initFixtureRepo(fixtureName: string): Promise<FixtureRepoHandle> {
  const srcDir = resolve(FIXTURES_ROOT, fixtureName);
  const normalizedRoot = resolve(FIXTURES_ROOT) + sep;
  if (!(srcDir + sep).startsWith(normalizedRoot) || normalize(fixtureName).startsWith('..')) {
    throw new Error(`fixtureName "${fixtureName}" escapes the fixtures root — rejected`);
  }
  const srcStat = await stat(srcDir).catch(() => null);
  if (!srcStat?.isDirectory()) {
    throw new Error(`fixture "${fixtureName}" not found at ${srcDir}`);
  }

  const dir = await mkdtemp(join(tmpdir(), 'goal-gen-fixture-'));
  try {
    await cp(srcDir, dir, { recursive: true });

    const manifest = await readManifest(dir);
    await unlink(join(dir, MANIFEST_NAME)).catch(() => {});
    for (const [from, to] of Object.entries(manifest.renames ?? {})) {
      const fromPath = resolve(dir, from);
      const toPath = resolve(dir, to);
      const dirPrefix = resolve(dir) + sep;
      if (!(fromPath + sep).startsWith(dirPrefix) && fromPath !== dirPrefix.slice(0, -1)) {
        throw new Error(`fixture "${fixtureName}" rename source "${from}" escapes the materialized repo`);
      }
      if (!(toPath + sep).startsWith(dirPrefix) && toPath !== dirPrefix.slice(0, -1)) {
        throw new Error(`fixture "${fixtureName}" rename target "${to}" escapes the materialized repo`);
      }
      await mkdir(dirname(toPath), { recursive: true });
      await rename(fromPath, toPath);
    }

    runGit(['init', '-q', '-b', 'main'], dir);
    runGit(['add', '-A'], dir);
    runGit(
      ['-c', `user.name=${FIXTURE_AUTHOR_NAME}`, '-c', `user.email=${FIXTURE_AUTHOR_EMAIL}`, 'commit', '-q', '-m', `fixture: ${fixtureName}`],
      dir,
      { GIT_AUTHOR_DATE: FIXTURE_COMMIT_DATE, GIT_COMMITTER_DATE: FIXTURE_COMMIT_DATE },
    );
    const headSha = runGitCapture(['rev-parse', 'HEAD'], dir).trim();

    return {
      dir,
      headSha,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}
