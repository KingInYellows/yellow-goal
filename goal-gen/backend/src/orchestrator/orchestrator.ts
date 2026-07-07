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
import { createHash, randomUUID } from 'node:crypto';
import { plan as runPlanner } from '../planner/plan';
import { satisfies } from '../planner/simulate';
import { createWorktree } from '../executors/worktree';
import type { WorktreeHandle, CreateWorktreeOptions } from '../executors/worktree';
import { captureDiff } from '../executors/diff-capture';
import { stepId } from '../db/repository';
import type { Action, CompletionPolicy, GoalSpec, Plan, PlanStep, WorldState } from '../planner/types';
import type {
  ActionOutcome,
  AgentRun,
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
import { AsyncLatch } from './async-gate';

type PersistedRunStatus = RunStatus | 'running';

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
 *  must race against it so kill control stops promptly at confirmation prompts too (PR #10 review P2).
 *  `kind` distinguishes the initial DoD confirm from an automatic mid-run re-confirm (R24) — for
 *  observability only; both resolve via the same `POST /runs/:id/step {decision}` endpoint, so no
 *  confirmer implementation needs to branch its behavior on it. */
export type DodConfirmer = (dod: DodInfo, signal: AbortSignal, kind: 'dod' | 'reconfirm') => Promise<boolean>;

/** Sign-off gate replacing the old synchronous confirm()-reuse (R30) — a distinct decision shape
 *  ('accept' | 'reject', not boolean) resolved via `POST /runs/:id/accept`, not `/step`. Production
 *  reads stdin (mirroring `stdinConfirm`); tests inject a deterministic answer. */
export type AcceptanceGate = (dod: DodInfo, signal: AbortSignal) => Promise<'accept' | 'reject'>;

/** Provides a fresh per-action worktree. Production = `createWorktree`; tests inject a stub. */
export type WorktreeProvider = (opts: CreateWorktreeOptions) => Promise<WorktreeHandle>;

/**
 * Optional persistence seam (R1-R6): when injected, the orchestrator upserts each newly installed
 * `Plan` (+ its `plan_steps`, R2) and every completed `AgentRun`. Production wires this to
 * `db/repository.ts`; tests inject a fake so new tests can assert on persisted rows while existing
 * tests (which never pass `persistence`) are entirely unaffected — see `noopPersistence` below.
 */
export interface PersistenceProvider {
  upsertGoalSpec(goalSpec: { id: string; goalText: string; goalState: Partial<WorldState>; completionPolicy: CompletionPolicy }): Promise<void>;
  upsertPlan(plan: Plan): Promise<void>;
  insertRun(run: { id: string; planId: string; status: 'running'; startedAt: string }): Promise<void>;
  insertAgentRun(agentRun: AgentRun, runId: string): Promise<void>;
  /** Transition an existing run's status (R29/R30) — e.g. into `'awaiting-acceptance'`. */
  updateRunStatus(runId: string, status: PersistedRunStatus): Promise<void>;
  /** Durable event-log write (R5); this shell wires only the `AwaitingAcceptance` transition
   *  (R31, synchronous on the gate-entry path) — every other event type's write is shell 03's
   *  async `onEvent` queue (R19). */
  insertRunEvent(event: { runId: string; planId: string; stepId?: string; type: string; payload: Record<string, unknown> }): Promise<void>;
}

/** Default no-op persistence — existing CLI/test usage that never injects `persistence` sees zero
 *  behavior change (Harness extension in `orchestrator.test.ts` is additive, per plan Step 9). */
const noopPersistence: PersistenceProvider = {
  upsertGoalSpec: async () => {},
  upsertPlan: async () => {},
  insertRun: async () => {},
  insertAgentRun: async () => {},
  updateRunStatus: async () => {},
  insertRunEvent: async () => {},
};

export interface OrchestratorDeps {
  extractor: LlmExtractor;
  executor: Executor;
  verifier: Verifier;
  config?: RunConfig;
  confirm?: DodConfirmer;
  /** Sign-off gate (R30); defaults to a stdin-based prompt (`stdinAcceptanceGate`). */
  acceptanceGate?: AcceptanceGate;
  worktreeProvider?: WorktreeProvider;
  onEvent?: (event: Record<string, unknown>) => void;
  /** Cancellation: propagated to the executor; default never aborts. */
  signal?: AbortSignal;
  /** Optional persistence seam (R1-R6); defaults to a no-op. */
  persistence?: PersistenceProvider;
  /** Pause/resume latch (R26/R27), checked at the top of the run loop; defaults to a fresh,
   *  never-paused instance (no behavior change unless a caller — `RunSession` — calls `.pause()`). */
  pauseLatch?: AsyncLatch;
}

/** Mutable per-run state — local to one `run()` so the orchestrator instance is reusable. */
interface RunState {
  goalText: string;
  goalSpec: GoalSpec;
  currentState: WorldState;
  pool: Action[];
  /**
   * Index into the CURRENTLY ACTIVE `plan.steps` of the next step to dispatch (PR #8/#9 review — 5
   * threads on `RunState.completed` cross-plan staleness, resolved by replacing that run-scoped
   * counter with this plan-local cursor). Advances by exactly 1 on every real PASS; walking the
   * active plan's array in strict order handles a pool action legitimately re-emitted at more than
   * one step WITHIN one plan (e.g. an intervening step undoes its effect — non-monotonic plans like
   * [A, C, B, A] are valid optimal plans) with no ambiguity, because dispatch order never branches.
   *
   * The only place cross-plan reconciliation is needed is at INSTALL time: every site that installs
   * a brand-new `plan` object (initial obtainPlan, forcedReplan, replanLadder, reextract) recomputes
   * this cursor via `firstUndonePosition`, which fast-forwards past a LEADING run of steps whose
   * action's established effect (`successPredicate ?? effects`) already holds in ground-truth
   * `currentState` — so a freshly (re)planned action already reflected in ground truth is not
   * redundantly redispatched, while one a later step invalidated (cleared/changed) IS dispatched
   * again, because ground truth no longer matches what it left.
   *
   * This must NOT be done by invalidating/decrementing counts per-pass instead: an earlier attempt
   * along those lines broke non-monotonic plans with 3+ occurrences of a repeated actionId (e.g.
   * [P, Q, P, R] where Q's own effect gets invalidated by the second P) by making an EARLIER,
   * already-dispatched step look "undone" again — the walk would jump backward to Q instead of
   * forward to R. Scanning strictly forward via one index, fast-forwarded only at install time,
   * avoids that: a position once passed is never re-examined mid-plan.
   */
  planCursor: number;
  /** True while dispatching remediation actions after a rejected sign-off despite goalState already
   *  being satisfied. Without this, the top-of-loop satisfied check reopens sign-off before the
   *  remediation plan can run. */
  signoffRemediationActive: boolean;
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
  /** False until `runs` row insertion has been attempted; initial extraction/planning failures have no row. */
  runPersisted: boolean;
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
  private readonly acceptanceGate: AcceptanceGate;
  private readonly worktreeProvider: WorktreeProvider;
  private readonly emit: (event: Record<string, unknown>) => void;
  private readonly signal: AbortSignal;
  private readonly persistence: PersistenceProvider;
  private readonly pauseLatch: AsyncLatch;

  constructor(deps: OrchestratorDeps) {
    this.extractor = deps.extractor;
    this.executor = deps.executor;
    this.verifier = deps.verifier;
    this.config = deps.config ?? defaultRunConfig();
    this.confirm = deps.confirm ?? stdinConfirm;
    this.acceptanceGate = deps.acceptanceGate ?? stdinAcceptanceGate;
    this.worktreeProvider = deps.worktreeProvider ?? createWorktree;
    this.emit = deps.onEvent ?? (() => {});
    this.signal = deps.signal ?? new AbortController().signal;
    this.persistence = deps.persistence ?? noopPersistence;
    this.pauseLatch = deps.pauseLatch ?? new AsyncLatch();
  }

  /**
   * Run the full loop for one goal and return its terminal summary. Never throws.
   *
   * `runId` is minted per CALL (R3), not per-instance: `RunState`'s doc comment states this
   * orchestrator instance is reusable across successive `run()` calls, so a constructor-time
   * runId would collide on worktree branch names (`${runId}-${safeId}-${attempts}`) across two
   * calls on the same instance. The future API layer passes its minted UUID here (R4); CLI/tests
   * that omit it get a fresh `crypto.randomUUID()` per call, preserving current behavior.
   */
  async run(req: ExtractRequest, runId?: string): Promise<RunSummary> {
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
      planCursor: 0,
      signoffRemediationActive: false,
      confirmed: new Set(),
      replans: 0,
      replanStreak: 0,
      reextractions: 0,
      accumulatedCostUsd: extractCostUsd,
      failures: new Map(),
      outcomes: new Map(),
      runId: runId ?? randomUUID(),
      runPersisted: false,
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
    // `runs.planId` is the INITIATING plan (spec Data Model) — only mintable once the first plan exists.
    await this.persistRun(state, plan);

    // --- CONFIRM DoD ---
    const confirmed = await this.confirm(this.buildDod(state, plan), this.signal, 'dod');
    if (!confirmed) {
      this.emit({ ev: 'dod.cancelled' });
      return this.terminalSummary(state, 'cancelled', 'cancelled at DoD confirmation');
    }
    for (const s of plan.steps) state.confirmed.add(s.actionId);
    this.emit({ ev: 'dod.confirmed', sequence: plan.steps.map((s) => s.actionId) });

    // --- MAIN LOOP (serial) ---
    for (;;) {
      // Item 3: check AbortSignal at the top of every iteration so SIGINT/abort stops promptly.
      if (this.signal.aborted) return this.terminalSummary(state, 'cancelled', 'aborted');

      // R26: pause takes effect before the NEXT step dispatch, never preempting an in-flight step.
      // `whenResumed` never rejects, so re-check the signal (it may have fired while paused) rather
      // than assuming resolution means "resumed".
      await this.pauseLatch.whenResumed(this.signal);
      if (this.signal.aborted) return this.terminalSummary(state, 'cancelled', 'aborted');

      // PR #8 review P2: check the budget cap before the satisfies() branch below. Extraction cost is
      // accumulated before this loop ever runs, so without this check an extraction/repair spend that
      // alone exceeds maxBudgetUsd would slip through as 'succeeded' whenever the extracted initial
      // state already happens to satisfy the goal (per-action budget checks at dispatch time never run).
      if (state.accumulatedCostUsd > this.config.maxBudgetUsd) {
        return this.terminalSummary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} exceeded`);
      }

      if (!state.signoffRemediationActive && satisfies(state.currentState, state.goalSpec.goalState)) {
        // Item 4 / R30: sign-off gate — when the policy requires operator acceptance, prompt before
        // declaring success. On rejection, continue through the bounded re-extraction ladder.
        const policy = state.goalSpec.completionPolicy;
        if (policy === 'verify+signoff' || policy === 'operator-defined') {
          // R31: the awaiting-acceptance status/event write happens on this AWAITED gate-entry path
          // (not via the lazy onEvent drain R19 uses for other events, since that async queue is a
          // later shell), so a concurrent GET /runs/:id can never observe a stale non-awaiting status.
          await this.persistAwaitingAcceptance(state, plan);
          const decision = await this.acceptanceGate(this.buildDod(state, plan), this.signal);
          if (this.signal.aborted) return this.terminalSummary(state, 'cancelled', 'aborted during sign-off');
          if (decision === 'accept') {
            return this.terminalSummary(state, 'succeeded', 'goalState satisfied and operator signed off');
          }
          this.emit({ ev: 'signoff.rejected' });
          if (state.runPersisted) {
            await this.persistRunStatus(state, 'running', 'resumeAfterSignoffRejected');
          }
          const o = await this.remediateRejectedSignoff(state, plan);
          if (o.kind === 'terminal') return o.summary;
          plan = o.plan;
          continue;
        }
        return this.terminalSummary(state, 'succeeded', 'goalState satisfied');
      }

      const step = this.nextStep(plan, state);
      if (step === undefined) {
        if (state.signoffRemediationActive) {
          state.signoffRemediationActive = false;
          state.planCursor = 0;
          this.emit({ ev: 'signoff.remediation.done' });
          continue;
        }
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
        const okay = await this.confirm(this.buildDod(state, plan), this.signal, 'reconfirm');
        if (!okay) {
          this.emit({ ev: 'dod.cancelled', reason: 'replan introduced unconfirmed action(s)', actionId: action.id });
          return this.terminalSummary(state, 'cancelled', 'cancelled at re-confirmation of replan-introduced actions');
        }
        for (const s of plan.steps) state.confirmed.add(s.actionId);
        this.emit({ ev: 'dod.reconfirmed', reason: 'replan introduced unconfirmed action(s)', actionId: action.id });
      }

      // Budget check BEFORE dispatch (plan task 4.3).
      if (state.accumulatedCostUsd >= this.config.maxBudgetUsd) {
        return this.terminalSummary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} reached`);
      }

      const result = await this.executeStep(state, action, plan.id);
      // A real dispatch happened → reset the forced-replan no-progress streak (livelock guard).
      state.replanStreak = 0;
      // Item 3: check signal again after an await that may have taken a long time.
      if (this.signal.aborted) return this.terminalSummary(state, 'cancelled', 'aborted after step');
      if (result.kind === 'budget') {
        return this.terminalSummary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} reached mid-action`);
      }
      // Item 6: enforce budget AFTER each action's cost is accumulated (not only pre-dispatch). Use
      // `>` so an action that spent EXACTLY to the cap still completes — it succeeded within budget,
      // and the next iteration's pre-dispatch `>=` check stops further work before overspending.
      if (state.accumulatedCostUsd > this.config.maxBudgetUsd) {
        return this.terminalSummary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} exceeded post-action`);
      }
      if (result.kind === 'passed') {
        state.planCursor++;
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
      if (state.signoffRemediationActive) {
        const o = await this.remediateRejectedSignoff(state, plan, result.evidence);
        if (o.kind === 'terminal') return o.summary;
        plan = o.plan;
        continue;
      }
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
        // Deterministic stepId (planId + the dispatched step's sequence index) — same derivation
        // `repository.ts`'s upsertPlan() used to mint the corresponding `plan_steps` row (R2).
        agentRun.stepId = stepId(planId, state.planCursor);
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

        // Run verify BEFORE capturing the diff: captureDiff()'s `git add -N .` mutates this
        // worktree's index, so a verify command that inspects git state (e.g. `git status`,
        // `git diff --cached`, a staged-file linter) must observe the executor's post-run state,
        // not the intent-to-added index. Capture happens after, still inside the try (before the
        // finally's handle.cleanup() destroys the git objects).
        const cmd = action.verify.command;
        let passed = false;
        if (cmd && cmd.trim().length > 0) {
          const v = await this.verifier.run(cmd, ctx);
          this.emit({ ev: 'verify', actionId: action.id, attempt: attempts, exitCode: v.exitCode });
          if (v.exitCode === 0) passed = true;
          else lastEvidence = buildEvidence(action, agentRun, v);
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

        // R6: capture the full diff AFTER verify (so the verifier saw the unmutated worktree) but
        // BEFORE handle.cleanup() (finally block below) destroys the git objects. Diffs against the
        // worktree's stored baseline, not bare HEAD, so this is correct even when the agent ran
        // `git commit` (activityOracle's `headMoved` case).
        const diffContent = captureDiff(handle.worktreePath, handle.initialSha);
        if (diffContent !== undefined) agentRun.diffContent = diffContent;
        await this.persistAgentRun(agentRun, state.runId);

        if (passed) return { kind: 'passed', attempts, costUsd: stepCost };
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
    if (r.plan !== null) {
      state.planCursor = firstUndonePosition(r.plan, state.currentState, state.pool);
      return this.planResult(state, r.plan);
    }
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
    const cursor = r.plan !== null ? firstUndonePosition(r.plan, state.currentState, state.pool) : 0;
    if (r.plan === null || cursor >= r.plan.steps.length) {
      // A no-plan (or a plan with no dispatchable next step) is, like the streak-exhaustion branch
      // above and the rest of the ladder (obtainPlan / replanLadder), a trigger to escalate to bounded
      // re-extraction — NOT an immediate terminal failure. The existing pool may simply be missing an
      // action; reextract() is itself capped by maxReextractions + the budget guard, so this cannot spin.
      this.emit({ ev: 'replan.exhausted', forActionId: evidence.actionId, failReason });
      return this.reextract(state, { ...evidence, verifyStderr: failReason });
    }
    state.replanStreak++;
    state.planCursor = cursor;
    this.emit({ ev: 'replanned', forced: true, replanStreak: state.replanStreak });
    return this.planResult(state, r.plan);
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
        state.planCursor = firstUndonePosition(r.plan, state.currentState, state.pool);
        this.emit({ ev: 'replanned', replans: state.replans });
        return this.planResult(state, r.plan);
      }
    }
    return this.reextract(state, evidence);
  }

  /** Bounded re-extraction: append-only `expand()`, then re-plan; a post-expand throw recurses (capped). */
  private async reextract(state: RunState, evidence: FailureEvidence): Promise<PlanOutcome> {
    if (state.reextractions >= this.config.maxReextractions) {
      return {
        kind: 'terminal',
        summary: await this.terminalSummary(state, 'failed', `re-extraction cap (${this.config.maxReextractions}) reached; goal unreachable`),
      };
    }
    // PR #8 review P2: re-extraction calls `claude -p` (real spend). Refuse to START one once the budget
    // is already exhausted — the main loop's pre-dispatch check is too late to bound a recursive
    // re-extraction's spend (this path can append, plan, and recurse before any executor dispatch).
    if (state.accumulatedCostUsd >= this.config.maxBudgetUsd) {
      return { kind: 'terminal', summary: await this.terminalSummary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} reached before re-extraction`) };
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
      // Item 6 (PR #8 review, chatgpt-codex-connector): mirror the initial-extraction catch above — an
      // abort during expand() must surface as 'cancelled', not 'failed', so an operator kill during
      // recovery re-extraction is reported the same way as every other abort path.
      if (this.signal.aborted) {
        return { kind: 'terminal', summary: await this.terminalSummary(state, 'cancelled', 'aborted during re-extraction') };
      }
      return { kind: 'terminal', summary: await this.terminalSummary(state, 'failed', `expand failed: ${(e as Error).message}`) };
    }
    // PR #8 review P2: account the spend immediately and stop if this expansion pushed the run over the
    // cap (`>` so spending EXACTLY to the cap still proceeds, mirroring the executor budget rule).
    state.accumulatedCostUsd += expanded.costUsd;
    if (state.accumulatedCostUsd > this.config.maxBudgetUsd) {
      return { kind: 'terminal', summary: await this.terminalSummary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} exceeded by re-extraction`) };
    }
    // Validate expanded actions BEFORE appending so a malformed one cannot permanently poison the
    // pool (append-only) and make every subsequent plan() throw. The extractor schema enforces
    // structure + non-empty verify, and expand() already de-dups ids against the pool; the remaining
    // poison vector is `cost <= 0` (the schema defers cost>0 to the planner by design decision #3).
    // Drop those here; if nothing usable survives, the re-extraction made no progress.
    const existingIds = new Set(state.pool.map((a) => a.id));
    const validNew = expanded.actions.filter((a) => a.cost > 0 && !existingIds.has(a.id));
    const droppedCost = expanded.actions.filter((a) => !(a.cost > 0)).length;
    const droppedDuplicate = expanded.actions.filter((a) => a.cost > 0 && existingIds.has(a.id)).length;
    if (droppedCost > 0) this.emit({ ev: 'reextract.dropped', dropped: droppedCost, reason: 'cost <= 0' });
    if (droppedDuplicate > 0) this.emit({ ev: 'reextract.dropped', dropped: droppedDuplicate, reason: 'duplicate id' });
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
    const reconfirmed = await this.confirm(this.buildDod(state, r.plan), this.signal, 'reconfirm');
    if (!reconfirmed) {
      this.emit({ ev: 'dod.cancelled', reason: 're-extracted actions not accepted' });
      return { kind: 'terminal', summary: await this.terminalSummary(state, 'cancelled', 'cancelled at re-extracted DoD confirmation') };
    }
    for (const s of r.plan.steps) state.confirmed.add(s.actionId);
    // A successful re-extraction is a progress event (new actions were added). Reset the forced-replan
    // streak so the returned plan gets a fresh maxReplans budget before the next escalation — otherwise
    // a re-extracted plan whose first step is still stale would inherit the exhausted counter and
    // re-escalate immediately, burning the next re-extraction slot with no breathing room.
    state.replanStreak = 0;
    state.planCursor = firstUndonePosition(r.plan, state.currentState, state.pool);
    this.emit({ ev: 'dod.reconfirmed', reextractions: state.reextractions });
    return this.planResult(state, r.plan);
  }

  /**
   * A rejected sign-off means the symbolic `goalState` is already true but the operator still wants
   * corrective work. The normal planner optimally returns a zero-step plan from a satisfied state, so
   * this path installs the newly-authored remediation actions directly and suppresses the satisfied
   * short-circuit until that plan is exhausted.
   */
  private async remediateRejectedSignoff(state: RunState, currentPlan: Plan, failureEvidence?: FailureEvidence): Promise<PlanOutcome> {
    if (state.reextractions >= this.config.maxReextractions) {
      return {
        kind: 'terminal',
        summary: await this.terminalSummary(state, 'failed', `re-extraction cap (${this.config.maxReextractions}) reached; sign-off remediation unavailable`),
      };
    }
    if (state.accumulatedCostUsd >= this.config.maxBudgetUsd) {
      return { kind: 'terminal', summary: await this.terminalSummary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} reached before sign-off remediation`) };
    }
    const evidence: FailureEvidence =
      failureEvidence !== undefined
        ? {
            ...failureEvidence,
            verifyStderr: `${failureEvidence.verifyStderr ?? ''}\nsign-off remediation failed; author corrective replacement actions`.trim(),
          }
        : {
            actionId: '(signoff-rejected)',
            verifyStderr: 'operator rejected sign-off after goalState satisfied; author corrective remediation actions',
          };
    state.reextractions++;
    this.emit({ ev: 'reextract', reextractions: state.reextractions, forActionId: evidence.actionId });

    let expanded: { actions: Action[]; costUsd: number };
    try {
      expanded = await this.extractor.expand(state.goalText, state.currentState, evidence, state.pool, this.signal);
    } catch (e) {
      const detail = (e as { detail?: Record<string, unknown> }).detail;
      const failedCostUsd = detail !== undefined && typeof detail.costUsd === 'number' ? detail.costUsd : 0;
      state.accumulatedCostUsd += failedCostUsd;
      if (this.signal.aborted) {
        return { kind: 'terminal', summary: await this.terminalSummary(state, 'cancelled', 'aborted during sign-off remediation') };
      }
      return { kind: 'terminal', summary: await this.terminalSummary(state, 'failed', `expand failed: ${(e as Error).message}`) };
    }

    state.accumulatedCostUsd += expanded.costUsd;
    if (state.accumulatedCostUsd > this.config.maxBudgetUsd) {
      return { kind: 'terminal', summary: await this.terminalSummary(state, 'budget-exhausted', `budget cap $${this.config.maxBudgetUsd} exceeded by sign-off remediation`) };
    }

    const validNew = expanded.actions.filter((a) => a.cost > 0);
    const dropped = expanded.actions.length - validNew.length;
    if (dropped > 0) this.emit({ ev: 'reextract.dropped', dropped, reason: 'cost <= 0' });
    state.pool = [...state.pool, ...validNew];
    this.emit({ ev: 'reextract.added', added: validNew.length, poolSize: state.pool.length });
    if (validNew.length === 0) return this.remediateRejectedSignoff(state, currentPlan);

    const remediationPlan = this.buildSignoffRemediationPlan(state, currentPlan, validNew);
    const reconfirmed = await this.confirm(this.buildDod(state, remediationPlan), this.signal, 'reconfirm');
    if (!reconfirmed) {
      this.emit({ ev: 'dod.cancelled', reason: 'sign-off remediation actions not accepted' });
      return { kind: 'terminal', summary: await this.terminalSummary(state, 'cancelled', 'cancelled at sign-off remediation confirmation') };
    }
    for (const s of remediationPlan.steps) state.confirmed.add(s.actionId);
    state.replanStreak = 0;
    state.planCursor = 0;
    state.signoffRemediationActive = true;
    this.emit({ ev: 'dod.reconfirmed', reextractions: state.reextractions, reason: 'sign-off remediation' });
    return this.planResult(state, remediationPlan);
  }

  private buildSignoffRemediationPlan(state: RunState, currentPlan: Plan, actions: Action[]): Plan {
    const actionIds = actions.map((a) => a.id);
    const fingerprint = JSON.stringify({
      goalSpecId: currentPlan.goalSpecId,
      replanOf: currentPlan.id,
      from: sortedStateEntries(state.currentState),
      actions: actionIds,
      reextractions: state.reextractions,
    });
    return {
      id: `plan_signoff_${shortHash(fingerprint)}`,
      goalSpecId: currentPlan.goalSpecId,
      steps: actionIds.map((actionId) => ({ actionId, status: 'pending', dependsOn: [] })),
      totalCost: actions.reduce((sum, a) => sum + a.cost, 0),
      createdFromState: { ...state.currentState },
      replanOf: currentPlan.id,
    };
  }

  // ── Persistence (R1-R6; best-effort — never aborts a run) ──────────────────────────────────────

  /** Wraps a freshly obtained `Plan` as a `PlanOutcome`, upserting it (+ its `plan_steps`, R2)
   *  first — the single choke point all 4 Plan-install sites route through. */
  private async planResult(state: RunState, plan: Plan): Promise<PlanOutcome> {
    await this.persistGoalSpec(state, plan);
    await this.persistPlan(plan);
    return { kind: 'plan', plan };
  }

  /** Best-effort wrapper shared by every persistence call site: never lets a persistence failure
   *  abort a run, surfacing the error as an event instead. */
  private async persistBestEffort(op: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (e) {
      this.emit({ ev: 'persistence.error', op, message: (e as Error).message });
      return false;
    }
  }

  private async persistGoalSpec(state: RunState, plan: Plan): Promise<void> {
    await this.persistBestEffort('upsertGoalSpec', () =>
      this.persistence.upsertGoalSpec({
        id: plan.goalSpecId,
        goalText: state.goalSpec.goalText,
        goalState: state.goalSpec.goalState,
        completionPolicy: state.goalSpec.completionPolicy,
      }),
    );
  }

  private async persistPlan(plan: Plan): Promise<void> {
    await this.persistBestEffort('upsertPlan', () => this.persistence.upsertPlan(plan));
  }

  private async persistRun(state: RunState, plan: Plan): Promise<void> {
    state.runPersisted = await this.persistBestEffort('insertRun', () =>
      this.persistence.insertRun({ id: state.runId, planId: plan.id, status: 'running', startedAt: new Date().toISOString() }),
    );
  }

  private async persistAgentRun(agentRun: AgentRun, runId: string): Promise<void> {
    await this.persistBestEffort('insertAgentRun', () => this.persistence.insertAgentRun(agentRun, runId));
  }

  /** R30/R31: transition the run to `awaiting-acceptance` and persist the event, both awaited
   *  BEFORE the acceptance gate opens — the ordering (not just the individual awaits) is what
   *  R31 requires, so a concurrent `GET /runs/:id` can never observe a stale status. Both calls
   *  share one `persistence.error` op label since R31 treats this as one logical transition. */
  private async persistAwaitingAcceptance(state: RunState, plan: Plan): Promise<void> {
    await this.persistBestEffort('awaitingAcceptance', async () => {
      await this.persistence.updateRunStatus(state.runId, 'awaiting-acceptance');
      await this.persistence.insertRunEvent({ runId: state.runId, planId: plan.id, type: 'AwaitingAcceptance', payload: { goalState: state.goalSpec.goalState } });
    });
  }

  private async persistRunStatus(state: RunState, status: PersistedRunStatus, op: string): Promise<void> {
    await this.persistBestEffort(op, () => this.persistence.updateRunStatus(state.runId, status));
  }

  private async terminalSummary(state: RunState, status: RunStatus, reason: string): Promise<RunSummary> {
    if (state.runPersisted) {
      await this.persistRunStatus(state, status, 'terminalRunStatus');
    }
    return this.summary(state, status, reason);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────

  /** The next not-yet-dispatched step of the CURRENTLY ACTIVE plan — see `RunState.planCursor`. */
  private nextStep(plan: Plan, state: RunState): PlanStep | undefined {
    return plan.steps[state.planCursor];
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

function sortedStateEntries(state: WorldState): Array<[string, WorldState[string]]> {
  return Object.keys(state)
    .sort()
    .map((key) => [key, state[key]!]);
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Cross-plan reconciliation for a freshly (re)computed plan (PR #8/#9 review — resolves the 5
 * threads on `RunState.completed`'s run-scoped staleness). Fast-forwards past a LEADING run of
 * `plan.steps` whose action's established effect (`successPredicate ?? effects`) already holds in
 * ground-truth `currentState` — the planner, unaware of ground truth, may re-propose an action whose
 * real (narrower) contribution is already reflected, and redispatching it would be redundant. Stops
 * at the first step whose establishment does NOT hold, which is either a step never yet dispatched or
 * one a later action's real update since invalidated (cleared/changed) — either way it must run.
 * Returns `plan.steps.length` if every step's establishment already holds (no dispatchable step).
 *
 * An action with an EMPTY establishment (no successPredicate and empty `effects`) is never skipped:
 * `satisfies(state, {})` is vacuously true, which would otherwise fast-forward past a step that has
 * never actually run. The planner's search currently can't select such a no-op action into any plan
 * (applying empty effects reaches the same, already-`closed` state key, so it's pruned — see
 * `plan()`'s inner loop), but the schema/`validateIntake` don't forbid `effects: {}` at the type
 * level, so this guard is cheap insurance against that planner invariant changing later.
 */
function firstUndonePosition(plan: Plan, currentState: WorldState, pool: Action[]): number {
  const byId = new Map(pool.map((a) => [a.id, a]));
  let i = 0;
  for (; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const action = step ? byId.get(step.actionId) : undefined;
    if (!action) break;
    const established = passUpdate(action);
    if (Object.keys(established).length === 0 || !satisfies(currentState, established)) break;
  }
  return i;
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
export const stdinConfirm: DodConfirmer = async (dod, signal, kind) => {
  const { createInterface } = await import('node:readline/promises');
  const lines = [
    '',
    kind === 'reconfirm'
      ? '=== Definition of Done — RE-CONFIRM new actions before executing ==='
      : '=== Definition of Done — confirm before executing ===',
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

/** Default sign-off gate (R30): pretty-print the DoD, read one accept/reject line from stdin.
 *  Same abort-race shape as `stdinConfirm`, but the declined path is 'reject', not `false`. */
export const stdinAcceptanceGate: AcceptanceGate = async (dod, signal) => {
  const { createInterface } = await import('node:readline/promises');
  const lines = [
    '',
    '=== Definition of Done — ACCEPT sign-off before declaring success ===',
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
  if (signal.aborted) return 'reject';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Accept? [y/N] ', { signal });
    return /^y(es)?$/i.test(answer.trim()) ? 'accept' : 'reject';
  } catch (e) {
    if (signal.aborted) return 'reject'; // aborted mid-prompt — treat as declined, not a crash
    throw e;
  } finally {
    rl.close();
  }
};
