#!/usr/bin/env node
/**
 * Thin CLI entry for the M1 walking skeleton: `npx tsx backend/src/runner.ts "<goal>"`.
 *
 * v1 (this item) wiring: argv → StubExtractor → deterministic `plan()` → minimal serial walk over
 * StubExecutor → structured JSON-lines stdout log → exit code. This is the *skeleton* — the loop
 * shape runs end-to-end before real integration. The real confirm-DoD gate, the verify-command
 * ground-truth oracle, and the replan ladder land when the Orchestrator replaces the inline walk
 * (plan item 4, which "unstubs the runner"). `runner.ts` carries NO business logic beyond argv,
 * structured IO, and exit-code control flow.
 *
 * Control flow never calls `process.exit()` mid-run (it would skip `finally` and leak worktrees —
 * spike §8); it sets `process.exitCode` and lets the module return.
 */
import { pathToFileURL } from 'node:url';
import { StubExecutor } from './executors/stub-executor';
import { StubExtractor } from './extractors/stub-extractor';
import { defaultRunConfig } from './orchestrator/guardrails';
import { plan } from './planner/plan';
import { satisfies } from './planner/simulate';
import type { Action, GoalSpec, WorldState } from './planner/types';
import type { ActionOutcome, Executor, LlmExtractor, RunContext, RunStatus, RunSummary } from './types';

/** Structured JSON-lines log line to stdout (one self-describing event per line). */
function log(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
}

/**
 * Throwaway fixture the skeleton plans + walks. The real extractor (item 3) replaces this; until
 * then the StubExtractor ignores the goal text and returns this trivial 2-step monotone goal so the
 * wiring (extract → plan → execute → terminate) is exercised end-to-end.
 */
const SKELETON_FIXTURE: GoalSpec = {
  goalText: '(skeleton fixture) create a file, then confirm it exists',
  initialState: { fileCreated: false, fileConfirmed: false },
  goalState: { fileCreated: true, fileConfirmed: true },
  constraints: [],
  completionPolicy: 'verify-only',
  actions: [
    {
      id: 'create-file',
      name: 'Create the file',
      cost: 1,
      preconditions: { fileCreated: false },
      effects: { fileCreated: true },
      executor: 'claude-code',
      payload: { prompt: 'Create a file named skeleton.txt containing "ok".' },
      verify: { command: 'test -f skeleton.txt', successPredicate: { fileCreated: true } },
    },
    {
      id: 'confirm-file',
      name: 'Confirm the file exists',
      cost: 1,
      preconditions: { fileCreated: true },
      effects: { fileConfirmed: true },
      executor: 'claude-code',
      payload: { command: 'test -f skeleton.txt' },
      verify: { command: 'test -f skeleton.txt', successPredicate: { fileConfirmed: true } },
    },
  ],
};

/** Run the skeleton loop for one goal and return its structured summary. */
async function run(goalArgs: string[]): Promise<RunSummary> {
  const goalText = goalArgs.join(' ').trim();
  if (goalText === '') {
    log({ ev: 'error', message: 'usage: npx tsx backend/src/runner.ts "<goal>"' });
    return { status: 'failed', goalText: '', costUsd: 0, replans: 0, reextractions: 0, actions: [], reason: 'no goal text provided' };
  }

  log({ ev: 'run.start', goalText, note: 'M1 skeleton — stub extractor + stub executor (no real claude -p yet)' });

  const config = defaultRunConfig();
  const extractor: LlmExtractor = new StubExtractor({ goalSpec: SKELETON_FIXTURE });
  const executor: Executor = new StubExecutor({ default: { status: 'succeeded', costUsd: 0 } });

  const goalSpec = await extractor.extract({ goalText });
  log({
    ev: 'extract.done',
    actions: goalSpec.actions.length,
    goalState: goalSpec.goalState,
    completionPolicy: goalSpec.completionPolicy,
  });

  const p = plan(goalSpec);
  if (p === null) {
    log({ ev: 'plan.none' });
    return { status: 'failed', goalText, costUsd: 0, replans: 0, reextractions: 0, actions: [], reason: 'no plan: goal unsatisfiable over the candidate pool' };
  }
  log({ ev: 'plan.done', steps: p.steps.map((s) => s.actionId), totalCost: p.totalCost });

  // --- minimal serial walk (skeleton). The Orchestrator (item 4) replaces this block with the real
  //     confirm-DoD gate + verify-command oracle + replan ladder; here a stub agent-success stands
  //     in for the verify pass so the loop shape runs end-to-end. ---
  const byId = new Map<string, Action>(goalSpec.actions.map((a) => [a.id, a]));
  const state: WorldState = { ...goalSpec.initialState };
  const actions: ActionOutcome[] = [];
  const ac = new AbortController();
  let costUsd = 0;
  let status: RunStatus = 'failed';
  let reason = 'plan executed but goalState not satisfied';

  for (const step of p.steps) {
    const action = byId.get(step.actionId);
    if (!action) continue; // unreachable: plan() only emits ids from the pool
    const ctx: RunContext = {
      runId: `skeleton-${step.actionId}`,
      worktreePath: '(stub)',
      signal: ac.signal,
      budgetUsdRemaining: config.maxBudgetUsd - costUsd,
    };
    const agentRun = await executor.run(action, ctx);
    const spent = agentRun.costUsd ?? 0;
    costUsd += spent;
    const ok = agentRun.status === 'succeeded';
    actions.push({ actionId: action.id, status: ok ? 'succeeded' : 'failed', attempts: 1, costUsd: spent });
    log({ ev: 'step.run', actionId: action.id, agentStatus: agentRun.status, costUsd: spent, diffRef: agentRun.diffRef ?? null });

    if (!ok) {
      reason = `action "${action.id}" failed (skeleton has no replan ladder yet — see item 4)`;
      break;
    }
    // Skeleton state update: stand the agent-success in for a verify pass and apply the effects.
    Object.assign(state, action.effects);
    if (satisfies(state, goalSpec.goalState)) {
      status = 'succeeded';
      reason = 'goalState satisfied';
      break;
    }
  }

  return { status, goalText, costUsd, replans: 0, reextractions: 0, actions, reason };
}

// Auto-run only when invoked as the entry script (so tests can import without side effects).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await run(process.argv.slice(2));
  log({ ev: 'run.summary', ...summary });
  process.exitCode = summary.status === 'succeeded' ? 0 : 1;
}

export { run, SKELETON_FIXTURE };
