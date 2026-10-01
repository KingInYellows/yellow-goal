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

describe('real-run harness process, rehearsal modes (AGX-R33)', () => {
  function mintArgs(): string[] {
    return ['--mode', 'mint-approval', fx.requestPath, ...manifestArgs(fx), '--out', fx.approvalPath];
  }
  function v2Args(scenario: string, extra: string[] = []): string[] {
    return [
      '--mode', 'protocol-v2', fx.requestPath, '--protocol', 'v2', '--executor', 'agx-claude-code',
      ...manifestArgs(fx), '--approval', fx.approvalPath, '--scenario', scenario, '--record', fx.recordPath, '--state-dir', fx.stateDir, ...extra,
    ];
  }
  const types = (stdout: string): string[] => stdout.trim().split('\n').map((line) => (JSON.parse(line) as { type: string }).type);

  it('mint-approval: mints an approval the production engine accepts, without consuming it', () => {
    const minted = runHarness(mintArgs());
    expect(minted.stderr).toBe('');
    expect(minted.status).toBe(0);
    const { approvalId, path: approvalPath } = JSON.parse(minted.stdout) as { approvalId: string; path: string };
    expect(approvalPath).toBe(fx.approvalPath);
    expect(existsSync(approvalPath)).toBe(true);
    expect(markerExists(fx, approvalId)).toBe(false);
  });

  it('mint-approval: a missing --out is a usage error', () => {
    const args = mintArgs();
    args.splice(args.indexOf('--out'), 2);
    expect(runHarness(args).status).toBe(2);
  });

  it('protocol-v2: the production JSONL stream and exit codes for success, wrong-repair and a reused approval', () => {
    const { approvalId } = JSON.parse(runHarness(mintArgs()).stdout) as { approvalId: string };
    const ok = runHarness(v2Args('success'));
    expect(ok.status).toBe(0);
    expect(ok.stderr).toBe('');
    expect(types(ok.stdout)).toEqual(['run.start', 'run.spend', 'run.summary']);
    expect(JSON.parse(ok.stdout.trim().split('\n')[0]!).payload).toMatchObject({ approvalId, executor: 'agx-claude-code', simulation: false });
    expect(invocations(fx)).toHaveLength(1);

    const reused = runHarness(v2Args('success'));
    expect(reused.status).toBe(1);
    expect(reused.stdout).toBe('');
    expect(JSON.parse(reused.stderr)).toMatchObject({ error: { code: 'APPROVAL_CONSUMED', approvalId } });
    expect(invocations(fx)).toHaveLength(1);
  });

  it('protocol-v2: wrong-repair is verification-rejected with exit 1', () => {
    runHarness(mintArgs());
    const rejected = runHarness(v2Args('wrong-repair'));
    expect(rejected.status).toBe(1);
    expect(JSON.parse(rejected.stdout.trim().split('\n').at(-1)!).payload).toMatchObject({ outcome: 'verification-rejected' });
    expect(JSON.parse(rejected.stderr)).toMatchObject({ error: { code: 'RUN_VERIFICATION_REJECTED' } });
  });

  it('protocol-v2: --yes is a usage error through the production parser (exit 2, nothing spawned)', () => {
    runHarness(mintArgs());
    const result = runHarness(v2Args('success', ['--yes']));
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'USAGE_ERROR' } });
    expect(invocations(fx)).toHaveLength(0);
  });
});
