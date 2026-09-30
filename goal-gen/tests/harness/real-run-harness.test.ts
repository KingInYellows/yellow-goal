/**
 * AGX-R15: the test-only harness runs as a separate process with the fake worker injected —
 * never the production bin with an environment or PATH override.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { candidateProfileDigest, getCandidateOfflineProfile } from '../../backend/src/cli/candidate-offline-profiles';
import type { RunManifest } from '../../backend/src/cli/run-manifest';

const packageRoot = path.join(__dirname, '..', '..');
const tsx = path.join(packageRoot, 'node_modules/tsx/dist/cli.mjs');
const harness = path.join(__dirname, 'real-run-harness.ts');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'real-run-harness-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeManifest(): Promise<string> {
  const profile = getCandidateOfflineProfile('config-repair', '2');
  const manifest: RunManifest = {
    schemaVersion: 'yellow-goal/run-manifest/v1',
    engineVersion: '0.2.0',
    protocolId: 'yellow-goal/provider-protocol/v2',
    profile: { id: profile.id, version: profile.version, digest: candidateProfileDigest(profile) },
    requestHash: 'd'.repeat(64),
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    allowedTools: ['Edit(./SITE)', 'Edit(./site.json)', 'Read(./**)'],
    disallowedTools: [],
    maxTurns: 8,
    caps: { perActionUsd: 0.5, totalUsd: 5 },
    // Nested inside the spawnSync timeout below, so the executor times out first and cleans up.
    actionTimeoutMs: 10_000,
    runWallClockMs: 120_000,
    authMode: 'subscription',
    attemptCount: 1,
    expiresInMinutes: 60,
    // The executor never reads the evidence destinations; the engine owns them (AGX-R8a).
    evidence: { bundleDir: '/nonexistent/goal-gen/bundle', spendLedgerPath: '/nonexistent/goal-gen/spend.jsonl' },
  };
  const file = path.join(dir, 'manifest.json');
  await writeFile(file, JSON.stringify(manifest), 'utf8');
  return file;
}

function runHarness(manifestPath: string, scenario: string, record: string) {
  // Any credential or provider override on the host would trip AUTH_MODE_MISMATCH in the child.
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$)/.test(name)) delete env[name];
  }
  return spawnSync(process.execPath, [tsx, harness, '--manifest', manifestPath, '--scenario', scenario, '--record', record], {
    cwd: packageRoot,
    encoding: 'utf8',
    env,
    timeout: 20_000,
  });
}

describe('real-run test harness process (AGX-R15)', () => {
  it('success: exits 0 with a metered, succeeded summary and one worker invocation', async () => {
    const record = path.join(dir, 'invocations.jsonl');
    const result = runHarness(await writeManifest(), 'success', record);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as { status: string; costUsd: number; failureClass: string | null };
    expect(summary.status).toBe('succeeded');
    expect(summary.failureClass).toBeNull();
    expect(summary.costUsd).toBeCloseTo(0.0803324);
    expect((await readFile(record, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('missing-cost: exits 1 as cost-unmetered', async () => {
    const record = path.join(dir, 'invocations.jsonl');
    const result = runHarness(await writeManifest(), 'missing-cost', record);
    expect(result.status).toBe(1);
    const summary = JSON.parse(result.stdout) as { status: string; costUsd: number | null; failureClass: string };
    expect(summary).toMatchObject({ status: 'failed', failureClass: 'cost-unmetered', costUsd: null });
  });

  it('usage error: exits 2 without spawning a worker', () => {
    const result = spawnSync(process.execPath, [tsx, harness, '--scenario', 'success'], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: real-run-harness/);
  });
});
