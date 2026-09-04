/**
 * Release publication is tested against command shims only. It never contacts
 * GitHub, npm, a provider, or an executor.
 */
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = path.join(packageRoot, 'scripts');
const tempDirs: string[] = [];

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'goal-gen-release-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function installFakes(dir: string): Promise<{ bin: string; state: string; remote: string; log: string }> {
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'release-state');
  const remote = path.join(dir, 'remote-asset');
  const log = path.join(dir, 'commands.log');
  await mkdir(bin);
  const fake = path.join(bin, 'fake-command');
  await writeFile(
    fake,
    `#!/usr/bin/env bash
set -euo pipefail
name="$(basename "$0")"
echo "$name $*" >> "$FAKE_LOG"
case "$name" in
  git)
    if [ "$1" = "cat-file" ]; then echo "\${FAKE_TAG_TYPE:-tag}"; else
      if [ "$2" = "HEAD" ]; then echo "\${FAKE_HEAD:-commit-a}"; else echo "\${FAKE_TAG_COMMIT:-commit-a}"; fi
    fi
    ;;
  npm)
    test "$1" = "pack"
    test -z "\${GH_TOKEN:-}"
    test -z "\${GITHUB_TOKEN:-}"
    shift
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--pack-destination" ]; then mkdir -p "$2"; printf 'prepared' > "$2/goal-gen-0.1.0.tgz"; exit 0; fi
      shift
    done
    exit 1
    ;;
  gh)
    test -n "\${GH_TOKEN:-}"
    if [ "$1" = "release" ] && [ "$2" = "view" ]; then
      if [ ! -f "$FAKE_STATE" ]; then echo "release not found" >&2; exit 1; fi
      read -r draft asset < "$FAKE_STATE"
      if [ "$asset" = "yes" ]; then assets='[{"name":"goal-gen-0.1.0.tgz"}]'; else assets='[]'; fi
      printf '{"tagName":"%s","isDraft":%s,"assets":%s}' "\${FAKE_RELEASE_TAG:-v0.1.0}" "$draft" "$assets"
    elif [ "$1" = "release" ] && [ "$2" = "create" ]; then
      printf 'true no\n' > "$FAKE_STATE"
    elif [ "$1" = "release" ] && [ "$2" = "upload" ]; then
      if [ "\${FAKE_FAIL_UPLOAD_ONCE:-}" = "yes" ] && [ ! -e "$FAKE_UPLOAD_FAILED" ]; then touch "$FAKE_UPLOAD_FAILED"; exit 1; fi
      cp "$4" "$FAKE_REMOTE"
      read -r draft _ < "$FAKE_STATE"
      printf '%s yes\n' "$draft" > "$FAKE_STATE"
    elif [ "$1" = "release" ] && [ "$2" = "download" ]; then
      read -r _ asset < "$FAKE_STATE"
      test "$asset" = "yes"
      if [ "\${FAKE_FAIL_DOWNLOAD_ONCE:-}" = "yes" ] && [ ! -e "$FAKE_DOWNLOAD_FAILED" ]; then
        touch "$FAKE_DOWNLOAD_FAILED"
        exit 1
      fi
      while [ "$#" -gt 0 ]; do
        if [ "$1" = "--dir" ]; then cp "$FAKE_REMOTE" "$2/goal-gen-0.1.0.tgz"; exit 0; fi
        shift
      done
      exit 1
    elif [ "$1" = "release" ] && [ "$2" = "delete-asset" ]; then
      printf 'true no\n' > "$FAKE_STATE"
    elif [ "$1" = "release" ] && [ "$2" = "edit" ]; then
      printf 'false yes\n' > "$FAKE_STATE"
    else
      echo "unexpected gh command: $*" >&2; exit 1
    fi
    ;;
esac
`,
  );
  await chmod(fake, 0o755);
  for (const name of ['git', 'npm', 'gh']) await symlink('fake-command', path.join(bin, name));
  return { bin, state, remote, log };
}

function run(script: string, bin: string, temp: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [path.join(scriptsDir, script)], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GITHUB_REF_NAME: 'v0.1.0',
      GITHUB_REPOSITORY: 'KingInYellows/yellow-goal',
      RUNNER_TEMP: temp,
      GH_TOKEN: 'test-token',
      GITHUB_TOKEN: 'test-token',
      FAKE_LOG: path.join(temp, 'commands.log'),
      FAKE_STATE: path.join(temp, 'release-state'),
      FAKE_REMOTE: path.join(temp, 'remote-asset'),
      ...extra,
    },
  });
}

