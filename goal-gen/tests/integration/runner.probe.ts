/**
 * M1 end-to-end integration probe (plan tasks 5.3 / 5.4) — REAL `claude -p`, SPENDS MONEY.
 *
 * Deliberately a `.probe.ts`, NOT a `.test.ts`: the vitest glob is `tests/**\/*.test.ts`, so neither
 * `npm test` nor `npm run eval` ever runs this and CI never spawns `claude`. Run it manually:
 *
 *   npx tsx tests/integration/runner.probe.ts
 *   PROBE_SCENARIOS=A npx tsx tests/integration/runner.probe.ts   # just the cheap happy path
 *
 * It drives the REAL stack (LlmExtractor → plan() → Orchestrator → ClaudeCodeExecutor in per-run
 * worktrees → ShellVerifier) on a trivial goal in throwaway scratch repos, and asserts the three
 * de-risking properties:
 *   A. the loop completes (succeeds on a satisfiable goal),
 *   B. it REPLANS on an injected verify-fail and still recovers,
 *   C. it self-terminates at the guardrail caps (no runaway).
 * A FINDINGS SUMMARY (status + cost per scenario) is always printed. Non-zero exit on any failure.
 *
 * Preconditions (mirrors the spike): host `claude` logged in via subscription, run as NON-root
 * (`--permission-mode bypassPermissions` is blocked as root). Cost is OBSERVED, never asserted.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeCodeExecutor } from '../../backend/src/executors/claude-code-executor';
import { ShellVerifier } from '../../backend/src/executors/shell-verifier';
import { createWorktree } from '../../backend/src/executors/worktree';
import type { WorktreeHandle } from '../../backend/src/executors/worktree';
import { ClaudeLlmClient, LlmExtractorImpl } from '../../backend/src/extractors/llm-extractor';
import { defaultRunConfig } from '../../backend/src/orchestrator/guardrails';
import { Orchestrator } from '../../backend/src/orchestrator/orchestrator';
import type { RunConfig, RunContext, RunSummary, Verifier, VerifyResult } from '../../backend/src/types';

const MODEL = process.env['PROBE_MODEL'] ?? 'haiku';
const ALLOW_ROOT = process.env['PROBE_ALLOW_ROOT'] === '1';
const SCENARIOS = (process.env['PROBE_SCENARIOS'] ?? 'A,B,C').split(',').map((s) => s.trim().toUpperCase());

const findings: Record<string, unknown> = {};
let failures = 0;

function log(event: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
}
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!cond) failures++;
}

/**
 * Worktree provider that delegates to `createWorktree` but intercepts cleanup on the last-created
 * handle. When the orchestrator calls `handle.cleanup()` (in its per-action finally block), the
 * real deletion is NOT executed — it is deferred so the probe can still read artifacts from disk
 * after `orchestrator.run()` returns. Call `capturing.flushCleanup()` in a `finally` after
 * reading the artifact to run the real deletion and avoid a worktree leak.
 */
class CapturingWorktreeProvider {
  lastHandle: WorktreeHandle | undefined;
  private readonly _pendingCleanups: Array<() => Promise<void>> = [];

  readonly provide = async (opts: Parameters<typeof createWorktree>[0]): Promise<WorktreeHandle> => {
    const real = await createWorktree(opts);
    // Wrap with a proxy that mirrors all handle fields but defers cleanup instead of deleting immediately.
    const proxy: WorktreeHandle = {
      root: real.root,
      worktreePath: real.worktreePath,
      branch: real.branch,
      initialSha: real.initialSha,
      cleanup: async () => {
        // A multi-action run (retry / replan / multi-step plan) creates SEVERAL worktrees, each with
        // its own cleanup. Queue EVERY one — overwriting a single field would leak all but the last.
        this._pendingCleanups.push(() => real.cleanup());
      },
    };
    this.lastHandle = proxy;
    return proxy;
  };

  /** Drain ALL deferred real worktree deletions (best-effort; keeps draining if one fails). */
  async flushCleanup(): Promise<void> {
    const fns = this._pendingCleanups.splice(0);
    for (const fn of fns) {
      try {
        await fn();
      } catch (e) {
        log({ ev: 'probe.cleanup.error', message: (e as Error).message });
      }
    }
  }
}

/** Wraps a real Verifier, returning a forced exit code for the first `failFirst` calls. */
class InjectedFailVerifier implements Verifier {
  /** Total number of times `run()` has been called — readable by the probe for assertions. */
  invocations = 0;
  constructor(private readonly failFirst: number, private readonly real: Verifier) {}
  async run(command: string, ctx: RunContext): Promise<VerifyResult> {
    this.invocations++;
    if (this.failFirst === Infinity || this.invocations <= this.failFirst) {
      return { exitCode: 1, stdout: '', stderr: `[probe] injected verify-fail (call ${this.invocations})` };
    }
    return this.real.run(command, ctx);
  }
}

