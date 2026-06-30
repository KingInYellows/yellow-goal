/**
 * Orchestrator / scheduler (`.claude/specs/orchestrator.md`) — deterministic control flow over the
 * deterministic planner. Drives extract → plan() → confirm-DoD → execute → verify → replan, serial
 * (v1 maxConcurrency = 1), entirely behind the spec interfaces so the later API layer wraps it.
 *
 * The LLM is used in exactly two places, both deterministic-to-trigger: the extractor *authoring*
 * the graph (extract / bounded expand) and the executor *running* a step. Everything that DECIDES —
 * the pass/fail gate, the replan/re-extraction triggers, the caps — is plain code here.
 *
 * Load-bearing rules this module owns:
 *  - WorldState updates from GROUND TRUTH only: applied on a verify PASS, from
 *    `verify.successPredicate ?? effects` — never from a declared effect alone (CLAUDE.md #2, plan #2).
 *  - `plan()` THROWS on a malformed pool (cost ≤ 0 / empty verify / duplicate id); every call is
 *    wrapped, and a throw consumes a re-extraction with the validation error as evidence (plan #3).
 *  - Mandatory guardrails with a terminal state each: budget, replans, re-extractions, per-action
 *    retries, per-action timeout (in the executor). `failures` is retained for loop-detection (M2).
 */
import { plan as runPlanner } from '../planner/plan';
import { satisfies } from '../planner/simulate';
import { createWorktree } from '../executors/worktree';
import type { WorktreeHandle, CreateWorktreeOptions } from '../executors/worktree';
import type { Action, CompletionPolicy, GoalSpec, Plan, PlanStep, WorldState } from '../planner/types';
import type {
  ActionOutcome,
  Executor,
  ExtractRequest,
  FailureEvidence,
  FailureRecord,
  LlmExtractor,
  RunConfig,
  RunContext,
  RunStatus,
  RunSummary,
  Verifier,
} from '../types';
import { defaultRunConfig } from './guardrails';

/** The definition of done shown to the operator at the confirm gate (plan task 4.2). */
export interface DodInfo {
  goalText: string;
  goalState: Partial<WorldState>;
  completionPolicy: CompletionPolicy;
  actions: Array<{ name: string; verify: Action['verify'] }>;
  plannedSequence: string[];
}

/** Operator confirmation of the DoD. Production reads stdin; tests inject a deterministic answer. */
export type DodConfirmer = (dod: DodInfo) => Promise<boolean>;

/** Provides a fresh per-action worktree. Production = `createWorktree`; tests inject a stub. */
export type WorktreeProvider = (opts: CreateWorktreeOptions) => Promise<WorktreeHandle>;

export interface OrchestratorDeps {
  extractor: LlmExtractor;
  executor: Executor;
  verifier: Verifier;
  config?: RunConfig;
  confirm?: DodConfirmer;
  worktreeProvider?: WorktreeProvider;
  onEvent?: (event: Record<string, unknown>) => void;
  /** Cancellation: propagated to the executor; default never aborts. */
  signal?: AbortSignal;
}

/** Mutable per-run state — local to one `run()` so the orchestrator instance is reusable. */
interface RunState {
  goalText: string;
  goalSpec: GoalSpec;
  currentState: WorldState;
  pool: Action[];
  completed: Set<string>;
  replans: number;
  reextractions: number;
  accumulatedCostUsd: number;
  failures: Map<string, FailureRecord[]>;
  outcomes: Map<string, ActionOutcome>;
  runId: string;
}

type StepResult =
  | { kind: 'passed'; attempts: number; costUsd: number }
  | { kind: 'failed'; attempts: number; costUsd: number; evidence: FailureEvidence }
  | { kind: 'budget'; attempts: number; costUsd: number };

type SafePlanResult = { threw: false; plan: Plan | null } | { threw: true; error: Error };

/** Outcome of trying to obtain a usable plan (initial, forced-replan, or post-failure ladder). */
type PlanOutcome = { kind: 'plan'; plan: Plan } | { kind: 'terminal'; summary: RunSummary };

