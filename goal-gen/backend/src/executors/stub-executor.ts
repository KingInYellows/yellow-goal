/**
 * Deterministic in-memory execution-side test doubles for unit tests and the runner skeleton — no
 * real `claude -p`, no shell, no spend.
 *
 *  - `StubExecutor` returns scriptable `AgentRun`s (status / cost / diffRef per action).
 *  - `StubVerifier` returns scriptable `VerifyResult`s (exit code per verify command) — the
 *    orchestrator's pass/fail gate, kept separate from the executor exactly as in production.
 *
 * Both expose an observable call log so tests can assert how many times (and in what order) each
 * was invoked — e.g. that a verify-fail triggered a retry, or that the budget tripped before
 * dispatch. Outcomes are consumed FIFO per key, falling back to a configurable default.
 */
import type { Action, ExecutorKind } from '../planner/types';
import type {
  AgentRun,
  AgentRunStatus,
  Executor,
  RunContext,
  Verifier,
  VerifyResult,
} from '../types';

export interface StubAgentOutcome {
  /** Default `'succeeded'`. */
  status?: AgentRunStatus;
  /** Default `0`. */
  exitCode?: number;
  /** Default `0`. */
  costUsd?: number;
  /** Default `'stub-changed'`; pass `null` to simulate the activity oracle finding no change. */
  diffRef?: string | null;
  stdout?: string;
  stderr?: string;
  tokens?: number;
}

export interface StubExecutorOptions {
  /** Outcome used when a per-action queue is absent or exhausted. */
  default?: StubAgentOutcome;
  /** Per-action FIFO of outcomes; one consumed per `run()` for that actionId, else `default`. */
  byAction?: Record<string, StubAgentOutcome[]>;
}

export class StubExecutor implements Executor {
  readonly kind: ExecutorKind = 'claude-code';
  private readonly def: StubAgentOutcome;
  private readonly byAction: Map<string, StubAgentOutcome[]>;
  private seq = 0;
  /** Observable call log (assertable in tests). */
  readonly runs: Array<{ actionId: string; runId: string }> = [];

  constructor(opts: StubExecutorOptions = {}) {
    this.def = opts.default ?? {};
    this.byAction = new Map(
      Object.entries(opts.byAction ?? {}).map(([id, list]) => [id, [...list]]),
    );
  }

  async run(action: Action, ctx: RunContext): Promise<AgentRun> {
    this.runs.push({ actionId: action.id, runId: ctx.runId });
    const queue = this.byAction.get(action.id);
    const o: StubAgentOutcome = queue && queue.length > 0 ? queue.shift()! : this.def;
    const now = new Date().toISOString();
    const run: AgentRun = {
      id: `${ctx.runId}:${action.id}:${++this.seq}`,
      planId: '', // stamped by the orchestrator
      stepId: '', // stamped by the orchestrator
      actionId: action.id,
      executor: this.kind,
      startedAt: now,
      endedAt: now,
      status: o.status ?? 'succeeded',
      exitCode: o.exitCode ?? 0,
      costUsd: o.costUsd ?? 0,
    };
    // `null` ⇒ no change detected (diffRef stays unset); otherwise default to a sentinel.
    const diffRef = o.diffRef === null ? undefined : (o.diffRef ?? 'stub-changed');
    if (diffRef !== undefined) run.diffRef = diffRef;
    if (o.stdout !== undefined) run.stdout = o.stdout;
    if (o.stderr !== undefined) run.stderr = o.stderr;
    if (o.tokens !== undefined) run.tokens = o.tokens;
    return run;
  }
}

export interface StubVerifierOptions {
  /** Outcome used when a per-command queue is absent or exhausted. Default: exit 0 (pass). */
  default?: VerifyResult;
  /** Per-command FIFO of outcomes; one consumed per `run()` for that command, else `default`. */
  byCommand?: Record<string, VerifyResult[]>;
}

export class StubVerifier implements Verifier {
  private readonly def: VerifyResult;
  private readonly byCommand: Map<string, VerifyResult[]>;
  /** Observable call log (assertable in tests). */
  readonly calls: Array<{ command: string; runId: string }> = [];

  constructor(opts: StubVerifierOptions = {}) {
    this.def = opts.default ?? { exitCode: 0, stdout: '', stderr: '' };
    this.byCommand = new Map(
      Object.entries(opts.byCommand ?? {}).map(([cmd, list]) => [cmd, [...list]]),
    );
  }

  async run(command: string, ctx: RunContext): Promise<VerifyResult> {
    this.calls.push({ command, runId: ctx.runId });
    const queue = this.byCommand.get(command);
    return queue && queue.length > 0 ? queue.shift()! : this.def;
  }
}
