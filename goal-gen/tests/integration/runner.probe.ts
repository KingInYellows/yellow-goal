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
import { ClaudeCodeExecutor } from '../../backend/src/executors/claude-code-executor';
import { ShellVerifier } from '../../backend/src/executors/shell-verifier';
import { createWorktree } from '../../backend/src/executors/worktree';
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

/** Wraps a real Verifier, returning a forced exit code for the first `failFirst` calls. */
class InjectedFailVerifier implements Verifier {
  private calls = 0;
  constructor(private readonly failFirst: number, private readonly real: Verifier) {}
  async run(command: string, ctx: RunContext): Promise<VerifyResult> {
    this.calls++;
    if (this.failFirst === Infinity || this.calls <= this.failFirst) {
      return { exitCode: 1, stdout: '', stderr: `[probe] injected verify-fail (call ${this.calls})` };
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
    log({ ev: 'preflight.note', message: 'ANTHROPIC_API_KEY is set — the executor will use API-key auth, not subscription.' });
  }
}

const HELLO_GOAL = 'Create a file named hello.txt in the current directory whose entire contents are exactly the single word: hello';

/** A — happy path: the real loop completes on a satisfiable goal. */
async function scenarioA(): Promise<void> {
  console.log('\n--- Scenario A: happy path (loop completes) ---');
  const config = defaultRunConfig({ model: MODEL, maxBudgetUsd: 5 });
  const summary = await makeOrchestrator(config, new ShellVerifier()).run({ goalText: HELLO_GOAL });
  findings['A'] = { status: summary.status, costUsd: summary.costUsd, replans: summary.replans, reextractions: summary.reextractions };
  check(summary.status === 'succeeded', `A: status succeeded (got ${summary.status})`);
  // NOTE: summary.costUsd is EXECUTOR spend only — extraction/expand cost is real but not folded into
  // the summary in v1 (bounded by the re-extraction cap ≤2, so it cannot run away). This proves the
  // executor actually ran and spent, not the total API bill.
  check(summary.costUsd > 0, `A: executor spend observed (costUsd=${summary.costUsd})`);
  check(summary.costUsd <= config.maxBudgetUsd, 'A: executor spend stayed within budget');
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
  check(summary.status === 'failed' || summary.status === 'budget-exhausted', `C: terminated at a cap (got ${summary.status})`);
  check(summary.replans <= config.maxReplans, `C: replans within cap (${summary.replans} <= ${config.maxReplans})`);
  check(summary.reextractions <= config.maxReextractions, `C: re-extractions within cap (${summary.reextractions} <= ${config.maxReextractions})`);
  // The CAPS above (not the dollar figure) are what bound runaway; costUsd is executor spend only,
  // and +1 allows the single in-flight action that can land just over the pre-dispatch budget check.
  check(summary.costUsd <= config.maxBudgetUsd + 1, 'C: did not run away (executor spend within budget + 1 in-flight action)');
}

async function main(): Promise<void> {
  preflight();
  findings['model'] = MODEL;
  findings['scenarios'] = SCENARIOS;
  const runners: Record<string, () => Promise<void>> = { A: scenarioA, B: scenarioB, C: scenarioC };
  for (const name of SCENARIOS) {
    const fn = runners[name];
    if (!fn) {
      console.log(`(skipping unknown scenario "${name}")`);
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