export class Orchestrator {
  private readonly extractor: LlmExtractor;
  private readonly executor: Executor;
  private readonly verifier: Verifier;
  private readonly config: RunConfig;
  private readonly confirm: DodConfirmer;
  private readonly worktreeProvider: WorktreeProvider;
  private readonly emit: (event: Record<string, unknown>) => void;
  private readonly signal: AbortSignal;
  private runCounter = 0;

  constructor(deps: OrchestratorDeps) {
    this.extractor = deps.extractor;
    this.executor = deps.executor;
    this.verifier = deps.verifier;
    this.config = deps.config ?? defaultRunConfig();
    this.confirm = deps.confirm ?? stdinConfirm;
    this.worktreeProvider = deps.worktreeProvider ?? createWorktree;
    this.emit = deps.onEvent ?? (() => {});
    this.signal = deps.signal ?? new AbortController().signal;
  }

  /** Run the full loop for one goal and return its terminal summary. Never throws. */
  async run(req: ExtractRequest): Promise<RunSummary> {
    // --- EXTRACT ---
    let goalSpec: GoalSpec;
    try {
      goalSpec = await this.extractor.extract(req);
    } catch (e) {
      const message = (e as Error).message;
      this.emit({ ev: 'extract.failed', message });
      return bareSummary(req.goalText, 'failed', `extraction failed: ${message}`);
    }
    const state: RunState = {
      goalText: req.goalText,
      goalSpec,
      currentState: { ...goalSpec.initialState },
      pool: [...goalSpec.actions],
      completed: new Set(),
      replans: 0,
      reextractions: 0,
      accumulatedCostUsd: 0,
      failures: new Map(),
      outcomes: new Map(),
      runId: `run-${++this.runCounter}`,
    };
    this.emit({
      ev: 'extract.done',
      actions: state.pool.length,
      goalState: goalSpec.goalState,
      completionPolicy: goalSpec.completionPolicy,
    });

    // --- INITIAL PLAN (the re-extraction ladder also covers a throwing/unsatisfiable extract, #3) ---
    let plan: Plan;
    {
      const obtained = await this.obtainPlan(state, { actionId: '(initial)' });
      if (obtained.kind === 'terminal') return obtained.summary;
      plan = obtained.plan;
    }

    // --- CONFIRM DoD ---
    const confirmed = await this.confirm(this.buildDod(state, plan));
    if (!confirmed) {
      this.emit({ ev: 'dod.cancelled' });
      return this.summary(state, 'cancelled', 'cancelled at DoD confirmation');
    }
    this.emit({ ev: 'dod.confirmed', sequence: plan.steps.map((s) => s.actionId) });

    // --- MAIN LOOP (serial) ---
    for (;;) {
      // Item 3: check AbortSignal at the top of every iteration so SIGINT/abort stops promptly.
      if (this.signal.aborted) return this.summary(state, 'cancelled', 'aborted');

      if (satisfies(state.currentState, state.goalSpec.goalState)) {
        // Item 4: sign-off gate — when the policy requires operator acceptance, prompt before
        // declaring success. On rejection, fall through to replan/re-extraction.
        const policy = state.goalSpec.completionPolicy;
        if (policy === 'verify+signoff' || policy === 'operator-defined') {
          const accepted = await this.confirm(this.buildDod(state, plan));
          if (accepted) return this.summary(state, 'succeeded', 'goalState satisfied and operator signed off');
          this.emit({ ev: 'signoff.rejected' });
          // Rejection after goalState satisfied: re-enter the replan ladder so the operator can
          // guide the run toward a different outcome rather than returning a non-succeeded terminal.
          const ro = await this.replanLadder(state, '(signoff-rejected)', { actionId: '(signoff-rejected)' });
          if (ro.kind === 'terminal') return ro.summary;
          plan = ro.plan;
          continue;
        }
        return this.summary(state, 'succeeded', 'goalState satisfied');
      }

      const step = this.nextStep(plan, state);
      if (step === undefined) {
        // Current plan exhausted but goal unmet — recompute from the real current state.
        const r = this.safePlan(state);
        if (r.threw) {
          // A malformed pool reached here (e.g. an expand-added bad action) must route to
          // re-extraction like every other plan() throw site (design decision #3), not crash.
          this.emit({ ev: 'plan.threw', message: r.error.message });
          const o = await this.reextract(state, withValidation({ actionId: '(plan-exhausted)' }, r.error));
          if (o.kind === 'terminal') return o.summary;
          plan = o.plan;
          continue;
        }
        if (r.plan === null || this.nextStep(r.plan, state) === undefined) {
          return this.summary(state, 'failed', 'plan exhausted but goalState unmet and no further progress possible');
        }
        plan = r.plan;
        continue;
      }

      const action = state.pool.find((a) => a.id === step.actionId);
      if (!action) {
        // Unreachable: plan() only emits pool ids. Treat as a forced replan rather than crash.
        const o = await this.obtainPlan(state, { actionId: '(missing-action)' });
        if (o.kind === 'terminal') return o.summary;
        plan = o.plan;
        continue;
      }

      // Budget check BEFORE dispatch (plan task 4.3).
      if (state.accumulatedCostUsd >= this.config.maxBudgetUsd) {
        return this.summary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} reached`);
      }

      const result = await this.executeStep(state, action, plan.id);
      // Item 3: check signal again after an await that may have taken a long time.
      if (this.signal.aborted) return this.summary(state, 'cancelled', 'aborted after step');
      if (result.kind === 'budget') {
        return this.summary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} reached mid-action`);
      }
      // Item 6: enforce budget AFTER each action's cost is accumulated (not only pre-dispatch).
      if (state.accumulatedCostUsd >= this.config.maxBudgetUsd) {
        return this.summary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} reached post-action`);
      }
      if (result.kind === 'passed') {
        state.completed.add(action.id);
        const update = passUpdate(action);
        state.currentState = mergeState(state.currentState, update);
        this.recordOutcome(state, action.id, 'succeeded', result.attempts, result.costUsd);
        this.emit({ ev: 'step.pass', actionId: action.id, attempts: result.attempts, applied: update });
        continue; // termination re-checked at the top
      }
      // FAILED after retries → record + replan ladder.
      this.recordOutcome(state, action.id, 'failed', result.attempts, result.costUsd);
      this.recordFailure(state, action.id, result.evidence);
      this.emit({ ev: 'step.fail', actionId: action.id, attempts: result.attempts });
      const o = await this.replanLadder(state, action.id, result.evidence);
      if (o.kind === 'terminal') return o.summary;
      plan = o.plan;
    }
  }

  // ── Execution ────────────────────────────────────────────────────────────────────────────────

  /** Run one action up to `maxRetriesPerAction` times; the verify exit code is the only gate. */
  private async executeStep(state: RunState, action: Action, planId: string): Promise<StepResult> {
    let attempts = 0;
    let stepCost = 0;
    let lastEvidence: FailureEvidence = { actionId: action.id };

    while (attempts < this.config.maxRetriesPerAction) {
      if (state.accumulatedCostUsd >= this.config.maxBudgetUsd) {
        return { kind: 'budget', attempts, costUsd: stepCost };
      }
      attempts++;
      // Sanitize the LLM-authored id into a safe ref component; the `run-…-<attempts>` framing
      // already prevents a leading `-`/`.` or `.lock` suffix, so collapsing `..` runs is enough.
      // Item 8: truncate to 200 chars so a long action.id can't overflow git's ref limit.
      const safeId = action.id.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 200);
      // Item 1: worktreeProvider throw (disk full / git init fail) must become a structured failure,
      // not escape executeStep and crash run(). Wrap it and surface as a failed StepResult.
      let handle: WorktreeHandle;
      try {
        handle = await this.worktreeProvider({ branch: `${state.runId}-${safeId}-${attempts}` });
      } catch (e) {
        lastEvidence = { ...lastEvidence, verifyStderr: `worktree provision failed: ${(e as Error).message}` };
        continue; // count as a failed attempt; retries will exhaust and return 'failed'
      }
      // Item 2: verify runs INSIDE the try block (before cleanup in finally) so the worktree
      // is still present when the shell-verifier inspects executor file changes.
      try {
        const ctx: RunContext = {
          runId: state.runId,
          worktreePath: handle.worktreePath,
          signal: this.signal,
          budgetUsdRemaining: Math.max(0, this.config.maxBudgetUsd - state.accumulatedCostUsd),
        };
        const agentRun = await this.executor.run(action, ctx);
        agentRun.planId = planId; // the executor cannot know the plan id; stamp it (spec: AgentRun.planId)
        const spent = agentRun.costUsd ?? 0;
        stepCost += spent;
        state.accumulatedCostUsd += spent;
        this.emit({
          ev: 'agent.run',
          actionId: action.id,
          attempt: attempts,
          status: agentRun.status,
          costUsd: spent,
          diffRef: agentRun.diffRef ?? null,
        });

        const cmd = action.verify.command;
        if (cmd && cmd.trim().length > 0) {
          const v = await this.verifier.run(cmd, ctx);
          this.emit({ ev: 'verify', actionId: action.id, attempt: attempts, exitCode: v.exitCode });
          if (v.exitCode === 0) return { kind: 'passed', attempts, costUsd: stepCost };
          lastEvidence = buildEvidence(action, agentRun, v);
        } else {
          // No verify command ⇒ no ground-truth gate. We NEVER pass on the agent's self-reported
          // status (that would trust a declared effect — invariant #2). The extractor schema requires
          // a command, so this only fires for a hand-built action; record it and let retries exhaust.
          this.emit({ ev: 'verify.skipped', actionId: action.id, attempt: attempts, reason: 'no verify.command' });
          lastEvidence = {
            ...buildEvidence(action, agentRun, undefined),
            verifyStderr: 'action has no verify.command; ground truth cannot be established (invariant #2)',
          };
        }
      } finally {
        await handle.cleanup();
      }
    }
    return { kind: 'failed', attempts, costUsd: stepCost, evidence: lastEvidence };
  }

  // ── Planning / replan ladder ───────────────────────────────────────────────────────────────--

  /** Plan over the CURRENT pool from the CURRENT state, catching the planner's intake throw (#3). */
  private safePlan(state: RunState): SafePlanResult {
    const goalSpec: GoalSpec = { ...state.goalSpec, initialState: state.currentState, actions: state.pool };
    try {
      return { threw: false, plan: runPlanner(goalSpec, {}) };
    } catch (e) {
      return { threw: true, error: e as Error };
    }
  }

  /** Obtain a usable plan; a throw or no-plan routes to re-extraction (initial + forced-replan). */
  private async obtainPlan(state: RunState, evidence: FailureEvidence): Promise<PlanOutcome> {
    const r = this.safePlan(state);
    if (r.threw) {
      this.emit({ ev: 'plan.threw', message: r.error.message });
      return this.reextract(state, withValidation(evidence, r.error));
    }
    if (r.plan !== null) return { kind: 'plan', plan: r.plan };
    return this.reextract(state, evidence);
  }

  /**
   * Post-failure ladder (plan task 4.4): try a re-plan over the existing pool (counts a replan); if
   * the same subgoal has failed too often, the replan cap is hit, or there's no plan, escalate to
   * re-extraction. A `plan()` throw routes straight to re-extraction with the validation error.
   */
  private async replanLadder(state: RunState, failedActionId: string, evidence: FailureEvidence): Promise<PlanOutcome> {
    const sameFails = state.failures.get(failedActionId)?.length ?? 0;
    // Item 7: CLAUDE.md loop-detection = "same action fails the SAME way twice". Compare
    // the last two FailureRecords' normalized signatures before treating as a loop.
    const failHistory = state.failures.get(failedActionId) ?? [];
    const isLoop = failHistory.length >= 2 &&
      failHistory[failHistory.length - 1]!.verifyExitCode === failHistory[failHistory.length - 2]!.verifyExitCode &&
      failHistory[failHistory.length - 1]!.verifyStderr.slice(0, 200) === failHistory[failHistory.length - 2]!.verifyStderr.slice(0, 200);
    if (!isLoop && sameFails < this.config.maxSameSubgoalFailures && state.replans < this.config.maxReplans) {
      const r = this.safePlan(state);
      if (r.threw) {
        this.emit({ ev: 'plan.threw', message: r.error.message });
        return this.reextract(state, withValidation(evidence, r.error));
      }
      if (r.plan !== null) {
        state.replans++;
        this.emit({ ev: 'replanned', replans: state.replans });
        return { kind: 'plan', plan: r.plan };
      }
    }
    return this.reextract(state, evidence);
  }

  /** Bounded re-extraction: append-only `expand()`, then re-plan; a post-expand throw recurses (capped). */
  private async reextract(state: RunState, evidence: FailureEvidence): Promise<PlanOutcome> {
    if (state.reextractions >= this.config.maxReextractions) {
      return {
        kind: 'terminal',
        summary: this.summary(state, 'failed', `re-extraction cap (${this.config.maxReextractions}) reached; goal unreachable`),
      };
    }
    state.reextractions++;
    this.emit({ ev: 'reextract', reextractions: state.reextractions, forActionId: evidence.actionId });
    let newActions: Action[];
    try {
      newActions = await this.extractor.expand(state.goalText, state.currentState, evidence, state.pool);
    } catch (e) {
      return { kind: 'terminal', summary: this.summary(state, 'failed', `expand failed: ${(e as Error).message}`) };
    }
    state.pool = [...state.pool, ...newActions];
    this.emit({ ev: 'reextract.added', added: newActions.length, poolSize: state.pool.length });

    const r = this.safePlan(state);
    if (r.threw) {
      this.emit({ ev: 'plan.threw', message: r.error.message });
      // Item 9: pass the UPDATED validation error (not the original evidence) so each recursive
      // re-extraction sees the latest planner failure, not a stale earlier one.
      const updatedEvidence = withValidation(evidence, r.error);
      return this.reextract(state, updatedEvidence); // bounded by the cap above
    }
    if (r.plan === null) {
      return { kind: 'terminal', summary: this.summary(state, 'failed', 'no plan even after re-extraction') };
    }
    // Item 5: re-confirm DoD for newly-added actions before executing them.
    const reconfirmed = await this.confirm(this.buildDod(state, r.plan));
    if (!reconfirmed) {
      this.emit({ ev: 'dod.cancelled', reason: 're-extracted actions not accepted' });
      return { kind: 'terminal', summary: this.summary(state, 'cancelled', 'cancelled at re-extracted DoD confirmation') };
    }
    this.emit({ ev: 'dod.reconfirmed', reextractions: state.reextractions });
    return { kind: 'plan', plan: r.plan };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────

  private nextStep(plan: Plan, state: RunState): PlanStep | undefined {
    return plan.steps.find((s) => !state.completed.has(s.actionId));
  }

  private buildDod(state: RunState, plan: Plan): DodInfo {
    const byId = new Map(state.pool.map((a) => [a.id, a]));
    const policy: CompletionPolicy =
      state.goalSpec.completionPolicy === 'operator-defined' ? 'verify+signoff' : state.goalSpec.completionPolicy;
    return {
      goalText: state.goalSpec.goalText,
      goalState: state.goalSpec.goalState,
      completionPolicy: policy,
      actions: plan.steps.map((s) => {
        const a = byId.get(s.actionId);
        return { name: a?.name ?? s.actionId, verify: a?.verify ?? {} };
      }),
      plannedSequence: plan.steps.map((s) => s.actionId),
    };
  }

  private recordOutcome(state: RunState, actionId: string, status: 'succeeded' | 'failed', attempts: number, costUsd: number): void {
    const prev = state.outcomes.get(actionId);
    if (prev) {
      prev.attempts += attempts;
      prev.costUsd += costUsd;
      prev.status = status;
    } else {
      state.outcomes.set(actionId, { actionId, status, attempts, costUsd });
    }
  }

  private recordFailure(state: RunState, actionId: string, evidence: FailureEvidence): void {
    const list = state.failures.get(actionId) ?? [];
    list.push({
      actionId,
      verifyExitCode: evidence.verifyExitCode ?? -1,
      verifyStderr: (evidence.verifyStderr ?? evidence.agentStderr ?? '').slice(0, 500),
      at: new Date().toISOString(),
    });
    state.failures.set(actionId, list);
  }

  private summary(state: RunState, status: RunStatus, reason: string): RunSummary {
    const summary: RunSummary = {
      status,
      goalText: state.goalText,
      costUsd: state.accumulatedCostUsd,
      replans: state.replans,
      reextractions: state.reextractions,
      actions: [...state.outcomes.values()],
      reason,
    };
    this.emit({ ev: 'run.summary', ...summary });
    return summary;
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────────

/**
 * WorldState update on a verify PASS (plan design decision #2): a non-empty `successPredicate`, else
 * fall back to `effects`. An empty-but-present `successPredicate` (the schema permits
 * `{command, successPredicate:{}}`) is treated as absent so a pass still records real progress.
 */
function passUpdate(action: Action): Partial<WorldState> {
  const sp = action.verify.successPredicate;
  return sp && Object.keys(sp).length > 0 ? sp : action.effects;
}

/** Apply a partial update to a WorldState, skipping undefined values (keeps the result total). */
function mergeState(state: WorldState, update: Partial<WorldState>): WorldState {
  const next: WorldState = { ...state };
  for (const [k, v] of Object.entries(update)) {
    if (v !== undefined) next[k] = v;
  }
  return next;
}

function buildEvidence(action: Action, agentRun: { stderr?: string; diffRef?: string }, v?: { exitCode: number; stdout: string; stderr: string }): FailureEvidence {
  const e: FailureEvidence = { actionId: action.id };
  if (action.verify.command) e.verifyCommand = action.verify.command;
  if (v) {
    e.verifyExitCode = v.exitCode;
    if (v.stdout) e.verifyStdout = v.stdout.slice(0, 2000);
    if (v.stderr) e.verifyStderr = v.stderr.slice(0, 2000);
  }
  if (agentRun.stderr) e.agentStderr = agentRun.stderr.slice(0, 2000);
  if (agentRun.diffRef) e.diffRef = agentRun.diffRef;
  return e;
}

/** Fold a planner intake error into the evidence fed to `expand()` (plan #3). */
function withValidation(evidence: FailureEvidence, error: Error): FailureEvidence {
  return { ...evidence, verifyStderr: `planner intake error: ${error.message}` };
}

/** Summary for a failure that happens before any RunState exists (e.g. extraction itself failed). */
function bareSummary(goalText: string, status: RunStatus, reason: string): RunSummary {
  return { status, goalText, costUsd: 0, replans: 0, reextractions: 0, actions: [], reason };
}

/** Default confirm-DoD gate: pretty-print the DoD to stdout, read one y/n line from stdin. */
export const stdinConfirm: DodConfirmer = async (dod) => {
  const { createInterface } = await import('node:readline/promises');
  const lines = [
    '',
    '=== Definition of Done — confirm before executing ===',
    `Goal: ${dod.goalText}`,
    `Goal state: ${JSON.stringify(dod.goalState)}`,
    `Completion policy: ${dod.completionPolicy}`,
    'Planned actions:',
    ...dod.actions.map((a, i) => {
      const check = a.verify.command
        ? `verify: ${a.verify.command}`
        : `verify predicate: ${JSON.stringify(a.verify.successPredicate ?? {})}`;
      return `  ${i + 1}. ${a.name}  (${check})`;
    }),
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Proceed? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};
