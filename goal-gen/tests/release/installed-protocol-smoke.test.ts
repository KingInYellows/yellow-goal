import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const MAX_EVENT_BYTES = 1_048_576;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const smoke = path.join(packageRoot, 'scripts', 'installed-protocol-smoke.mjs');
const roots: string[] = [];

function fakeEngine(mode: string): string {
  return `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const emit = (value) => process.stdout.write(\`${'${JSON.stringify(value)}'}\\n\`);
const capabilities = {
  schemaVersion: 'yellow-goal/provider-capabilities/v1',
  protocolVersion: 'yellow-goal/provider-protocol/v1', engineVersion: '0.1.0',
  requestSchemaVersion: 'yellow-goal/request/v1', runEventSchemaVersion: 'yellow-goal/run-event/v1',
  operations: ['capabilities', 'request.create', 'request.validate', 'run', 'version'],
  capabilities: ['run.cancel.os-signal', 'run.executor.stub', 'run.gate.noninteractive', 'run.stdout.jsonl', 'run.timeout'],
  stubScenarios: ['await-cancel', 'budget-exhausted', 'failed', 'success'],
  limits: { maxEventBytes: ${MAX_EVENT_BYTES}, maxQueuedBytes: 4194304, writerFinalizationTimeoutMs: 5000 },
};
if (args[0] === 'version') emit({ engineVersion: '0.1.0' });
else if (args[0] === 'capabilities') emit(capabilities);
else if (args[0] === 'request' && args[1] === 'create') {
  writeFileSync(args[args.indexOf('--output') + 1], '{}\\n'); emit({ requestId: 'fixture-request' });
} else if (args[0] === 'request' && args[1] === 'validate') emit({ valid: true });
else if (args[0] === 'run') {
  const event = (sequence, type, payload) => ({ schemaVersion: 'yellow-goal/run-event/v1', runId: 'fixture-run', sequence, timestamp: '2026-09-04T00:00:00.000Z', type, payload });
  const start = event(0, 'run.start', { protocolVersion: 'yellow-goal/provider-protocol/v1', executor: 'stub', simulation: true, targetRepositoryHonored: false, stubScenario: 'success' });
  const summary = event(1, 'run.summary', { status: 'succeeded', goalText: 'fixture', costUsd: 0, replans: 0, reextractions: 0, actions: [], reason: 'ok' });
  if (mode === 'negative-summary-cost') summary.payload.costUsd = -1;
  if (mode === 'negative-action-cost') summary.payload.actions = [{ actionId: 'a', status: 'succeeded', attempts: 1, costUsd: -1 }];
  if (mode === 'unsafe-replans') summary.payload.replans = Number.MAX_SAFE_INTEGER + 1;
  if (mode === 'unsafe-reextractions') summary.payload.reextractions = Number.MAX_SAFE_INTEGER + 1;
  if (mode === 'unsafe-attempts') summary.payload.actions = [{ actionId: 'a', status: 'succeeded', attempts: Number.MAX_SAFE_INTEGER + 1, costUsd: 0 }];
  if (mode === 'malformed-timestamp') start.timestamp = '2026';
  if (mode === 'empty-type') start.type = '';
  if (mode === 'array-payload') start.payload = [];
  if (mode === 'preamble') {
    emit(event(0, 'preamble', {}));
    start.sequence = 1; summary.sequence = 2;
  }
  if (mode === 'event-limit-including-lf') {
    start.payload.padding = '';
    const padding = ${MAX_EVENT_BYTES} - Buffer.byteLength(JSON.stringify(start), 'utf8');
    start.payload.padding = 'x'.repeat(padding);
  }
  emit(start); emit(summary);
} else process.exitCode = 2;
`;
}

async function runHarness(mode: string): Promise<{ stderr: string; status: number | null }> {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), 'installed-protocol-negative-'));
  roots.push(root);
  const home = path.join(root, 'home');
  await mkdir(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1' };
  const gitOptions = { env, timeout: 10_000 };
  const target = path.join(root, 'target');
  const request = path.join(root, 'request.json');
  const fake = path.join(root, 'fake-goal-gen.mjs');
  await writeFile(fake, fakeEngine(mode), 'utf8');
  await chmod(fake, 0o755);
  execFileSync('git', ['init', '-q', target], gitOptions);
  await writeFile(path.join(target, 'protocol-smoke-sentinel.txt'), 'untouched\n', 'utf8');
  execFileSync('git', ['-C', target, 'add', 'protocol-smoke-sentinel.txt'], gitOptions);
  execFileSync('git', ['-C', target, '-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture'], gitOptions);
  const result = spawnSync(process.execPath, [smoke, fake, '0.1.0', request, target], {
    encoding: 'utf8', env, timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status === 0) {
    throw new Error('installed harness unexpectedly accepted malformed run output');
  }
  return { stderr: result.stderr ?? '', status: result.status };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('installed protocol smoke negative contracts', () => {
  it.each([
    ['negative-summary-cost', /success: summary contract mismatch/],
    ['negative-action-cost', /success: summary contract mismatch/],
    ['unsafe-replans', /success: summary contract mismatch/],
    ['unsafe-reextractions', /success: summary contract mismatch/],
    ['unsafe-attempts', /success: summary contract mismatch/],
    ['malformed-timestamp', /success: event contract mismatch/],
    ['empty-type', /success: event contract mismatch/],
    ['array-payload', /success: event contract mismatch/],
    ['preamble', /success: start\/terminal cardinality mismatch/],
    ['event-limit-including-lf', /success stdout record 0 exceeded byte bound/],
  ])('rejects %s with the protocol contract error', async (mode, expected) => {
    const result = await runHarness(mode);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(expected);
  });
});
