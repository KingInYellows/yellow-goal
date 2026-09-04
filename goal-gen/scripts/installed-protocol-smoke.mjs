#!/usr/bin/env node
/** Installed-artifact, zero-spend Provider Protocol v1 smoke. */
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const [bin, expectedVersion, requestPath, targetPath] = process.argv.slice(2);
if (!bin || !expectedVersion || !requestPath || !targetPath) throw new Error('usage: installed-protocol-smoke <bin> <version> <request> <target>');

const scratchRoot = path.dirname(requestPath);
const scratchHome = path.join(scratchRoot, 'home');
const scratchTmp = path.join(scratchRoot, 'tmp');
await mkdir(scratchHome, { recursive: true });
await mkdir(scratchTmp, { recursive: true });

const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 1_048_576;
const CHILD_DEADLINE_MS = 10_000;
const requiredCapabilities = [
  'run.cancel.os-signal', 'run.executor.stub', 'run.gate.noninteractive', 'run.stdout.jsonl', 'run.timeout',
];
const requiredOperations = ['capabilities', 'request.create', 'request.validate', 'run', 'version'];
const requiredScenarios = ['await-cancel', 'budget-exhausted', 'failed', 'success'];

function assert(value, message) { if (!value) throw new Error(message); }

function sameStrings(actual, expected, label) {
  assert(Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]), `${label} mismatch`);
}

function strictUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not strict UTF-8`);
  }
}

function parseFramedJsonLines(bytes, label, { allowEmpty = false } = {}) {
  if (bytes.length === 0) {
    if (allowEmpty) return [];
    throw new Error(`${label} was empty`);
  }
  assert(bytes.length <= MAX_TOTAL_BYTES, `${label} exceeded total byte bound`);
  const text = strictUtf8(bytes, label);
  assert(text.endsWith('\n'), `${label} has an unterminated record`);
  const records = text.slice(0, -1).split('\n');
  assert(records.length > 0 && records.every((record) => record !== ''), `${label} has blank framing`);
  return records.map((record, index) => {
    const line = record.endsWith('\r') ? record.slice(0, -1) : record;
    assert(!line.includes('\r'), `${label} record ${index} has invalid CR framing`);
    assert(Buffer.byteLength(record, 'utf8') + 1 <= MAX_RECORD_BYTES, `${label} record ${index} exceeded byte bound`);
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${label} record ${index} was not JSON`);
    }
  });
}

function exactlyOneJson(bytes, label) {
  const records = parseFramedJsonLines(bytes, label);
  assert(records.length === 1, `${label} must contain exactly one record`);
  return records[0];
}

function errorEnvelope(bytes, label) {
  const payload = exactlyOneJson(bytes, label);
  assert(payload !== null && typeof payload === 'object' && payload.error !== null && typeof payload.error === 'object', `${label} is not a structured error`);
  assert(typeof payload.error.code === 'string' && typeof payload.error.message === 'string', `${label} error shape mismatch`);
  return payload.error;
}

function safeEnvironment() {
  return {
    PATH: process.env.PATH ?? '',
    HOME: scratchHome,
    TMPDIR: scratchTmp,
    XDG_CONFIG_HOME: path.join(scratchHome, '.config'),
    XDG_CACHE_HOME: path.join(scratchHome, '.cache'),
  };
}