function makeOrchestrator(config: RunConfig, verifier: Verifier): Orchestrator {
  return new Orchestrator({
    extractor: new LlmExtractorImpl(new ClaudeLlmClient({ model: MODEL }), { onEvent: log }),
    executor: new ClaudeCodeExecutor({ model: MODEL, timeoutMs: config.actionTimeoutMs, noiseFilterPaths: config.noiseFilterPaths }),
    verifier,
    config,
    confirm: async () => true, // non-interactive: the probe IS the operator
    worktreeProvider: createWorktree,
    onEvent: log,
  });
}

function preflight(): void {
  if (process.getuid?.() === 0 && !ALLOW_ROOT) {
    throw new Error('--permission-mode bypassPermissions is blocked as root. Run as a non-root user (PROBE_ALLOW_ROOT=1 to override).');
  }
  if (process.env['ANTHROPIC_API_KEY']) {
    // v1 must exercise the `claude -p` SUBSCRIPTION auth path. If an API key is set the executor
    // silently uses it instead, masking whether subscription auth works at all. Fail fast.
    throw new Error(
      'ANTHROPIC_API_KEY is set — this probe MUST run under subscription auth (claude -p), not API-key auth. ' +
      'Unset ANTHROPIC_API_KEY before running the probe.',
    );
  }
}

const HELLO_GOAL = 'Create a file named hello.txt in the current directory whose entire contents are exactly the single word: hello';

/** A — happy path: the real loop completes on a satisfiable goal. */
async function scenarioA(): Promise<void> {
  console.log('\n--- Scenario A: happy path (loop completes) ---');
  const config = defaultRunConfig({ model: MODEL, maxBudgetUsd: 5 });
  // Use a capturing provider so we can independently verify the artifact on disk after the run.
  // The worktree is cleaned up after each action; the provider records the LAST worktree path so
  // we can inspect it before cleanup (the run is done at this point — cleanup is deferred below).
  const capturing = new CapturingWorktreeProvider();
  const orchestrator = new Orchestrator({
    extractor: new LlmExtractorImpl(new ClaudeLlmClient({ model: MODEL }), { onEvent: log }),
    executor: new ClaudeCodeExecutor({ model: MODEL, timeoutMs: config.actionTimeoutMs, noiseFilterPaths: config.noiseFilterPaths }),
    verifier: new ShellVerifier(),
    config,
    confirm: async () => true,
    worktreeProvider: capturing.provide,
    onEvent: log,
  });
  // Scenario-level try/finally: CapturingWorktreeProvider defers each action's real worktree
  // deletion so the LAST worktree is still on disk for the artifact check below. Flushing that
  // deferred deletion must happen regardless of how this scenario exits — including if
  // orchestrator.run() itself throws — or a rejected run leaks the scratch worktree(s) it queued.
  try {
    const summary = await orchestrator.run({ goalText: HELLO_GOAL });
    findings['A'] = { status: summary.status, costUsd: summary.costUsd, replans: summary.replans, reextractions: summary.reextractions };
    check(summary.status === 'succeeded', `A: status succeeded (got ${summary.status})`);
    // NOTE: summary.costUsd is the run's TOTAL accumulated spend — extraction (+ repair rounds) and any
    // re-extraction/expand cost are folded in alongside executor spend (see accumulatedCostUsd in
    // orchestrator.ts). This proves the full pipeline (extractor + executor) actually ran and spent,
    // not executor-only cost.
    // Cost is OBSERVED-ONLY telemetry — a real `claude -p` subscription run can legitimately report
    // total_cost_usd as 0 (or omit it), so it must NOT gate pass/fail. Record it; don't assert > 0.
    log({ ev: 'probe.A.cost', costUsd: summary.costUsd });
    check(summary.costUsd <= config.maxBudgetUsd, 'A: total spend stayed within budget');
    // Independent artifact check: don't trust the run's reported success alone — verify hello.txt
    // actually exists on disk with the exact expected content.
    if (capturing.lastHandle) {
      const artifactPath = join(capturing.lastHandle.worktreePath, 'hello.txt');
      let artifactContent: string | undefined;
      try {
        artifactContent = await readFile(artifactPath, 'utf8');
      } catch {
        artifactContent = undefined;
      }
      check(artifactContent !== undefined, `A: hello.txt exists on disk at ${artifactPath}`);
      // Allow exactly one optional trailing newline (the realistic `echo hello > hello.txt` / editor-save
      // form) but reject any other leading/trailing whitespace or padding — a blanket `.trim()` would let
      // through content that violates the "file's entire contents must be exactly hello" contract.
      check(
        artifactContent === 'hello' || artifactContent === 'hello\n',
        `A: hello.txt content is exactly "hello" (got ${JSON.stringify(artifactContent)})`,
      );
    } else {
      check(false, 'A: no worktree was created — cannot verify artifact');
    }
  } finally {
    await capturing.flushCleanup().catch(() => {});
  }
}

