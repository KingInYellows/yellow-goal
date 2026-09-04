/**
 * Shared execution-side contracts for the M1 walking-skeleton CLI loop.
 *
 * The planner owns the canonical *data* model (GoalSpec/Action/WorldState/Plan, see
 * `planner/types.ts`). This module adds the *execution* interfaces the specs define — Executor +
 * AgentRun (`.claude/specs/executor-router.md`), LlmExtractor + ExtractRequest
 * (`.claude/specs/goal-extractor.md`), the verify seam, and the orchestrator's failure-evidence +
 * guardrail-config shapes (`.claude/specs/orchestrator.md` + the plan's "Key types").
 *
 * Executors and the extractor are interchangeable behind these interfaces (CLAUDE.md invariant #4),
 * so the later HTTP/API layer wraps the same contracts without a rewrite. Type-only file: no runtime
 * values, so every import is `import type` (verbatimModuleSyntax).
 */
import type { Action, ExecutorKind, GoalSpec, WorldState } from './planner/types';

// ─── Executor (.claude/specs/executor-router.md) ──────────────────────────────────────────────

/** Per-run context handed to an executor: where to work, how to cancel, how much budget remains. */
export interface RunContext {
  runId: string;
  /** Isolated git worktree the agent runs in — collision-avoidance, NOT a sandbox (ADR-0009). */
  worktreePath: string;
  /** Abort signal; the executor propagates SIGTERM→SIGKILL on abort. */
  signal: AbortSignal;
  /** USD budget still available this run (the orchestrator decrements as actions spend). */
  budgetUsdRemaining: number;
}

export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * The real, captured result of one executor invocation — the ground-truth the LLM lacks
 * (CLAUDE.md invariant #2). `diffRef` is set by the activity oracle when the worktree changed; it
 * is explicitly NOT a pass/fail signal (that is the verify oracle's job alone).
 *
 * `planId` and `stepId` are orchestration concerns the executor cannot know (RunContext carries
 * neither); the executor emits `''` for `planId` and the orchestrator stamps the real plan id and
 * the deterministic `stepId` (`db/repository.ts`'s `stepId()`, `planId` + the dispatched step's
 * sequence index — R2) when it records the run.
 */
export interface AgentRun {
  id: string;
  planId: string;
  stepId: string;
  actionId: string;
  executor: ExecutorKind;
  startedAt: string;
  endedAt?: string;
  status: AgentRunStatus;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  diffRef?: string;
  /** Full patch text captured before worktree teardown (R6) — distinct from `diffRef`, which is
   *  only a pointer (`commit:<sha>` / `dirty:<count>`). `undefined` when nothing changed or the
   *  capture itself failed (fail-open — mirrors the activity oracle's `diffRef` contract). */
  diffContent?: string;
  tokens?: number;
  costUsd?: number;
}

/** One uniform interface over every coding-agent backend (v1: `claude-code` only). */
export interface Executor {
  kind: ExecutorKind;
  run(action: Action, ctx: RunContext): Promise<AgentRun>;
}

// ─── Verify seam (orchestrator-side ground-truth gate) ────────────────────────────────────────

export interface VerifyResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs an action's `verify.command` in the run's worktree. The exit code is the ONLY thing that
 * gates pass/fail and the replan trigger (plan §"Two distinct oracles"). Separate from the
 * executor so the orchestrator can stub it deterministically in unit tests.
 */
export interface Verifier {
  run(command: string, ctx: RunContext): Promise<VerifyResult>;
}

// ─── Extractor (.claude/specs/goal-extractor.md) ──────────────────────────────────────────────

export interface ExtractRequest {
  goalText: string;
  config?: {
    depth?: 'surface' | 'moderate' | 'deep';
    constraints?: string[];
    preferredExecutor?: ExecutorKind;
    repoPath?: string;
  };
}

/**
 * LLM → GoalSpec authoring. `extract` turns plain English into a schema-valid GoalSpec; `expand`
 * authors *additional* actions (append-only) grounded in real failure evidence when re-planning
 * over the existing pool yields no plan. The LLM only authors here — everything downstream is
 * deterministic (CLAUDE.md invariant #1).
 *
 * Both methods return their LLM spend alongside the authored data so the orchestrator can fold
 * extractor cost into `accumulatedCostUsd` and the run summary's `costUsd` (includes repair rounds).
 */
export interface LlmExtractor {
  /** `signal` propagates run cancellation (SIGINT/SIGTERM) into the underlying `claude -p` child. */
  extract(req: ExtractRequest, signal?: AbortSignal): Promise<{ goalSpec: GoalSpec; costUsd: number }>;
  expand(
    goalText: string,
    currentState: WorldState,
    failureEvidence: FailureEvidence,
    existingPool: Action[],
    signal?: AbortSignal,
  ): Promise<{ actions: Action[]; costUsd: number }>;
}

// ─── Failure evidence + guardrails (orchestrator.md, plan "Key types") ────────────────────────

/** Real failure signal fed to `expand()` so re-extraction adds the *right* action. */
export interface FailureEvidence {
  actionId: string;
  verifyCommand?: string;
  verifyExitCode?: number;
  verifyStdout?: string;
  verifyStderr?: string;
  agentStderr?: string;
  diffRef?: string;
}

/** Per-action failure history retained for loop-detection (additive later, not a rewrite). */
export interface FailureRecord {
  actionId: string;
  verifyExitCode: number;
  verifyStderr: string;
  at: string;
}

/**
 * Mandatory guardrails (CLAUDE.md invariant #6); v1 defaults live in `orchestrator/guardrails.ts`.
 * The 60-min wall-clock and full loop-detection are deferred — but `actionTimeoutMs` and
 * `maxSameSubgoalFailures` are carried now so adding them later is additive.
 */
export interface RunConfig {
  maxBudgetUsd: number;
  maxReplans: number;
  maxReextractions: number;
  maxRetriesPerAction: number;
  maxSameSubgoalFailures: number;
  actionTimeoutMs: number;
  /** Claude model alias passed to the executor (`--model`). */
  model: string;
  /** Activity-oracle noise filter: worktree paths to ignore when deciding "agent changed something". */
  noiseFilterPaths: string[];
}

// ─── Run outcome ──────────────────────────────────────────────────────────────────────────────

/** Run states (orchestrator.md). `awaiting-acceptance` is a non-terminal, in-flight state parked
 *  on the sign-off gate (R29); the rest are terminal. */
export type RunStatus = 'succeeded' | 'failed' | 'cancelled' | 'budget-exhausted' | 'awaiting-acceptance';
export type RunTerminationReason = 'signal' | 'timeout' | 'gate-required';

export interface ActionOutcome {
  actionId: string;
  status: 'succeeded' | 'failed';
  attempts: number;
  costUsd: number;
}

/** Final structured summary emitted at the end of a run. */
export interface RunSummary {
  status: RunStatus;
  goalText: string;
  costUsd: number;
  replans: number;
  reextractions: number;
  actions: ActionOutcome[];
  /** Human-readable reason for the terminal status. */
  reason: string;
  /** Protocol v1's first cancellation cause; omitted for legacy and non-cancelled runs. */
  terminationReason?: RunTerminationReason;
}
