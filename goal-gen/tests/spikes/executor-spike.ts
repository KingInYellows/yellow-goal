/**
 * Executor de-risk spike — THROWAWAY. See `plans/executor-de-risk-spike.md`.
 *
 * Proves the executor + ground-truth verification mechanics end-to-end against
 * the host `claude` CLI, in full isolation, then prints a FINDINGS SUMMARY that
 * seeds `tests/spikes/executor-spike-findings.md`. It does NOT commit to the
 * production `Executor` interface (`.claude/specs/executor-router.md`).
 *
 * Flow: preflight → scratch git repo + worktree → headless `claude -p` run →
 * zod-parse the JSON envelope → ground-truth diff → `node --test` verify →
 * teardown (always) → findings summary.
 *
 * Run on a host with `claude` logged in via subscription, as a non-root user,
 * with ANTHROPIC_API_KEY unset:
 *   node --experimental-strip-types tests/spikes/executor-spike.ts
 * (On Node >=24.3 the flag is optional/no-warning; required on Node 22.)
 *
 * Invariants exercised: #2 (world state from ground truth, never a declared
 * effect), #3 (every action has a verify), #5 (worktree = collision-avoidance,
 * not a sandbox — the scratch repo lives in os.tmpdir(), zero contact with this
 * repo). See CLAUDE.md.
 *
 * Teardown safety: we use `process.exitCode` (not `process.exit()`, which would
 * skip the `finally` and leak the worktree) and route all failures through a
 * thrown SpikeError so the `finally` teardown always runs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config (env-overridable). Cost is OBSERVED, never asserted (ADR-0012).
// ---------------------------------------------------------------------------
const rawTimeoutMs = process.env['SPIKE_TIMEOUT_MS'];
const TIMEOUT_MS = rawTimeoutMs === undefined ? 120_000 : Number(rawTimeoutMs);
// `??` only guards null/undefined; a present-but-non-numeric value yields NaN, and
// setTimeout(NaN) fires immediately — killing claude before it starts. Fail loud instead.
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
  throw new Error(`SPIKE_TIMEOUT_MS must be a positive number (got "${rawTimeoutMs}").`);
}
const SIGKILL_GRACE_MS = 10_000;
const MODEL = process.env['SPIKE_MODEL'] ?? 'haiku';
const ALLOW_ROOT = process.env['SPIKE_ALLOW_ROOT'] === '1';

/** Outcome status for the whole spike. Exit code is non-zero unless OK. */
type Status =
  | 'OK'
  | 'PREFLIGHT_FAIL'
  | 'RUN_FAIL'
  | 'PARSE_FAIL'
  | 'GROUND_TRUTH_FAIL'
  | 'VERIFY_FAIL';

/**
 * A spike failure carrying the terminal {@link Status}; routed through finally.
 * NOTE: `status` is assigned explicitly, NOT via a TS parameter property —
 * `node --experimental-strip-types` rejects parameter properties (strip-only
 * mode cannot transform them), even though `tsc` accepts them. A real gotcha:
 * typecheck-green is not the same as strip-types-runnable.
 */
class SpikeError extends Error {
  readonly status: Exclude<Status, 'OK'>;
  constructor(status: Exclude<Status, 'OK'>, message: string) {
    super(message);
    this.status = status;
    this.name = 'SpikeError';
  }
}

function fail(status: Exclude<Status, 'OK'>, msg: string): never {
  throw new SpikeError(status, msg);
}

/**
 * The `--output-format json` result envelope, validated defensively. `subtype`
 * is an open string (no published schema). `.passthrough()` keeps unknown
 * fields so the findings doc can record the real shape; only the fields we read
 * are declared, all optional where the error variant may omit them.
 */
