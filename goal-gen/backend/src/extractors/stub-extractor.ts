/**
 * Deterministic in-memory `LlmExtractor` for unit tests and the runner skeleton — no real
 * `claude -p`, no spend. `extract()` returns a fixture GoalSpec; `expand()` returns the next queued
 * batch of actions (for exercising the re-extraction ladder). Call counters are assertable so tests
 * can prove how many times the extractor was invoked.
 */
import type { Action, GoalSpec, WorldState } from '../planner/types';
import type { ExtractRequest, FailureEvidence, LlmExtractor } from '../types';

export interface StubExtractorOptions {
  /** Returned (deep-cloned) by `extract()`. */
  goalSpec: GoalSpec;
  /** FIFO of `expand()` results; each call shifts one batch. Exhausted ⇒ returns `[]`. */
  expansions?: Action[][];
  /** When set, `extract()` rejects with this (simulates a structured ExtractionError). */
  extractError?: Error;
  /** Cost (USD) reported by each `extract()` call. Default 0 (no spend). */
  extractCostUsd?: number;
  /** Cost (USD) reported by each `expand()` call — exercises the re-extraction budget guard. Default 0. */
  expandCostUsd?: number;
}

export class StubExtractor implements LlmExtractor {
  private readonly goalSpec: GoalSpec;
  private readonly expansions: Action[][];
  private readonly extractError: Error | undefined;
  private readonly extractCostUsd: number;
  private readonly expandCostUsd: number;
  extractCalls = 0;
  expandCalls = 0;

  constructor(opts: StubExtractorOptions) {
    this.goalSpec = opts.goalSpec;
    this.expansions = (opts.expansions ?? []).map((batch) => [...batch]);
    this.extractError = opts.extractError;
    this.extractCostUsd = opts.extractCostUsd ?? 0;
    this.expandCostUsd = opts.expandCostUsd ?? 0;
  }

  async extract(_req: ExtractRequest): Promise<{ goalSpec: GoalSpec; costUsd: number }> {
    this.extractCalls++;
    if (this.extractError) throw this.extractError;
    return { goalSpec: structuredClone(this.goalSpec), costUsd: this.extractCostUsd };
  }

  async expand(
    _goalText: string,
    _currentState: WorldState,
    _failureEvidence: FailureEvidence,
    _existingPool: Action[],
  ): Promise<{ actions: Action[]; costUsd: number }> {
    this.expandCalls++;
    const next = this.expansions.shift();
    return { actions: next ? structuredClone(next) : [], costUsd: this.expandCostUsd };
  }
}
