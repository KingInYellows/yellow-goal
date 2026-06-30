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

/** Operator confirmation of the DoD. Production reads stdin; tests inject a deterministic answer.
 *  `signal` is the run's AbortSignal (SIGINT/SIGTERM) — a confirmer waiting on input (e.g. stdin)
 *  must race against it so kill control stops promptly at confirmation prompts too (PR #10 review P2). */
export type DodConfirmer = (dod: DodInfo, signal: AbortSignal) => Promise<boolean>;

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
  /** Completions per actionId, COUNTED not boolean: the planner may legitimately re-emit the same
   *  pool action at more than one plan step (e.g. an intervening step undoes its effect), so a
   *  Set<actionId> would mark every later occurrence "done" after the first pass. `nextStep` walks
   *  `plan.steps` matching each step's ORDINAL occurrence of its actionId against this count, so a
   *  later repeat of an already-passed action is still dispatched (PR #8 review P2).
   *
   *  KNOWN LIMITATION (PR #9 review, chatgpt-codex-connector): these counts accumulate over the whole
   *  run, not scoped to the currently active plan. A forced replan whose new plan re-requires an
   *  action whose prior completion was invalidated by an intervening ground-truth change (e.g. a later
   *  step's successPredicate cleared what an earlier plan's pass had established) can be skipped as
   *  already-done. An attempted fix that reset this map whenever `nextStep` saw a different `plan.id`
   *  was reverted here after it regressed the "livelock guard (forced-replan streak)" test: the reset
   *  fired on the very first forced replan (a content-hash-scoped `plan.id` changes whenever
   *  `currentState` advances, which happens on every real dispatch, not just on the invalidation case
   *  this was meant to catch), causing an already-passed action to be redispatched. A correct fix needs
   *  to distinguish "this plan is new because ground truth invalidated a completion" from "this plan is
   *  new because currentState legitimately advanced" — left open pending a proper design decision. */
  completed: Map<string, number>;
  /** Action ids the operator has confirmed (initial DoD + every re-confirm). A replan that surfaces
   *  an id NOT in here must be re-confirmed before its verify.command runs (PR #8 review P1). */
  confirmed: Set<string>;
  replans: number;
  /** Consecutive forced replans (plan exhausted / step stale) with NO action dispatched in between.
   *  Reset on every dispatch; bounded by maxReplans to break no-progress loops (livelock guard). */
  replanStreak: number;
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
    let extractCostUsd = 0;
    try {
      const extracted = await this.extractor.extract(req, this.signal);
      goalSpec = extracted.goalSpec;
      extractCostUsd = extracted.costUsd;
    } catch (e) {
      const message = (e as Error).message;
      // Mirrors reextract()'s expand()-failure accounting below: a failed completion + repair round
      // still spends money, which ExtractionError carries on `detail.costUsd` when the extractor knows
      // it (see llm-extractor.ts extract()). Fold it in so the failure/cancel summary's costUsd stays
      // accurate instead of silently reporting 0 spend via bareSummary().
      const detail = (e as { detail?: Record<string, unknown> }).detail;
      const failedCostUsd = detail !== undefined && typeof detail.costUsd === 'number' ? detail.costUsd : 0;
      this.emit({ ev: 'extract.failed', message, costUsd: failedCostUsd });
      // Item 3 (Ctrl-C consistency): an abort during extraction must surface as 'cancelled', the same
      // terminal status the main loop returns for every other abort path — not 'failed'.
      if (this.signal.aborted) return bareSummary(req.goalText, 'cancelled', 'aborted during extraction', failedCostUsd);
      return bareSummary(req.goalText, 'failed', `extraction failed: ${message}`, failedCostUsd);
    }
    // PR #8 review P2: the extractor schema permits `cost <= 0` and duplicate ids (both are deferred
    // to the planner's validateIntake throw, see extractors/schema.ts) — but re-extraction is
    // APPEND-ONLY, so a poisoned INITIAL action can never be removed once it's in the pool and would
    // make every safePlan() throw for the rest of the run, burning the re-extraction cap with no way
    // to recover. Quarantine those entries before they ever enter `state.pool`, the same way the
    // re-extraction ladder already filters `expand()`'s output (see `reextract()`'s `validNew`).
    const sanitized = sanitizeInitialPool(goalSpec.actions);
    if (sanitized.droppedCost > 0 || sanitized.droppedDuplicate > 0) {
      this.emit({
        ev: 'extract.dropped',
        droppedCost: sanitized.droppedCost,
        droppedDuplicate: sanitized.droppedDuplicate,
      });
    }
    const state: RunState = {
      goalText: req.goalText,
      goalSpec,
      currentState: { ...goalSpec.initialState },
      pool: sanitized.valid,
      completed: new Map(),
      confirmed: new Set(),
      replans: 0,
      replanStreak: 0,
      reextractions: 0,
      accumulatedCostUsd: extractCostUsd,
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
    const confirmed = await this.confirm(this.buildDod(state, plan), this.signal);
    if (!confirmed) {
      this.emit({ ev: 'dod.cancelled' });
      return this.summary(state, 'cancelled', 'cancelled at DoD confirmation');
    }
    for (const s of plan.steps) state.confirmed.add(s.actionId);
    this.emit({ ev: 'dod.confirmed', sequence: plan.steps.map((s) => s.actionId) });

    // --- MAIN LOOP (serial) ---
    for (;;) {
      // Item 3: check AbortSignal at the top of every iteration so SIGINT/abort stops promptly.
      if (this.signal.aborted) return this.summary(state, 'cancelled', 'aborted');

      // PR #8 review P2: check the budget cap before the satisfies() branch below. Extraction cost is
      // accumulated before this loop ever runs, so without this check an extraction/repair spend that
      // alone exceeds maxBudgetUsd would slip through as 'succeeded' whenever the extracted initial
      // state already happens to satisfy the goal (per-action budget checks at dispatch time never run).
      if (state.accumulatedCostUsd > this.config.maxBudgetUsd) {
        return this.summary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} exceeded`);
      }

      if (satisfies(state.currentState, state.goalSpec.goalState)) {
        // Item 4: sign-off gate — when the policy requires operator acceptance, prompt before
        // declaring success. On rejection, fall through to replan/re-extraction.
        const policy = state.goalSpec.completionPolicy;
        if (policy === 'verify+signoff' || policy === 'operator-defined') {
          const accepted = await this.confirm(this.buildDod(state, plan), this.signal);
          if (accepted) return this.summary(state, 'succeeded', 'goalState satisfied and operator signed off');
          // Rejection AFTER goalState is already satisfied: re-planning here is incoherent — the
          // deterministic planner from a satisfied state returns a zero-step plan, so the loop would
          // spin (re-prompting sign-off forever) with no actions able to change the outcome. Return a
          // non-succeeded terminal; the operator can re-run with adjusted goalState/verify criteria.
          this.emit({ ev: 'signoff.rejected' });
          return this.summary(state, 'cancelled', 'operator rejected sign-off after goalState satisfied');
        }
        return this.summary(state, 'succeeded', 'goalState satisfied');
      }

      const step = this.nextStep(plan, state);
      if (step === undefined) {
        // Current plan exhausted but goal unmet — recompute from the real current state. forcedReplan
        // bounds the no-progress streak (a re-plan that keeps surfacing a step the ground-truth state
        // can never satisfy is a loop) and still escalates a malformed pool to re-extraction (#3).
        const o = await this.forcedReplan(state, { actionId: '(plan-exhausted)' }, 'plan exhausted but goalState unmet and no further progress possible');
        if (o.kind === 'terminal') return o.summary;
        plan = o.plan;
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

      // A verify pass applies the action's `successPredicate` to currentState, which can be NARROWER
      // than the action's declared `effects` — so a downstream planned step's preconditions may no
      // longer hold in the ground-truth currentState. Re-plan from currentState rather than dispatching
      // a step with unmet preconditions. If a narrow successPredicate keeps the re-planned step stale,
      // the planner (blind to which ids are already completed) can re-emit it every iteration; forcedReplan
      // bounds that no-progress streak so the loop terminates (wall-clock is deferred in v1).
      if (!satisfies(state.currentState, action.preconditions)) {
        this.emit({ ev: 'plan.stale', actionId: action.id, reason: 'preconditions unmet by ground-truth state' });
        const o = await this.forcedReplan(state, { actionId: action.id }, 'planned step preconditions unmet by ground-truth state and no replan possible');
        if (o.kind === 'terminal') return o.summary;
        plan = o.plan;
        continue;
      }

      // PR #8 review P1: a same-pool replan can surface an action that was in the LLM-authored pool but
      // omitted from the operator-confirmed plan. Never run an unconfirmed action's verify.command without
      // showing it — re-confirm the DoD whenever the about-to-dispatch action was not previously confirmed.
      if (!state.confirmed.has(action.id)) {
        const okay = await this.confirm(this.buildDod(state, plan), this.signal);
        if (!okay) {
          this.emit({ ev: 'dod.cancelled', reason: 'replan introduced unconfirmed action(s)', actionId: action.id });
          return this.summary(state, 'cancelled', 'cancelled at re-confirmation of replan-introduced actions');
        }
        for (const s of plan.steps) state.confirmed.add(s.actionId);
        this.emit({ ev: 'dod.reconfirmed', reason: 'replan introduced unconfirmed action(s)', actionId: action.id });
      }

      // Budget check BEFORE dispatch (plan task 4.3).
      if (state.accumulatedCostUsd >= this.config.maxBudgetUsd) {
        return this.summary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} reached`);
      }

      const result = await this.executeStep(state, action, plan.id);
      // A real dispatch happened → reset the forced-replan no-progress streak (livelock guard).
      state.replanStreak = 0;
      // Item 3: check signal again after an await that may have taken a long time.
      if (this.signal.aborted) return this.summary(state, 'cancelled', 'aborted after step');
      if (result.kind === 'budget') {
        return this.summary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} reached mid-action`);
      }
      // Item 6: enforce budget AFTER each action's cost is accumulated (not only pre-dispatch). Use
      // `>` so an action that spent EXACTLY to the cap still completes — it succeeded within budget,
      // and the next iteration's pre-dispatch `>=` check stops further work before overspending.
      if (state.accumulatedCostUsd > this.config.maxBudgetUsd) {
        return this.summary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} exceeded post-action`);
      }
      if (result.kind === 'passed') {
        state.completed.set(action.id, (state.completed.get(action.id) ?? 0) + 1);
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
        try {
          await handle.cleanup();
        } catch (cleanupErr) {
          this.emit({ ev: 'cleanup.error', actionId: action.id, message: (cleanupErr as Error).message });
        }
      }
    }
    return { kind: 'failed', attempts, costUsd: stepCost, evidence: lastEvidence };
  }

  // ── Planning / replan ladder ───────────────────────────────────────────────────────────────--

  /** Plan over the CURRENT pool from the CURRENT state, catching the planner's intake throw (#3).
   *  `poolOverride` lets a caller plan over a subset of `state.pool` (e.g. quarantining a known-failed
   *  action for a single recovery attempt) without mutating the append-only pool itself. */
  private safePlan(state: RunState, poolOverride?: Action[]): SafePlanResult {
    const goalSpec: GoalSpec = { ...state.goalSpec, initialState: state.currentState, actions: poolOverride ?? state.pool };
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
   * Forced replan after a plan is exhausted or a planned step has gone stale (its preconditions no
   * longer hold in the ground-truth state). Distinct from the post-failure ladder: there was no action
   * failure, just a state/plan mismatch. Bounds the no-progress streak — a narrow successPredicate can
   * make the re-planned step perpetually stale, and the planner (blind to which ids are already
   * completed) keeps re-emitting it, so without a cap this spins forever (wall-clock is deferred in v1).
   * On streak exhaustion, escalate to re-extraction (new actions may unblock the goal), itself bounded
   * by maxReextractions. A `plan()` throw still routes straight to re-extraction (design decision #3).
   */
  private async forcedReplan(state: RunState, evidence: FailureEvidence, failReason: string): Promise<PlanOutcome> {
    if (state.replanStreak >= this.config.maxReplans) {
      this.emit({ ev: 'replan.loop', replanStreak: state.replanStreak, forActionId: evidence.actionId });
      return this.reextract(state, {
        ...evidence,
        verifyStderr: `${state.replanStreak} consecutive replans made no progress (loop); escalating to re-extraction`,
      });
    }
    const r = this.safePlan(state);
    if (r.threw) {
      this.emit({ ev: 'plan.threw', message: r.error.message });
      return this.reextract(state, withValidation(evidence, r.error));
    }
    if (r.plan === null || this.nextStep(r.plan, state) === undefined) {
      // A no-plan (or a plan with no dispatchable next step) is, like the streak-exhaustion branch
      // above and the rest of the ladder (obtainPlan / replanLadder), a trigger to escalate to bounded
      // re-extraction — NOT an immediate terminal failure. The existing pool may simply be missing an
      // action; reextract() is itself capped by maxReextractions + the budget guard, so this cannot spin.
      this.emit({ ev: 'replan.exhausted', forActionId: evidence.actionId, failReason });
      return this.reextract(state, { ...evidence, verifyStderr: failReason });
    }
    state.replanStreak++;
    this.emit({ ev: 'replanned', forced: true, replanStreak: state.replanStreak });
    return { kind: 'plan', plan: r.plan };
  }

  /**
   * Post-failure ladder (plan task 4.4): try a re-plan over the existing pool (counts a replan); if
   * the same subgoal has failed too often, the replan cap is hit, or there's no plan, escalate to
   * re-extraction. A `plan()` throw routes straight to re-extraction with the validation error.
   */
  private async replanLadder(state: RunState, failedActionId: string, evidence: FailureEvidence): Promise<PlanOutcome> {
    // Item 7: CLAUDE.md loop-detection = "same action fails the SAME way twice". Compare
    // the last two FailureRecords' normalized signatures before treating as a loop.
    const failHistory = state.failures.get(failedActionId) ?? [];
    const sameFails = failHistory.length;
    const last = failHistory[failHistory.length - 1];
    const prev = failHistory[failHistory.length - 2];
    const isLoop = last !== undefined && prev !== undefined &&
      last.verifyExitCode === prev.verifyExitCode &&
      last.verifyStderr.slice(0, 200) === prev.verifyStderr.slice(0, 200);
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
    // PR #8 review P2: re-extraction calls `claude -p` (real spend). Refuse to START one once the budget
    // is already exhausted — the main loop's pre-dispatch check is too late to bound a recursive
    // re-extraction's spend (this path can append, plan, and recurse before any executor dispatch).
    if (state.accumulatedCostUsd >= this.config.maxBudgetUsd) {
      return { kind: 'terminal', summary: this.summary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} reached before re-extraction`) };
    }
    state.reextractions++;
    this.emit({ ev: 'reextract', reextractions: state.reextractions, forActionId: evidence.actionId });
    let expanded: { actions: Action[]; costUsd: number };
    try {
      expanded = await this.extractor.expand(state.goalText, state.currentState, evidence, state.pool, this.signal);
    } catch (e) {
      // PR #8 review P2: expand() only returns costUsd on success — a failed completion + repair
      // round still spends money, which ExtractionError now carries on `detail.costUsd`. Fold it in
      // here (mirroring the success-path accounting below) so a malformed expansion's spend is never
      // silently dropped from the run's budget accounting, even though this path always terminates
      // 'failed' (not 'budget-exhausted') — the expand() failure is the actual reason, regardless of
      // whether the folded cost happens to tip the run over the cap.
      const detail = (e as { detail?: Record<string, unknown> }).detail;
      const failedCostUsd = detail !== undefined && typeof detail.costUsd === 'number' ? detail.costUsd : 0;
      state.accumulatedCostUsd += failedCostUsd;
      return { kind: 'terminal', summary: this.summary(state, 'failed', `expand failed: ${(e as Error).message}`) };
    }
    // PR #8 review P2: account the spend immediately and stop if this expansion pushed the run over the
    // cap (`>` so spending EXACTLY to the cap still proceeds, mirroring the executor budget rule).
    state.accumulatedCostUsd += expanded.costUsd;
    if (state.accumulatedCostUsd > this.config.maxBudgetUsd) {
      return { kind: 'terminal', summary: this.summary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} exceeded by re-extraction`) };
    }
    // Validate expanded actions BEFORE appending so a malformed one cannot permanently poison the
    // pool (append-only) and make every subsequent plan() throw. The extractor schema enforces
    // structure + non-empty verify, and expand() already de-dups ids against the pool; the remaining
    // poison vector is `cost <= 0` (the schema defers cost>0 to the planner by design decision #3).
    // Drop those here; if nothing usable survives, the re-extraction made no progress.
    const validNew = expanded.actions.filter((a) => a.cost > 0);
    const dropped = expanded.actions.length - validNew.length;
    if (dropped > 0) this.emit({ ev: 'reextract.dropped', dropped, reason: 'cost <= 0' });
    // Append only the valid actions. If nothing usable was added, we do NOT short-circuit here: the
    // following safePlan() will either find no plan or re-throw on the still-malformed pool, and the
    // re-extraction cap bounds the loop — same path as any other no-progress re-extraction.
    state.pool = [...state.pool, ...validNew];
    this.emit({ ev: 'reextract.added', added: validNew.length, poolSize: state.pool.length });

    // Review P2 (chatgpt-codex-connector): if this re-extraction was triggered by a real verify
    // failure (not a placeholder reason like plan-exhausted), the failed action is still sitting in
    // `state.pool` and may still look like the planner's cheapest path to the goal even though it can
    // never pass verify again — the planner has no notion of ground-truth failure. Quarantine it from
    // THIS recovery attempt only (never mutate the append-only pool) so the just-added actions get a
    // real chance to be selected; fall back to planning over the full pool if excluding it makes the
    // goal unreachable (the failed action may be the only path — same outcome as before this fix).
    const failedId = evidence.actionId;
    const quarantineFailed = state.outcomes.get(failedId)?.status === 'failed';
    let r = quarantineFailed
      ? this.safePlan(state, state.pool.filter((a) => a.id !== failedId))
      : this.safePlan(state);
    if (quarantineFailed && (r.threw || r.plan === null)) {
      r = this.safePlan(state);
    }
    if (r.threw) {
      this.emit({ ev: 'plan.threw', message: r.error.message });
      // Item 9: pass the UPDATED validation error (not the original evidence) so each recursive
      // re-extraction sees the latest planner failure, not a stale earlier one.
      const updatedEvidence = withValidation(evidence, r.error);
      return this.reextract(state, updatedEvidence); // bounded by the cap above
    }
    if (r.plan === null) {
      // PR #8 review P2: this expansion added actions but the augmented pool still can't reach the goal.
      // Don't give up while re-extraction budget remains — keep following the bounded ladder (a later
      // round may add the missing setup action). The cap + budget guard above terminate the loop.
      return this.reextract(state, {
        ...evidence,
        verifyStderr: 'augmented pool still cannot reach goalState; another bounded expansion may add the missing action',
      });
    }
    // Item 5: re-confirm DoD for newly-added actions before executing them, and remember the confirmed
    // ids so the main-loop dispatch gate (PR #8 P1) does not re-prompt for them.
    const reconfirmed = await this.confirm(this.buildDod(state, r.plan), this.signal);
    if (!reconfirmed) {
      this.emit({ ev: 'dod.cancelled', reason: 're-extracted actions not accepted' });
      return { kind: 'terminal', summary: this.summary(state, 'cancelled', 'cancelled at re-extracted DoD confirmation') };
    }
    for (const s of r.plan.steps) state.confirmed.add(s.actionId);
    // A successful re-extraction is a progress event (new actions were added). Reset the forced-replan
    // streak so the returned plan gets a fresh maxReplans budget before the next escalation — otherwise
    // a re-extracted plan whose first step is still stale would inherit the exhausted counter and
    // re-escalate immediately, burning the next re-extraction slot with no breathing room.
    state.replanStreak = 0;
    this.emit({ ev: 'dod.reconfirmed', reextractions: state.reextractions });
    return { kind: 'plan', plan: r.plan };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────

  /**
   * First not-yet-done step, tracked by ORDINAL OCCURRENCE per actionId rather than a single
   * actionId flag: the planner may legitimately re-emit the same pool action at more than one plan
   * step (e.g. an intervening step undoes its effect — non-monotonic plans like
   * [set-x, set-y-and-clear-x, set-x] are valid optimal plans). Walk `plan.steps` in order counting
   * how many times each actionId has been SEEN so far in this walk; the first step whose seen-count
   * (before incrementing) is not yet covered by `state.completed`'s count for that actionId is the
   * next one to dispatch (PR #8 review P2). See the KNOWN LIMITATION note on `RunState.completed`
   * regarding run-scoped (not plan-scoped) counts.
   */
  private nextStep(plan: Plan, state: RunState): PlanStep | undefined {
    const seenSoFar = new Map<string, number>();
    for (const s of plan.steps) {
      const occurrence = seenSoFar.get(s.actionId) ?? 0;
      seenSoFar.set(s.actionId, occurrence + 1);
      const doneCount = state.completed.get(s.actionId) ?? 0;
      if (occurrence >= doneCount) return s;
    }
    return undefined;
  }

  private buildDod(state: RunState, plan: Plan): DodInfo {
    const byId = new Map(state.pool.map((a) => [a.id, a]));
    const policy: CompletionPolicy =
      state.goalSpec.completionPolicy === 'operator-defined' ? 'verify+signoff' : state.goalSpec.completionPolicy;
    return {
      // Use the operator-provided goalText (state.goalText, set verbatim from req.goalText), not
      // state.goalSpec.goalText — the extractor is not required to echo the operator's text exactly,
      // so the latter can show a paraphrased/incorrect goal at the DoD gate and re-confirmations.
      goalText: state.goalText,
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

/**
 * Drop `cost <= 0` actions and de-dup ids (keep the first occurrence) from the extractor's INITIAL
 * action list before it ever becomes `state.pool` (PR #8 review P2). The extractor schema enforces
 * structure + non-empty verify but, by design, defers `cost > 0` and pool-wide unique ids to the
 * planner's `validateIntake` throw — fine for re-extraction (append-only, filtered in `reextract()`),
 * but fatal for the initial pool: a poisoned entry there can never be removed, so it would make every
 * `safePlan()` throw for the rest of the run.
 */
function sanitizeInitialPool(actions: Action[]): { valid: Action[]; droppedCost: number; droppedDuplicate: number } {
  const seen = new Set<string>();
  const valid: Action[] = [];
  let droppedCost = 0;
  let droppedDuplicate = 0;
  for (const a of actions) {
    if (!(a.cost > 0)) {
      droppedCost++;
      continue;
    }
    if (seen.has(a.id)) {
      droppedDuplicate++;
      continue;
    }
    seen.add(a.id);
    valid.push(a);
  }
  return { valid, droppedCost, droppedDuplicate };
}

/** Summary for a failure that happens before any RunState exists (e.g. extraction itself failed).
 *  `costUsd` defaults to 0 but callers pass through any spend an ExtractionError carried on
 *  `detail.costUsd` so budget accounting stays accurate even when extraction itself fails. */
function bareSummary(goalText: string, status: RunStatus, reason: string, costUsd = 0): RunSummary {
  return { status, goalText, costUsd, replans: 0, reextractions: 0, actions: [], reason };
}

/** Default confirm-DoD gate: pretty-print the DoD to stdout, read one y/n line from stdin.
 *  Races the prompt against `signal` (SIGINT/SIGTERM) so an abort while waiting on stdin stops the
 *  prompt immediately instead of leaving the run stuck until the operator types something (PR #10
 *  review P2) — treated the same as a rejected confirmation ('cancelled', not a hang or a throw). */
export const stdinConfirm: DodConfirmer = async (dod, signal) => {
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
  if (signal.aborted) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Proceed? [y/N] ', { signal });
    return /^y(es)?$/i.test(answer.trim());
  } catch (e) {
    if (signal.aborted) return false; // aborted mid-prompt (SIGINT/SIGTERM) — treat as declined, not a crash
    throw e;
  } finally {
    rl.close();
  }
};
