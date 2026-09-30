/**
 * AGX-R15/R19: the test-only harness drives the real-run engine as a separate process, with the
 * fake worker injected through the executor constructor. The outcome is one JSON line on stdout
 * and the exit code follows its kind (0 verified, 1 worker-failed / verification-rejected,
 * 3 refused, 2 usage).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixture, invocations, manifestArgs, markerExists, mintApproval, removeFixture, stubCleanCredentials, type Fixture } from '../real-run/support';

const packageRoot = path.join(__dirname, '..', '..');
const tsx = path.join(packageRoot, 'node_modules/tsx/dist/cli.mjs');
const harness = path.join(__dirname, 'real-run-harness.ts');

let fx: Fixture;

beforeEach(async () => {
  stubCleanCredentials();
  fx = await createFixture();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeFixture(fx);
});

function runHarness(args: readonly string[]) {
  // Any credential or provider override on the host would trip AUTH_MODE_MISMATCH in the child.
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$)/.test(name)) delete env[name];
  }
  return spawnSync(process.execPath, [tsx, harness, ...args], { cwd: packageRoot, encoding: 'utf8', env, timeout: 25_000 });
}

function engineArgs(scenario: string): string[] {
  return [
    '--request', fx.requestPath,
    '--approval', fx.approvalPath,
    '--state-dir', fx.stateDir,
    '--scenario', scenario,
    '--record', fx.recordPath,
    ...manifestArgs(fx),
  ];
}

describe('real-run harness process, engine mode', () => {
  it('success: exits 0 with a verified outcome, one invocation and a bundle', async () => {
    const approvalId = await mintApproval(fx, manifestArgs(fx));
    const result = runHarness(engineArgs('success'));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'verified', approvalId, bundleDir: fx.bundleDir });
    expect(invocations(fx)).toHaveLength(1);
    expect(markerExists(fx, approvalId)).toBe(true);
    expect(existsSync(path.join(fx.bundleDir, 'COMPLETE'))).toBe(true);
  });

  it('refused: exits 3 with the refusal code and never spawns the worker', () => {
    const result = runHarness(engineArgs('success'));
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'refused', code: 'APPROVAL_MISSING' });
    expect(invocations(fx)).toHaveLength(0);
  });

  it('worker-failed: exits 1', async () => {
    await mintApproval(fx, manifestArgs(fx));
    const result = runHarness(engineArgs('budget-stop'));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'worker-failed', reason: 'budget' });
  });

  it('SIGTERM during the attempt stops the worker and still ends in one outcome (exit 1, cancel)', async () => {
    await mintApproval(fx, manifestArgs(fx));
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$)/.test(name)) delete env[name];
    }
    const child = spawn(process.execPath, [tsx, harness, ...engineArgs('hang')], { cwd: packageRoot, env });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
    const deadline = Date.now() + 20_000;
    while (invocations(fx).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    child.kill('SIGTERM');
    expect(await exited).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ kind: 'worker-failed', reason: 'cancel' });
  });

  it('a missing manifest flag is a usage error (exit 2) with nothing spawned', () => {
    const args = engineArgs('success');
    args.splice(args.indexOf('--spend-ledger'), 2);
    const result = runHarness(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--spend-ledger is required/);
    expect(invocations(fx)).toHaveLength(0);
  });
});
