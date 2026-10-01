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
const V1 = 'yellow-goal/provider-protocol/v1';
const V2 = 'yellow-goal/provider-protocol/v2';
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const fail = (code, message, exit) => { process.stderr.write(JSON.stringify({ error: { code, message } }) + '\\n'); process.exitCode = exit; };
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const capabilities = {
  schemaVersion: 'yellow-goal/provider-capabilities/v1',
  protocolVersion: V1, engineVersion: '0.1.0',
  requestSchemaVersion: 'yellow-goal/request/v1', runEventSchemaVersion: 'yellow-goal/run-event/v1',
  operations: ['capabilities', 'request.create', 'request.validate', 'run', 'version'],
  capabilities: ['run.cancel.os-signal', 'run.executor.stub', 'run.gate.noninteractive', 'run.stdout.jsonl', 'run.timeout'],
  stubScenarios: ['await-cancel', 'budget-exhausted', 'failed', 'success'],
  limits: { maxEventBytes: ${MAX_EVENT_BYTES}, maxQueuedBytes: 4194304, writerFinalizationTimeoutMs: 5000 },
};
const v2Capabilities = () => ({
  ...capabilities, protocolVersion: V2, supportedProtocols: [V1, V2],
  capabilities: mode === 'v2-missing-agx'
    ? capabilities.capabilities
    : ['run.cancel.os-signal', 'run.executor.agx-claude-code', ...(mode === 'v2-legacy-advertised' ? ['run.executor.claude-code'] : []), 'run.executor.stub', 'run.gate.noninteractive', 'run.stdout.jsonl', 'run.timeout'],
});
const summaryOf = (status, reason, extra = {}) => ({ status, goalText: 'fixture', costUsd: 0, replans: 0, reextractions: 0, actions: [], reason, ...extra });
if (args[0] === 'version') emit({ engineVersion: '0.1.0' });
else if (args[0] === 'capabilities') emit(args.includes('v2') ? v2Capabilities() : capabilities);
else if (args[0] === 'request' && args[1] === 'create') {
  writeFileSync(args[args.indexOf('--output') + 1], '{}\\n'); emit({ requestId: 'fixture-request' });
} else if (args[0] === 'request' && args[1] === 'validate') emit({ valid: true });
else if (args[0] === 'run') {
  const protocol = flag('--protocol');
  const executor = flag('--executor');
  if (executor === 'claude-code') {
    if (protocol === 'v2' && mode === 'v2-legacy-accepted') emit({ spawned: 'claude' });
    else fail('USAGE_ERROR', 'usage', 2);
  } else if (executor === 'agx-claude-code') {
    if (mode === 'v2-real-spawn') emit({ spawned: 'claude' });
    else fail('APPROVAL_MISSING', 'no approval', 1);
  } else {
    const scenario = flag('--stub-scenario') ?? 'success';
    const event = (sequence, type, payload) => ({ schemaVersion: 'yellow-goal/run-event/v1', runId: 'fixture-run', sequence, timestamp: '2026-09-04T00:00:00.000Z', type, payload });
    const startPayload = { protocolVersion: protocol === 'v2' ? V2 : V1, executor: 'stub', simulation: true, targetRepositoryHonored: false, stubScenario: scenario };
    if (mode === 'v2-parity-drift' && protocol === 'v2') startPayload.autoConfirm = 'drifted';
    const gate = scenario === 'success' && !args.includes('--yes');
    let summary = summaryOf('succeeded', 'ok');
    let error;
    if (scenario === 'failed') { summary = summaryOf('failed', 'fixture failure'); error = 'RUN_FAILED'; }
    else if (scenario === 'budget-exhausted') { summary = summaryOf('budget-exhausted', 'fixture budget'); error = 'RUN_BUDGET_EXHAUSTED'; }
    else if (gate) { summary = summaryOf('cancelled', 'cancelled at DoD confirmation', { terminationReason: 'gate-required' }); error = 'RUN_GATE_REQUIRED'; }
    else if (scenario === 'await-cancel') {
      const timeout = Number(flag('--timeout-ms'));
      const finish = (terminationReason, code) => {
        emit(event(2, 'run.summary', summaryOf('cancelled', 'fixture ' + terminationReason, { terminationReason })));
        fail(code, 'fixture ' + terminationReason, 1);
        process.exit(1);
      };
      // Handlers first: the smoke signals as soon as it reads stub.waiting.
      process.on('SIGTERM', () => finish('signal', 'RUN_CANCELLED'));
      setTimeout(() => finish('timeout', 'RUN_TIMEOUT'), timeout);
      setTimeout(() => process.exit(3), 30000);
      emit(event(0, 'run.start', startPayload));
      emit(event(1, 'stub.waiting', {}));
    }
    if (scenario !== 'await-cancel') {
      const start = event(0, 'run.start', startPayload);
      const terminal = event(1, 'run.summary', summary);
      if (mode === 'negative-summary-cost') terminal.payload.costUsd = -1;
      if (mode === 'negative-action-cost') terminal.payload.actions = [{ actionId: 'a', status: 'succeeded', attempts: 1, costUsd: -1 }];
      if (mode === 'unsafe-replans') terminal.payload.replans = Number.MAX_SAFE_INTEGER + 1;
      if (mode === 'unsafe-reextractions') terminal.payload.reextractions = Number.MAX_SAFE_INTEGER + 1;
      if (mode === 'unsafe-attempts') terminal.payload.actions = [{ actionId: 'a', status: 'succeeded', attempts: Number.MAX_SAFE_INTEGER + 1, costUsd: 0 }];
      if (mode === 'malformed-timestamp') start.timestamp = '2026';
      if (mode === 'empty-type') start.type = '';
      if (mode === 'array-payload') start.payload = [];
      if (mode === 'preamble') {
        emit(event(0, 'preamble', {}));
        start.sequence = 1; terminal.sequence = 2;
      }
      if (mode === 'event-limit-including-lf') {
        start.payload.padding = '';
        const padding = ${MAX_EVENT_BYTES} - Buffer.byteLength(JSON.stringify(start), 'utf8');
        start.payload.padding = 'x'.repeat(padding);
      }
      emit(start); emit(terminal);
      if (error) fail(error, terminal.payload.reason, 1);
    }
  }
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
    ['v2-missing-agx', /v2 capabilities executors mismatch/],
    ['v2-legacy-advertised', /v2 capabilities executors mismatch/],
    ['v2-parity-drift', /v2 stub run differs from the v1 stub run beyond the protocol id/],
    ['v2-real-spawn', /v2 real run without an approval must exit 1 with zero stdout bytes/],
    ['v2-legacy-accepted', /v2 --executor claude-code must exit 2 with zero stdout bytes/],
  ])('rejects %s with the protocol contract error', async (mode, expected) => {
    const result = await runHarness(mode);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(expected);
  });

  it('accepts a conforming engine through the v1 and v2 checks', async () => {
    const result = await runHarness('ok');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