function invoke(args, { signalAfterWaiting = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: scratchRoot, env: safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    let stdoutBytes = 0; let stderrBytes = 0; let capturedBytes = 0; let signalled = false; let settled = false;
    let deadline;
    const cleanup = () => {
      if (deadline !== undefined) clearTimeout(deadline);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.stdout.off('error', onStreamError);
      child.stderr.off('error', onStreamError);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const settle = (failure, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) reject(failure); else resolve(result);
    };
    const fail = (message) => {
      try { child.kill('SIGKILL'); } catch { /* best effort after spawn failure */ }
      settle(new Error(message));
    };
    const append = (chunks, chunk, label) => {
      const bytes = Buffer.from(chunk);
      if (label === 'stdout') stdoutBytes += bytes.length; else stderrBytes += bytes.length;
      capturedBytes += bytes.length;
      if ((label === 'stdout' ? stdoutBytes : stderrBytes) > MAX_TOTAL_BYTES || capturedBytes > MAX_TOTAL_BYTES) {
        fail(`${label} exceeded total byte bound`);
        return false;
      }
      chunks.push(bytes);
      return true;
    };
    const onStdout = (chunk) => {
      if (!append(stdout, chunk, 'stdout') || settled) return;
      if (signalAfterWaiting && !signalled && Buffer.concat(stdout).includes(Buffer.from('"stub.waiting"'))) {
        signalled = true;
        child.kill('SIGTERM');
      }
    };
    const onStderr = (chunk) => { append(stderr, chunk, 'stderr'); };
    const onError = (cause) => settle(new Error(`protocol child spawn error: ${cause.message}`));
    const onStreamError = (cause) => fail(`protocol child stream error: ${cause.message}`);
    const onClose = (code, signal) => settle(undefined, {
      code, signal, signalled, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
    });
    deadline = setTimeout(() => fail(`protocol child timed out: ${args.join(' ')}`), CHILD_DEADLINE_MS);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.stdout.once('error', onStreamError);
    child.stderr.once('error', onStreamError);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

async function git(args) {
  const { stdout } = await execFileAsync('git', ['-C', targetPath, ...args], { cwd: scratchRoot, env: safeEnvironment() });
  return stdout;
}

async function snapshotTarget() {
  return {
    head: (await git(['rev-parse', 'HEAD'])).trim(),
    tree: (await git(['write-tree'])).trim(),
    status: await git(['status', '--porcelain=v1']),
    sentinel: await readFile(path.join(targetPath, 'protocol-smoke-sentinel.txt'), 'utf8'),
  };
}

async function assertTargetUnchanged(before) {
  const after = await snapshotTarget();
  assert(JSON.stringify(after) === JSON.stringify(before), 'scratch target changed during installed protocol smoke');
}

function assertRun(result, scenario, expected) {
  const events = parseFramedJsonLines(result.stdout, `${scenario} stdout`);
  assert(events.every((event) => event !== null && typeof event === 'object'), `${scenario}: non-object event`);
  assert(events.length > 1, `${scenario}: too few events`);
  const runIds = new Set(events.map((event) => event.runId));
  assert(runIds.size === 1 && typeof events[0].runId === 'string' && events[0].runId !== '', `${scenario}: run identity mismatch`);
  assert(events.every((event, index) => event.schemaVersion === 'yellow-goal/run-event/v1' && event.sequence === index && typeof event.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(event.timestamp) && !Number.isNaN(Date.parse(event.timestamp)) && typeof event.type === 'string' && event.type !== '' && event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)), `${scenario}: event contract mismatch`);
  const starts = events.filter((event) => event.type === 'run.start');
  const summaries = events.filter((event) => event.type === 'run.summary');
  assert(starts.length === 1 && summaries.length === 1 && events[0] === starts[0] && events.at(-1) === summaries[0], `${scenario}: start/terminal cardinality mismatch`);
  assert(starts[0].payload.protocolVersion === 'yellow-goal/provider-protocol/v1' && starts[0].payload.executor === 'stub' && starts[0].payload.simulation === true && starts[0].payload.targetRepositoryHonored === false && starts[0].payload.stubScenario === expected.scenario, `${scenario}: start payload mismatch`);
  const summary = summaries[0].payload;
  assert(summary.status === expected.status && typeof summary.goalText === 'string' && typeof summary.costUsd === 'number' && Number.isFinite(summary.costUsd) && summary.costUsd >= 0 && Number.isSafeInteger(summary.replans) && summary.replans >= 0 && Number.isSafeInteger(summary.reextractions) && summary.reextractions >= 0 && Array.isArray(summary.actions) && summary.actions.every((action) => action !== null && typeof action === 'object' && typeof action.actionId === 'string' && (action.status === 'succeeded' || action.status === 'failed') && Number.isSafeInteger(action.attempts) && action.attempts >= 0 && typeof action.costUsd === 'number' && Number.isFinite(action.costUsd) && action.costUsd >= 0) && typeof summary.reason === 'string', `${scenario}: summary contract mismatch`);
  if (expected.terminationReason === undefined) {
    assert(!Object.hasOwn(summary, 'terminationReason'), `${scenario}: unexpected termination reason`);
  } else {
    assert(summary.terminationReason === expected.terminationReason, `${scenario}: termination reason mismatch`);
  }
  if (expected.errorCode === undefined) {
    assert(result.code === 0 && result.signal === null && result.stderr.length === 0, `${scenario}: expected successful empty stderr`);
  } else {
    assert(result.code === 1 && result.signal === null, `${scenario}: expected exit 1`);
    const stderr = errorEnvelope(result.stderr, `${scenario} stderr`);
    assert(stderr.code === expected.errorCode && stderr.message === summary.reason, `${scenario}: stderr/summary disagreement`);
  }
}

const before = await snapshotTarget();
try {
  const versionResult = await invoke(['version', '--json']);
  assert(versionResult.code === 0 && versionResult.stderr.length === 0, 'installed version command failed');
  const version = exactlyOneJson(versionResult.stdout, 'version stdout');
  assert(version.engineVersion === expectedVersion, 'installed version mismatch');

  const capabilitiesResult = await invoke(['capabilities', '--json']);
  assert(capabilitiesResult.code === 0 && capabilitiesResult.stderr.length === 0, 'capabilities command failed');
  const capabilities = exactlyOneJson(capabilitiesResult.stdout, 'capabilities stdout');
  assert(capabilities.schemaVersion === 'yellow-goal/provider-capabilities/v1' && capabilities.protocolVersion === 'yellow-goal/provider-protocol/v1' && capabilities.engineVersion === expectedVersion && capabilities.requestSchemaVersion === 'yellow-goal/request/v1' && capabilities.runEventSchemaVersion === 'yellow-goal/run-event/v1', 'capabilities identity mismatch');
  sameStrings(capabilities.operations, requiredOperations, 'capabilities operations');
  sameStrings(capabilities.capabilities, requiredCapabilities, 'capabilities list');
  sameStrings(capabilities.stubScenarios, requiredScenarios, 'stub scenarios');
  assert(capabilities.limits !== null && typeof capabilities.limits === 'object' && capabilities.limits.maxEventBytes === MAX_RECORD_BYTES && capabilities.limits.maxQueuedBytes === MAX_TOTAL_BYTES && capabilities.limits.writerFinalizationTimeoutMs === 5_000, 'capabilities limits mismatch');

  const created = await invoke(['request', 'create', '--repo', targetPath, '--goal', 'protocol smoke', '--output', requestPath, '--json']);
  assert(created.code === 0 && created.stderr.length === 0, 'request create failed');
  const createOutput = exactlyOneJson(created.stdout, 'request create stdout');
  assert(typeof createOutput.requestId === 'string' && createOutput.requestId !== '', 'request create output missing requestId');
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  request.mode = 'approved-implementation';
  request.constraints = { ...(request.constraints ?? {}), readOnlyTarget: false, allowTargetEdits: true };
  request.orchestration = { ...(request.orchestration ?? {}), permissionProfile: 'implement', execution: { autoConfirmDod: true } };
  await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8');
  const valid = await invoke(['request', 'validate', requestPath, '--json']);
  assert(valid.code === 0 && valid.stderr.length === 0 && exactlyOneJson(valid.stdout, 'request validate stdout').valid === true, 'request validate failed');

  for (const expected of [
    { scenario: 'success', status: 'succeeded' },
    { scenario: 'failed', status: 'failed', errorCode: 'RUN_FAILED' },
    { scenario: 'budget-exhausted', status: 'budget-exhausted', errorCode: 'RUN_BUDGET_EXHAUSTED' },
  ]) {
    assertRun(await invoke(['run', requestPath, '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', expected.scenario, '--yes']), expected.scenario, expected);
  }

  const gateRequest = { ...request, orchestration: { ...request.orchestration, execution: { autoConfirmDod: false } } };
  await writeFile(requestPath, `${JSON.stringify(gateRequest)}\n`, 'utf8');
  assertRun(await invoke(['run', requestPath, '--executor', 'stub', '--protocol', 'v1']), 'gate', { scenario: 'success', status: 'cancelled', terminationReason: 'gate-required', errorCode: 'RUN_GATE_REQUIRED' });

  await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8');
  assertRun(await invoke(['run', requestPath, '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', 'await-cancel', '--timeout-ms', '5']), 'timeout', { scenario: 'await-cancel', status: 'cancelled', terminationReason: 'timeout', errorCode: 'RUN_TIMEOUT' });
  const signalled = await invoke(['run', requestPath, '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', 'await-cancel', '--timeout-ms', '5000'], { signalAfterWaiting: true });
  assert(signalled.signalled, 'signal scenario never observed stub.waiting');
  assertRun(signalled, 'signal', { scenario: 'await-cancel', status: 'cancelled', terminationReason: 'signal', errorCode: 'RUN_CANCELLED' });
} finally {
  await assertTargetUnchanged(before);
}

console.log('installed protocol smoke passed');
