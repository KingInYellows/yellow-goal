/**
 * Guardrail caps as named constants (CLAUDE.md invariant #6, ADR-0010 defaults). There are no magic
 * numbers in the orchestrator loop — every cap routes through here and each has a corresponding
 * terminal state. Deferred for v1 (carry the mechanism, enforce later): the 60-min wall-clock and
 * full loop-detection; `maxSameSubgoalFailures` already seeds the loop-detection trigger.
 */
import type { RunConfig } from '../types';

/** $/run budget cap. Expect a ~$0.05–0.10 per-action floor from context loading (spike §4). */
export const MAX_BUDGET_USD = 20;
export const MAX_REPLANS = 5;
export const MAX_REEXTRACTIONS = 2;
export const MAX_RETRIES_PER_ACTION = 3;
/** Same subgoal failing the same way this many times → escalate to re-extraction (loop trigger). */
export const MAX_SAME_SUBGOAL_FAILURES = 2;
/** Per-action timeout (10 min). Separate from the deferred 60-min wall-clock guardrail. */
export const ACTION_TIMEOUT_MS = 600_000;

/** Default executor model alias — `haiku` keeps the per-action context floor (~$0.08) low (spike §4). */
export const DEFAULT_MODEL = 'haiku';

/**
 * Worktree paths the activity oracle ignores: agent-environment side-effects (hooks/plugins/MCP),
 * not the agent's intended output (spike §7 documented `ruvector.db` + `.claude/` false-positives).
 */
export const DEFAULT_NOISE_FILTER_PATHS: readonly string[] = ['ruvector.db', '.claude'];

/** The v1 default RunConfig; every field is overridable per run. */
export function defaultRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    maxBudgetUsd: MAX_BUDGET_USD,
    maxReplans: MAX_REPLANS,
    maxReextractions: MAX_REEXTRACTIONS,
    maxRetriesPerAction: MAX_RETRIES_PER_ACTION,
    maxSameSubgoalFailures: MAX_SAME_SUBGOAL_FAILURES,
    actionTimeoutMs: ACTION_TIMEOUT_MS,
    model: DEFAULT_MODEL,
    noiseFilterPaths: [...DEFAULT_NOISE_FILTER_PATHS],
    ...overrides,
  };
}