describe('release asset scripts', () => {
  it('rejects package version mismatch before packing', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    const result = run('prepare-release-asset.sh', fake.bin, temp, { GITHUB_REF_NAME: 'v9.9.9' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match package.json');
    expect(await readFile(fake.log, 'utf8')).not.toContain('npm pack');
  });

  it('rejects existing release metadata for a different tag', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    await writeFile(path.join(temp, 'goal-gen-0.1.0.tgz'), 'prepared');
    await writeFile(fake.state, 'true no\n');
    const result = run('publish-release-asset.sh', fake.bin, temp, { FAKE_RELEASE_TAG: 'v9.9.9' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release identity or metadata mismatch');
    expect(await readFile(fake.log, 'utf8')).not.toContain('gh release upload');
  });

  it('publisher rechecks the annotated tag target before any GitHub operation', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    await writeFile(path.join(temp, 'goal-gen-0.1.0.tgz'), 'prepared');
    const result = run('publish-release-asset.sh', fake.bin, temp, {
      FAKE_TAG_COMMIT: 'commit-from-tag',
      FAKE_HEAD: 'checkout-head',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not peel to checkout HEAD');
    expect(await readFile(fake.log, 'utf8')).not.toContain('gh release');
  });

  it('recovers a draft asset left present but not downloadable by a failed upload', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    await writeFile(path.join(temp, 'goal-gen-0.1.0.tgz'), 'prepared');
    await writeFile(fake.state, 'true yes\n');
    expect(run('publish-release-asset.sh', fake.bin, temp).status).toBe(0);
    expect(await readFile(fake.state, 'utf8')).toBe('false yes\n');
    expect(await readFile(fake.log, 'utf8')).toContain('gh release delete-asset');
  });

  it('adds a missing asset to a partially published release', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    await writeFile(path.join(temp, 'goal-gen-0.1.0.tgz'), 'prepared');
    await writeFile(fake.state, 'false no\n');
    expect(run('publish-release-asset.sh', fake.bin, temp).status).toBe(0);
    expect(await readFile(fake.state, 'utf8')).toBe('false yes\n');
    expect(await readFile(fake.log, 'utf8')).not.toContain('gh release edit');
  });

  it('packs a matching annotated tag with tokens removed from npm', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    const result = run('prepare-release-asset.sh', fake.bin, temp);
    expect(result.status).toBe(0);
    await expect(readFile(path.join(temp, 'goal-gen-0.1.0.tgz'), 'utf8')).resolves.toBe('prepared');
    await expect(readFile(path.join(temp, 'goal-gen-0.1.0.tgz.sha256'), 'utf8')).resolves.toContain('goal-gen-0.1.0.tgz');
  });

  it('rejects a lightweight tag before packing', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    const result = run('prepare-release-asset.sh', fake.bin, temp, { FAKE_TAG_TYPE: 'commit' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not annotated');
    await expect(readFile(fake.log, 'utf8')).resolves.not.toContain('npm pack');
  });

  it('rejects an annotated tag that does not peel to checkout HEAD', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    const result = run('prepare-release-asset.sh', fake.bin, temp, {
      FAKE_TAG_COMMIT: 'commit-from-tag',
      FAKE_HEAD: 'checkout-head',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('peels to');
  });

  it('creates a metadata-only draft, uploads, verifies, and publishes', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    await writeFile(path.join(temp, 'goal-gen-0.1.0.tgz'), 'prepared');
    const result = run('publish-release-asset.sh', fake.bin, temp);
    expect(result.status).toBe(0);
    await expect(readFile(fake.state, 'utf8')).resolves.toBe('false yes\n');
    await expect(readFile(fake.log, 'utf8')).resolves.toMatch(/gh release create[\s\S]*gh release upload[\s\S]*gh release download[\s\S]*gh release edit/);
  });

  it('recovers a draft after a failed upload on a later rerun', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    await writeFile(path.join(temp, 'goal-gen-0.1.0.tgz'), 'prepared');
    expect(run('publish-release-asset.sh', fake.bin, temp, { FAKE_FAIL_UPLOAD_ONCE: 'yes', FAKE_UPLOAD_FAILED: path.join(temp, 'failed') }).status).toBe(1);
    await expect(readFile(fake.state, 'utf8')).resolves.toBe('true no\n');
    expect(run('publish-release-asset.sh', fake.bin, temp, { FAKE_FAIL_UPLOAD_ONCE: 'yes', FAKE_UPLOAD_FAILED: path.join(temp, 'failed') }).status).toBe(0);
    await expect(readFile(fake.state, 'utf8')).resolves.toBe('false yes\n');
  });

  it('leaves a draft recoverable when post-upload verification download fails', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    await writeFile(path.join(temp, 'goal-gen-0.1.0.tgz'), 'prepared');
    const failureMarker = path.join(temp, 'download-failed');
    const extra = {
      FAKE_FAIL_DOWNLOAD_ONCE: 'yes',
      FAKE_DOWNLOAD_FAILED: failureMarker,
    };

    expect(run('publish-release-asset.sh', fake.bin, temp, extra).status).toBe(1);
    await expect(readFile(fake.state, 'utf8')).resolves.toBe('true yes\n');
    expect(await readFile(fake.log, 'utf8')).not.toContain('gh release edit');

    expect(run('publish-release-asset.sh', fake.bin, temp, extra).status).toBe(0);
    await expect(readFile(fake.state, 'utf8')).resolves.toBe('false yes\n');
  });

  it('repairs a mismatched draft asset but never clobbers a published mismatch', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    await writeFile(path.join(temp, 'goal-gen-0.1.0.tgz'), 'prepared');
    await writeFile(fake.state, 'true yes\n');
    await writeFile(fake.remote, 'wrong');
    expect(run('publish-release-asset.sh', fake.bin, temp).status).toBe(0);
    await expect(readFile(fake.state, 'utf8')).resolves.toBe('false yes\n');

    await writeFile(fake.state, 'false yes\n');
    await writeFile(fake.remote, 'wrong-again');
    const result = run('publish-release-asset.sh', fake.bin, temp);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to clobber');
  });

  it('is a no-op when a published release already has the same asset', async () => {
    const temp = await makeTemp();
    const fake = await installFakes(temp);
    await writeFile(path.join(temp, 'goal-gen-0.1.0.tgz'), 'prepared');
    await writeFile(fake.state, 'false yes\n');
    await writeFile(fake.remote, 'prepared');
    expect(run('publish-release-asset.sh', fake.bin, temp).status).toBe(0);
    const log = await readFile(fake.log, 'utf8');
    expect(log).toContain('gh release download');
    expect(log).not.toContain('gh release upload');
    expect(log).not.toContain('gh release delete-asset');
    expect(log).not.toContain('gh release edit');
  });
});