const ResultEnvelope = z
  .object({
    type: z.literal('result'),
    subtype: z.string(),
    is_error: z.boolean(),
    result: z.string().optional(),
    error: z.string().optional(),
    session_id: z.string().optional(),
    num_turns: z.number().optional(),
    duration_ms: z.number().optional(),
    total_cost_usd: z.number().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type ResultEnvelope = z.infer<typeof ResultEnvelope>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Run a command synchronously, capturing stdout/stderr/exit. For git + node. */
function run(
  cmd: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs });
  // spawnSync.status is null when the process was killed (signal or timeout).
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** First capture group of `re` in `text` as a number, or `fallback`. */
function matchNumber(text: string, re: RegExp, fallback: number): number {
  const m = text.match(re);
  const g = m?.[1]; // string | undefined under noUncheckedIndexedAccess
  return g === undefined ? fallback : Number(g);
}

/** Redact a session id for safe inclusion in findings/logs. */
function redact(id: string | undefined): string {
  if (!id) return '(none)';
  return id.length <= 8 ? '***' : `${id.slice(0, 4)}…${id.slice(-2)}`;
}

// Git config fully isolated from the host so global hooks / GPG signing /
// includeIf cannot corrupt the scratch commit.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const GIT_IDENT = ['-c', 'user.name=spike', '-c', 'user.email=spike@local'] as const;

function git(args: readonly string[], cwd: string) {
  return run('git', args, cwd, GIT_ENV);
}

/** Run a git command; fail with the given status + its stderr on non-zero exit. */
function gitOrFail(args: readonly string[], cwd: string, status: Exclude<Status, 'OK'>): string {
  const r = git(args, cwd);
  if (r.status !== 0) fail(status, `git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

// ---------------------------------------------------------------------------
// Module-scope state so teardown (finally) and printFindings always see it.
// ---------------------------------------------------------------------------
let tmpDir = '';
let worktreePath = '';
const findings: Record<string, unknown> = {};

/** Abort fast on anything that would make the findings misleading. */
function preflight(): string {
  const ver = run('claude', ['--version'], process.cwd());
  if (ver.status !== 0) {
    fail(
      'PREFLIGHT_FAIL',
      'the `claude` CLI is not on PATH or not runnable. Install it and `claude` ' +
        'login (subscription) before running this spike.',
    );
  }
  const claudeVersion = ver.stdout.trim() || ver.stderr.trim();

  // bypassPermissions is blocked as root by the CLI; abort early with guidance.
  if (process.getuid?.() === 0 && !ALLOW_ROOT) {
    fail(
      'PREFLIGHT_FAIL',
      '--permission-mode bypassPermissions is blocked as root. Run as a non-root ' +
        'user (set SPIKE_ALLOW_ROOT=1 to deliberately observe the root-failure).',
    );
  }

  // ANTHROPIC_API_KEY silently overrides subscription auth — the spike must
  // exercise the subscription path the production host uses.
  if (process.env['ANTHROPIC_API_KEY']) {
    fail(
      'PREFLIGHT_FAIL',
      'ANTHROPIC_API_KEY is set and would override subscription auth. Unset it so ' +
        'the spike validates the subscription path.',
    );
  }
  return claudeVersion;
}

/** The spike body. Sets `findings`; throws SpikeError on failure; returns 'OK'. */
async function main(): Promise<Status> {
  findings['claudeVersion'] = preflight();
  findings['node'] = process.version;

  // --- scratch repo (single initial commit; worktree requires >=1 commit) ---
  tmpDir = await mkdtemp(join(tmpdir(), 'executor-spike-'));
  const repo = tmpDir;
  gitOrFail(['init', '-q'], repo, 'PREFLIGHT_FAIL');
  await writeFile(join(repo, 'README.md'), '# scratch\n', 'utf8');
  gitOrFail(['add', '-A'], repo, 'PREFLIGHT_FAIL');
  gitOrFail([...GIT_IDENT, 'commit', '-q', '-m', 'init'], repo, 'PREFLIGHT_FAIL');
  const initSha = gitOrFail(['rev-parse', 'HEAD'], repo, 'PREFLIGHT_FAIL').trim();
  if (initSha === '') fail('PREFLIGHT_FAIL', 'could not resolve the scratch repo initial SHA.');

  // --- worktree ---
  worktreePath = join(tmpDir, 'wt');
  gitOrFail(['worktree', 'add', worktreePath, '-b', 'spike-run'], repo, 'RUN_FAIL');
  findings['worktreeCreate'] = `git worktree add ${worktreePath} -b spike-run`;

  // --- 3. Headless claude -p run inside the worktree ---
  const prompt =
    'In the current directory create exactly two files. `add.mjs`: export a pure ' +
    'function `add(a, b)` returning their numeric sum. `add.test.mjs`: a test using ' +
    "Node's built-in `node:test` and `node:assert/strict` that imports `add` from " +
    "`./add.mjs` and asserts `add(2, 3) === 5`. Do not install any dependencies and " +
    'do not run git. Then run `node --test add.test.mjs` to confirm it passes.';

  const argv = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--permission-mode',
    'bypassPermissions',
    '--model',
    MODEL,
    '--max-turns',
    '10',
  ];
  findings['argv'] = ['claude', ...argv.map((a) => (a === prompt ? '<prompt>' : a))];

  console.error(`[executor-spike] running claude in ${worktreePath} …`);
  const t0 = Date.now();
  const child = spawn('claude', argv, {
    cwd: worktreePath,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  if (child.stdout) child.stdout.on('data', (d: Buffer) => outChunks.push(d));
  if (child.stderr) child.stderr.on('data', (d: Buffer) => errChunks.push(d));

  let timedOut = false;
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    // Store the escalation handle so a clean post-SIGTERM exit doesn't leave
    // the inner timer holding the event loop open for the full grace period.
    sigkillTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
  }, TIMEOUT_MS);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      // 'close' does NOT fire after a spawn 'error' (e.g. ENOENT if `claude` vanished
      // after preflight) — without this handler the promise would hang for the full
      // timeout. Clear the kill timers so they don't keep the event loop alive.
      child.on('error', (err) => {
        clearTimeout(killTimer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        reject(new SpikeError('RUN_FAIL', `claude failed to spawn: ${err.message}`));
      });
      child.on('close', (code, signal) => resolve({ code, signal }));
    },
  );
  clearTimeout(killTimer);
  if (sigkillTimer) clearTimeout(sigkillTimer);

  const stdout = Buffer.concat(outChunks).toString('utf8');
  const stderr = Buffer.concat(errChunks).toString('utf8');
  findings['exitCode'] = exit.code;
  findings['killedBySignal'] = exit.signal;
  findings['wallClockMs'] = Date.now() - t0;
  // Only a real signal kill counts as a timeout: a process that exits cleanly (exit.signal
  // === null) just as the killTimer fires is NOT a timeout failure.
  if (timedOut && exit.signal !== null) {
    fail('RUN_FAIL', `claude exceeded ${TIMEOUT_MS}ms wall-clock and was killed (${exit.signal}).`);
  }

  // --- 4. Parse the envelope defensively. Never crash at parse. ---
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    findings['rawStdout'] = stdout.slice(0, 4000);
    findings['rawStderr'] = stderr.slice(0, 2000);
    fail('PARSE_FAIL', `stdout was not valid JSON (exit ${exit.code}). Raw captured in findings.`);
  }
  const validated = ResultEnvelope.safeParse(parsed);
  if (!validated.success) {
    // `parsed` is valid JSON but may be a non-object (array/number/string); Object.keys
    // on a scalar returns [] silently, masking the real shape. Record the type instead.
    findings['rawEnvelopeKeys'] =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? Object.keys(parsed)
        : [`(not an object: ${Array.isArray(parsed) ? 'array' : typeof parsed})`];
    findings['schemaIssues'] = validated.error.issues;
    fail('PARSE_FAIL', 'JSON did not match the result envelope schema (raw keys in findings).');
  }
  const envelope = validated.data;
  findings['subtype'] = envelope.subtype;
  findings['isError'] = envelope.is_error;
  findings['error'] = envelope.error ?? null;
  findings['numTurns'] = envelope.num_turns ?? null;
  findings['sessionId'] = redact(envelope.session_id);
  findings['durationMsReported'] = envelope.duration_ms ?? null;
  findings['totalCostUsd'] = envelope.total_cost_usd ?? null;
  findings['usage'] = envelope.usage ?? null;
  findings['envelopeKeys'] = Object.keys(parsed as object);
  findings['rawEnvelope'] = { ...(parsed as Record<string, unknown>), session_id: redact(envelope.session_id) };

  // Success = exit 0 AND is_error false AND subtype 'success'. Exit code alone
  // is unreliable: a budget/turn stop can exit 0 with is_error true.
  if (!(exit.code === 0 && envelope.is_error === false && envelope.subtype === 'success')) {
    fail(
      'RUN_FAIL',
      `task did not succeed (exit=${exit.code} is_error=${envelope.is_error} ` +
        `subtype=${envelope.subtype} error=${envelope.error ?? '-'}).`,
    );
  }

  // --- 5. Ground truth (invariant #2). MUST catch NEW UNTRACKED files: plain
  //        `git diff <sha>` ignores them, so use status --porcelain OR a moved
  //        HEAD (if the agent committed its own work). ---
  // Checked: if these queries themselves fail, report that — never let an empty
  // result masquerade as "the agent did nothing" (that would corrupt invariant #2).
  const porcelain = gitOrFail(['status', '--porcelain'], worktreePath, 'GROUND_TRUTH_FAIL').trim();
  const headSha = gitOrFail(['rev-parse', 'HEAD'], worktreePath, 'GROUND_TRUTH_FAIL').trim();
  // initSha is the scratch-repo HEAD; `git worktree add -b spike-run` starts the
  // worktree's branch at that same commit, so headSha === initSha until the agent
  // commits — a valid cross-(repo/worktree) comparison.
  const changed = porcelain !== '' || headSha !== initSha;
  findings['groundTruthChanged'] = changed;
  findings['statusPorcelain'] = porcelain;
  findings['headMoved'] = headSha !== initSha;
  if (!changed) {
    fail(
      'GROUND_TRUTH_FAIL',
      `claude exited 0 but the worktree is unchanged vs ${initSha.slice(0, 8)} — ` +
        'the agent declared work it did not do. (Invariant #2 caught it.)',
    );
  }

  // --- 6. Verify (invariant #3): pinned file + TAP reporter; 0-test run = fail. ---
  // 30s timeout: a hung/looping agent-authored test must not block this
  // synchronous spawnSync (the async wall-clock killTimer can't fire while it
  // holds the event loop). status null on timeout → -1 → VERIFY_FAIL.
  const verify = run('node', ['--test', '--test-reporter', 'tap', 'add.test.mjs'], worktreePath, process.env, 30_000);
  const tests = matchNumber(verify.stdout, /# tests (\d+)/, 0);
  // `fails` fallback is 1 (not 0): a missing `# fail` line means we couldn't
  // confirm zero failures, so treat it as a failure rather than risk a false-pass.
  const fails = matchNumber(verify.stdout, /# fail (\d+)/, 1);
  findings['verifyStatus'] = verify.status;
  findings['verifyTests'] = tests;
  findings['verifyFails'] = fails;
  if (!(verify.status === 0 && tests >= 1 && fails === 0)) {
    findings['verifyStdout'] = verify.stdout.slice(0, 2000);
    findings['verifyStderr'] = verify.stderr.slice(0, 2000); // real error (e.g. import failure) lands here
    fail('VERIFY_FAIL', `node --test did not confirm a pass (status=${verify.status} tests=${tests} fails=${fails}).`);
  }

  // --- 6b. Independent oracle (invariant #2): spike-controlled check that the
  //         agent module actually works, independent of the agent-authored test.
  //         If Claude only created a passing-but-vacuous add.test.mjs this oracle
  //         catches it: it imports add.mjs directly and asserts the real contract.
  //         Written AFTER the agent-test check so it does not affect the
  //         ground-truth snapshot taken in step 5.
  const oracleSrc = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './add.mjs';",
    "test('oracle: add(2,3)===5', () => assert.equal(add(2, 3), 5));",
  ].join('\n');
  await writeFile(join(worktreePath, '__oracle.test.mjs'), oracleSrc, 'utf8');
  const oracle = run(
    'node',
    ['--test', '--test-reporter', 'tap', '__oracle.test.mjs'],
    worktreePath,
    process.env,
    30_000,
  );
  const oracleTests = matchNumber(oracle.stdout, /# tests (\d+)/, 0);
  const oracleFails = matchNumber(oracle.stdout, /# fail (\d+)/, 1);
  findings['oracleStatus'] = oracle.status;
  findings['oracleTests'] = oracleTests;
  findings['oracleFails'] = oracleFails;
  if (!(oracle.status === 0 && oracleTests >= 1 && oracleFails === 0)) {
    findings['oracleStdout'] = oracle.stdout.slice(0, 2000);
    findings['oracleStderr'] = oracle.stderr.slice(0, 2000);
    fail(
      'VERIFY_FAIL',
      `oracle did not confirm add(2,3)===5 (status=${oracle.status} tests=${oracleTests} fails=${oracleFails}). ` +
        'Agent-authored test passed but the module contract is not satisfied. (Invariant #2 caught it.)',
    );
  }

  return 'OK';
}

/** Print the FINDINGS SUMMARY — always, on success or failure. */
function printFindings(status: Status): void {
  findings['status'] = status;
  console.log('\n========== EXECUTOR-SPIKE FINDINGS SUMMARY ==========');
  console.log(JSON.stringify(findings, null, 2));
}

/** Teardown — always runs. Each step guarded so one failure doesn't skip the rest. */
async function teardown(): Promise<void> {
  if (worktreePath && tmpDir) {
    const rmWt = git(['worktree', 'remove', worktreePath, '--force'], tmpDir);
    if (rmWt.status !== 0) console.error('[executor-spike] worktree remove warning:', rmWt.stderr.trim());
    git(['worktree', 'prune'], tmpDir);
    const list = git(['worktree', 'list'], tmpDir).stdout.trim();
    console.error('[executor-spike] worktrees after teardown:\n' + list);
  }
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    console.error(`[executor-spike] removed temp dir ${tmpDir}`);
  }
}

// ---------------------------------------------------------------------------
// Entry — teardown guaranteed; non-zero exit via process.exitCode (not exit()).
// ---------------------------------------------------------------------------
let status: Status = 'OK';
try {
  status = await main();
} catch (e) {
  if (e instanceof SpikeError) {
    status = e.status;
    console.error(`\n[executor-spike] ${e.status}: ${e.message}`);
  } else {
    status = 'RUN_FAIL';
    console.error('\n[executor-spike] UNEXPECTED error:', e);
  }
} finally {
  printFindings(status);
  // Never let a teardown error mask the real run status (it would surface as an
  // unhandled rejection). Log it — a leak is possible but the result stands.
  try {
    await teardown();
  } catch (e) {
    console.error('[executor-spike] teardown error (leak possible):', e);
  }
}
console.log(`\n[executor-spike] done — status=${status}`);
process.exitCode = status === 'OK' ? 0 : 1;
