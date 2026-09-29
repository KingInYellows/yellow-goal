/**
 * ADR-0020 / AGX-R1: `run manifest` and `run approve` spend nothing — a sentinel `claude` (and
 * `git`) on PATH records zero invocations when the verbs run as a real process.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestExecutionSample } from '../contracts/support/samples';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(packageRoot, 'backend/src/cli/index.ts');
const tsx = path.join(packageRoot, 'node_modules/tsx/dist/cli.mjs');

let cwd: string;
let binDir: string;
let requestPath: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'goal-gen-run-approval-spawn-'));
  binDir = path.join(cwd, 'bin');
  await mkdir(binDir);
  for (const name of ['claude', 'git']) {
    await writeFile(path.join(binDir, name), `#!/bin/sh\nprintf 'invoked\\n' >> '${path.join(cwd, `${name}-invoked`)}'\nexit 97\n`, {
      encoding: 'utf8',
      mode: 0o755,
    });
  }
  requestPath = path.join(cwd, 'request.json');
  await writeFile(requestPath, `${JSON.stringify(requestExecutionSample)}\n`, 'utf8');
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    // Two sequential spawns must fit inside vitest's 30s testTimeout.
    timeout: 12_000,
    ...(input !== undefined ? { input } : {}),
  });
}

const flags = [
  '--profile', 'config-repair',
  '--max-turns', '8',
  '--per-action-usd', '1',
  '--total-usd', '5',
  '--auth-mode', 'subscription',
  '--allowed-tool', 'Edit',
];

describe('approval verbs never spawn', () => {
  it('run manifest and a run approve refused despite the correct piped challenge record zero claude/git invocations', async () => {
    const manifest = runCli(['run', 'manifest', requestPath, ...flags, '--json']);
    expect(manifest.status).toBe(0);
    expect(manifest.stderr).toBe('');
    const { challenge } = JSON.parse(manifest.stdout) as { challenge: string };

    const approve = runCli(['run', 'approve', requestPath, ...flags, '--out', path.join(cwd, 'a.json')], `${challenge}\n`);
    expect(approve.status).toBe(1);
    expect(JSON.parse(approve.stderr)).toMatchObject({ error: { code: 'APPROVAL_TTY_REQUIRED' } });
    expect(approve.stdout).toBe('');
    await expect(readFile(path.join(cwd, 'a.json'), 'utf8')).rejects.toThrow();

    await expect(readFile(path.join(cwd, 'claude-invoked'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(cwd, 'git-invoked'), 'utf8')).rejects.toThrow();
  });
});