/** B — replan recovery: a forced verify-fail exhausts retries, triggers a replan, then recovers. */
async function scenarioB(): Promise<void> {
  console.log('\n--- Scenario B: replan on an injected verify-fail ---');
  // 1 retry then the post-replan re-run sees the REAL verify ⇒ exactly one forced fail forces a replan.
  const config = defaultRunConfig({ model: MODEL, maxBudgetUsd: 5, maxRetriesPerAction: 1 });
  const verifier = new InjectedFailVerifier(1, new ShellVerifier());
  const summary = await makeOrchestrator(config, verifier).run({ goalText: HELLO_GOAL });
  findings['B'] = { status: summary.status, costUsd: summary.costUsd, replans: summary.replans, reextractions: summary.reextractions };
  check(summary.replans >= 1, `B: a real replan happened (replans=${summary.replans})`);
  check(summary.status === 'succeeded', `B: recovered to succeeded after the replan (got ${summary.status})`);
}

/** C — no runaway: an always-failing verify hits the caps and terminates cleanly (cheap, tight caps). */
async function scenarioC(): Promise<void> {
  console.log('\n--- Scenario C: self-terminates at the caps (no runaway) ---');
  const config = defaultRunConfig({ model: MODEL, maxBudgetUsd: 3, maxRetriesPerAction: 1, maxReplans: 1, maxReextractions: 1 });
  const verifier = new InjectedFailVerifier(Infinity, new ShellVerifier()); // never passes
  const summary = await makeOrchestrator(config, verifier).run({ goalText: HELLO_GOAL });
  findings['C'] = { status: summary.status, costUsd: summary.costUsd, replans: summary.replans, reextractions: summary.reextractions };
  // Must be a cap-terminal status — 'succeeded' means the guardrail was never exercised.
  const capStatuses: RunSummary['status'][] = ['failed', 'budget-exhausted'];
  check(capStatuses.includes(summary.status), `C: terminated with a cap-related status, not 'succeeded' (got ${summary.status})`);
  check(summary.replans <= config.maxReplans, `C: replans within cap (${summary.replans} <= ${config.maxReplans})`);
  check(summary.reextractions <= config.maxReextractions, `C: re-extractions within cap (${summary.reextractions} <= ${config.maxReextractions})`);
  // Prove the failure path actually ran: the verifier must have been invoked at least once.
  // A graph that is unplannable from the start could hit maxReextractions without any action or
  // verifier executing — a cap-count check alone would still pass in that degenerate case.
  check(verifier.invocations >= 1, `C: verifier was invoked at least once (invocations=${verifier.invocations}), proving the execute→verify path ran`);
  // Prove a cap was actually reached — not merely that the run ended. At least one counter must
  // have hit its configured limit, otherwise the run stopped for an unrelated reason.
  const hitReplansCap = summary.replans >= config.maxReplans;
  const hitReextractionsCap = summary.reextractions >= config.maxReextractions;
  const hitBudgetCap = summary.status === 'budget-exhausted';
  check(
    hitReplansCap || hitReextractionsCap || hitBudgetCap,
    `C: a guardrail cap was actually reached (replans=${summary.replans}/${config.maxReplans}, reextractions=${summary.reextractions}/${config.maxReextractions}, status=${summary.status})`,
  );
  // Runaway is bounded by the CAPS proven above (replans / re-extractions / budget-exhausted), NOT by
  // the dollar figure. A pricier PROBE_MODEL — or a single in-flight action that reports well over the
  // remaining budget — can legitimately push costUsd past any fixed buffer while the run is still a
  // correct budget-exhausted cap hit. Record the observed spend (already in findings['C']); do not
  // assert an arbitrary dollar bound here (mirrors the observed-cost treatment in scenario A).
  log({ ev: 'probe.C.cost', costUsd: summary.costUsd, maxBudgetUsd: config.maxBudgetUsd });
}

async function main(): Promise<void> {
  preflight();
  findings['model'] = MODEL;
  findings['scenarios'] = SCENARIOS;
  const runners: Record<string, () => Promise<void>> = { A: scenarioA, B: scenarioB, C: scenarioC };
  for (const name of SCENARIOS) {
    const fn = runners[name];
    if (!fn) {
      failures++;
      console.log(`FAIL: unrecognized PROBE_SCENARIO "${name}" — valid values are: ${Object.keys(runners).join(', ')}`);
      continue;
    }
    try {
      await fn();
    } catch (e) {
      failures++;
      findings[name] = { error: (e as Error).message };
      console.log(`FAIL: scenario ${name} threw: ${(e as Error).message}`);
    }
  }
}

try {
  await main();
} catch (e) {
  failures++;
  console.error(`\n[probe] preflight/setup error: ${(e as Error).message}`);
} finally {
  let totalCost = 0;
  for (const v of Object.values(findings)) {
    if (v && typeof v === 'object' && typeof (v as { costUsd?: unknown }).costUsd === 'number') {
      totalCost += (v as { costUsd: number }).costUsd;
    }
  }
  findings['totalCostUsd'] = totalCost;
  findings['failures'] = failures;
  console.log('\n========== RUNNER PROBE FINDINGS SUMMARY ==========');
  console.log(JSON.stringify(findings, null, 2));
  console.log(failures === 0 ? '\nALL PROBE CHECKS PASSED' : `\n${failures} PROBE CHECK(S) FAILED`);
}
process.exitCode = failures === 0 ? 0 : 1;
