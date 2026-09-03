/**
 * `run` verb (RR11–RR16, plans/specs/request-to-run-pipeline.md) — the M1 execution loop behind
 * the SAME process contract as every compiler verb: canonical request file in, run-event/v1
 * JSON Lines on stdout (terminal `run.summary` envelope last, RR12), single-line structured
 * stderr envelope on failure, exit 2 = usage / 1 = failure / 0 = run succeeded.
 *
 * This module is the M1 subsystem's entry, NOT compiler mode: the dispatcher imports it
 * DYNAMICALLY at invocation, so the compiler verbs (`request`/`inspect`/`analyze`/`compile`/
 * `packet`) never load executor/orchestrator mutation code into their process
 * (packet-compiler.md isolation rule).
 *
 * `--executor claude-code|stub` is REQUIRED (RR13): real spend is only ever an explicit choice,
 * and `stub` is a deterministic zero-spend engine (stubbed extractor/executor/verifier, in-memory
 * worktree) that exercises the full request→events→summary protocol for consumers and tests.
 * Note: like the M1 runner, execution happens in fresh scratch worktrees (ADR-0009) — the
 * request's `target.repository` does not (yet) select the execution target.
 */
import { parseArgs } from 'node:util';
import { RunEventEmitter } from '../events/run-event-emitter';
import { createStdoutSink, transportFailureEnvelope } from '../events/stdout-sink';
import { ClaudeCodeExecutor } from '../executors/claude-code-executor';
import { ShellVerifier } from '../executors/shell-verifier';
import { StubExecutor, StubVerifier } from '../executors/stub-executor';
import { ClaudeLlmClient, LlmExtractorImpl } from '../extractors/llm-extractor';
import { StubExtractor } from '../extractors/stub-extractor';
import { Orchestrator } from '../orchestrator/orchestrator';
import type { DodConfirmer, OrchestratorDeps, WorktreeProvider } from '../orchestrator/orchestrator';
import { RUN_WALL_CLOCK_MS } from '../orchestrator/guardrails';
import type { GoalSpec } from '../planner/types';
import { loadRunRequest, requestToRunInputs, type RunInputs } from '../run/request-to-run';
import type { RunConfig, RunSummary } from '../types';
import { CliUsageError } from './errors';

type EngineDeps = Pick<OrchestratorDeps, 'extractor' | 'executor' | 'verifier' | 'worktreeProvider'>;

/** In-memory worktree double for the stub engine — no filesystem, no git. */
const stubWorktreeProvider: WorktreeProvider = async (opts) => ({
  root: '(stub)',
  worktreePath: '(stub)',
  branch: opts.branch ?? 'run',
  initialSha: '0'.repeat(40),
  cleanup: async () => {},
});

/** Deterministic zero-spend engine (RR13/RR16): one canned action whose verify passes, so a
 *  consumer sees the complete protocol — extract.done, gates, step.pass, run.summary — with
 *  nothing spawned and nothing spent. */
function stubEngine(goalText: string): EngineDeps {
  const goalSpec: GoalSpec = {
    goalText,
    initialState: { done: false },
    goalState: { done: true },
    constraints: [],
    completionPolicy: 'verify-only',
    actions: [
      {
        id: 'stub-action',
        name: 'stub-action',
        cost: 1,
        preconditions: { done: false },
        effects: { done: true },
        executor: 'claude-code',
        payload: {},
        verify: { command: 'stub-verify' },
      },
    ],
  };
  return {
    extractor: new StubExtractor({ goalSpec }),
    executor: new StubExecutor({ default: { status: 'succeeded', costUsd: 0 } }),
    verifier: new StubVerifier(),
    worktreeProvider: stubWorktreeProvider,
  };
}

/** The real M1 engine — identical wiring (and identical ADR-0009 scratch-worktree posture,
 *  including the executor's single deliberate bypass opt-in) to backend/src/runner.ts. */
function claudeCodeEngine(config: RunConfig, onEvent: (event: Record<string, unknown>) => void): EngineDeps {
  return {
    extractor: new LlmExtractorImpl(new ClaudeLlmClient({ model: config.model }), { onEvent }),
    executor: new ClaudeCodeExecutor({
      model: config.model,
      timeoutMs: config.actionTimeoutMs,
      noiseFilterPaths: config.noiseFilterPaths,
      // Explicit host opt-in (never a fallback): runs happen in throwaway scratch repos in
      // tmpdir (ADR-0009 blast-radius posture) — same single deliberate choice as runner.ts.
      permissionMode: 'bypassPermissions',
    }),
    verifier: new ShellVerifier(),
    // worktreeProvider omitted → orchestrator default (real createWorktree).
  };
}

/** The ONE place an engine is constructed. Exported as an injectable seam so tests can PROVE (not
 *  merely observe via missing stdout) that nothing is built before a request has passed every
 *  fail-closed gate — RR4 mode, RR18 guardrail consent, RR21 write permission, usage errors:
 *  `runRunCommand` accepts an override and run-verb.test.ts asserts the factory is never invoked
 *  for an invalid request. Production always resolves to this default. */
export type EngineFactory = (
  kind: 'claude-code' | 'stub',
  inputs: RunInputs,
  onEvent: (event: Record<string, unknown>) => void,
) => EngineDeps;

export const defaultEngineFactory: EngineFactory = (kind, inputs, onEvent) =>
  kind === 'stub' ? stubEngine(inputs.goalText) : claudeCodeEngine(inputs.runConfig, onEvent);

/** RR19 as a pure decision, exported for tests (the claude-code branch cannot be exercised
 *  end-to-end without real spend): a request file's autoConfirmDod counts only for the
 *  zero-spend stub; a real executor requires the operator's CLI --yes. */
export function effectiveAutoConfirm(executorKind: 'claude-code' | 'stub', cliYes: boolean, requestAsk: boolean): boolean {
  return executorKind === 'stub' ? cliYes || requestAsk : cliYes;
}

/** RR11's stderr envelope code per non-succeeded terminal status, so a consumer can tell
 *  failed/cancelled/budget-exhausted apart without parsing `reason` text. */
const RUN_FAILURE_CODES: Record<Exclude<RunSummary['status'], 'succeeded'>, string> = {
  failed: 'RUN_FAILED',
  cancelled: 'RUN_CANCELLED',
  'budget-exhausted': 'RUN_BUDGET_EXHAUSTED',
  'awaiting-acceptance': 'RUN_AWAITING_ACCEPTANCE', // defensive: run() never resolves in this status
};

/** Pure status → stderr-envelope mapping, exported for direct unit testing: the stub engine
 *  always succeeds (RR16), so a terminal non-success `run.summary` isn't reachable end-to-end
 *  through the CLI without a test-only production seam, which we deliberately don't add. Returns
 *  `undefined` for 'succeeded' — the success path's stderr must stay empty. */
export function runFailureEnvelope(summary: Pick<RunSummary, 'status' | 'reason'>): { error: { code: string; message: string } } | undefined {
  if (summary.status === 'succeeded') return undefined;
  return { error: { code: RUN_FAILURE_CODES[summary.status], message: summary.reason } };
}

export interface RunCommandOptions {
  /** Test seam only — see `defaultEngineFactory`. */
  engineFactory?: EngineFactory;
}

export async function runRunCommand(argv: string[], options: RunCommandOptions = {}): Promise<number> {
  // Node's parseArgs throws (rather than returning) on malformed syntax (e.g. `--executor` with
  // no value, or an unknown flag) — translate that LOCALLY into a CliUsageError (exit 2) instead
  // of letting it fall through to main()'s UNEXPECTED_ERROR/exit-1 catch-all. A dispatcher-wide
  // `ERR_PARSE_ARGS_*` translation may also land in cli/index.ts on another branch; this local
  // wrap is self-contained so the two fixes can't conflict at merge time.
  const { values, positionals } = (() => {
    try {
      return parseArgs({
        args: argv,
        options: {
          executor: { type: 'string' },
          yes: { type: 'boolean', short: 'y', default: false },
          // RR18: a request file may not raise guardrail caps above the ADR-0010 defaults on its
          // own — this flag is the operator's explicit consent to honor raised caps.
          'allow-guardrail-override': { type: 'boolean', default: false },
          // Accepted for cross-verb consistency; `run` output is ALWAYS machine-readable JSON Lines.
          json: { type: 'boolean', default: false },
        },
        allowPositionals: true,
      });
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? String((e as { code?: unknown }).code) : '';
      if (code.startsWith('ERR_PARSE_ARGS_')) throw new CliUsageError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  })();

  if (positionals.length > 1) {
    throw new CliUsageError('run accepts exactly one <request-file> positional argument');
  }
  const requestPath = positionals[0];
  if (!requestPath) throw new CliUsageError('run requires a <request-file> positional argument');
  const executorKind = values.executor;
  if (executorKind !== 'claude-code' && executorKind !== 'stub') {
    throw new CliUsageError(
      `run requires --executor claude-code|stub (got ${executorKind ?? '(none)'}) — real spend is never a default`,
    );
  }

  // Throws IntakeValidationFailure (VALIDATION_FAILED, exit 1) on a malformed request, a
  // non-executable mode (RR4), or unconsented raised guardrails (RR18) — before any engine
  // construction.
  const allowGuardrailOverride = values['allow-guardrail-override'] === true;
  const request = await loadRunRequest(requestPath);
  const inputs: RunInputs = requestToRunInputs(request, { allowGuardrailOverride });
  // RR19: with the real executor, the DoD gate is where the operator sees every verify command
  // before real spend — a request FILE alone must not skip it; only the invoking operator's
  // CLI --yes may. The zero-spend stub honors the request's autoConfirmDod as before.
  const autoConfirm = effectiveAutoConfirm(executorKind, values.yes === true, inputs.autoConfirm);

  // Best-effort running spend total, tallied from every emitted envelope that carries a numeric
  // `costUsd` (e.g. `agent.run`, `extract.failed`) — the only source of incurred spend available
  // outside Orchestrator's private RunState. Feeds the defensive fallback summary below if
  // Orchestrator.run() ever throws before returning its own authoritative summary. Known gap: a
  // SUCCESSFUL extraction's cost is folded into RunState directly and never emitted as an event,
  // so it is not reflected here (see run-verb.test.ts note).
  let observedCostUsd = 0;
  // Share the runner's stream-level sink: a broken stdout pipe surfaces asynchronously as the
  // stream's 'error' event, which the emitter's synchronous catch cannot see and which would
  // otherwise kill the process before the terminal run.summary. createStdoutSink degrades
  // quietly after a stream error instead.
  const writeEnvelope = createStdoutSink();
  const emitter = new RunEventEmitter({
    sink: (envelope) => {
      const cost = (envelope.payload as Record<string, unknown> | undefined)?.costUsd;
      if (typeof cost === 'number') observedCostUsd += cost;
      writeEnvelope(envelope);
    },
  });
  // Audit envelope (RR18/RR19): the EFFECTIVE spend configuration is always the stream's first
  // event, and the target-repository limitation is disclosed in-band, not just in the spec.
  emitter.next('run.start', {
    goalText: inputs.goalText,
    executor: executorKind,
    autoConfirm,
    allowGuardrailOverride,
    runConfig: inputs.runConfig,
    targetRepository: request.target.repository,
    // Execution happens in fresh scratch worktrees (ADR-0009); the request's target does not
    // select the execution target yet — see spec "Out of scope".
    targetRepositoryHonored: false,
  });
  if (inputs.autoConfirm && !autoConfirm) {
    emitter.next('gate.requestAutoConfirmIgnored', {
      reason: "request asked for autoConfirmDod, but with --executor claude-code only the operator's CLI --yes can skip the DoD gate (RR19)",
    });
  }
  // DoD/reconfirm gates only — sign-off is never auto-accepted (RR14). Without auto-confirm the
  // orchestrator's stdin gates apply, exactly like the runner.
  const confirm: DodConfirmer | undefined = autoConfirm
    ? async (_dod, _signal, kind) => {
        emitter.handle({ ev: 'gate.autoConfirm', kind });
        return true;
      }
    : undefined;

  const ac = new AbortController();
  const abort = () => ac.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  // CLAUDE.md invariant #6 / ADR-0010: the mandatory run-wide wall-clock. The orchestrator carries
  // the abort mechanism but doesn't enforce a deadline itself (guardrails.ts) — this entry point
  // owns the AbortController, so it owns starting the timer too. On trip, `ac.abort()` makes the
  // orchestrator's existing signal.aborted checks return their normal 'cancelled' terminal summary.
  const deadline = setTimeout(abort, RUN_WALL_CLOCK_MS);

  try {
    // Construction happens INSIDE the try so a throwing factory/constructor still reaches the
    // finally (timer + signal listeners released) and the catch (terminal envelope) below.
    const engine = (options.engineFactory ?? defaultEngineFactory)(executorKind, inputs, emitter.handle);
    const orchestrator = new Orchestrator({
      ...engine,
      config: inputs.runConfig,
      events: emitter,
      confirm,
      signal: ac.signal,
      // No persistence wiring (RR15) — parity with the M1 runner; DB-backed runs are a later milestone.
    });
    const summary = await orchestrator.run({ goalText: inputs.goalText });
    // RR11: every verb's failures share the same single-line stderr envelope. orchestrator.run()
    // RESOLVES (doesn't throw) on ordinary terminal non-success — retries exhausted, cancelled,
    // budget-exhausted — so that shared contract has to be produced here explicitly; stdout's
    // terminal run.summary envelope is untouched either way, and the success path writes nothing
    // to stderr.
    // A non-EPIPE stdout error means the consumer did not receive the whole stream (possibly not
    // even run.summary): that outranks every other classification — a consumer told RUN_FAILED
    // for a truncated stream would still trust the events it did see. Stream errors are
    // asynchronous, so wait for the writes to be acknowledged before deciding anything.
    await writeEnvelope.flush();
    if (writeEnvelope.transportError) {
      process.stderr.write(`${JSON.stringify(transportFailureEnvelope(writeEnvelope.transportError))}\n`);
      return 1;
    }
    const failure = runFailureEnvelope(summary);
    if (failure) {
      process.stderr.write(`${JSON.stringify(failure)}\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    // Orchestrator.run() documents never-throws, but RR12's "the last stdout line is the
    // run.summary envelope" must hold even if that contract is ever violated (or the engine
    // factory / Orchestrator constructor throws). Terminate the stream with a COMPLETE RunSummary
    // shape (costUsd is the sink-observed running total from `emitter`'s cost tally above — see
    // its known gap re: successful-extraction spend), then report the SAME classification on
    // stderr — RUN_FAILED, exit 1 — so stdout and stderr never disagree about how the run ended.
    const reason = `run aborted by unexpected error: ${e instanceof Error ? e.message : String(e)}`;
    emitter.next('run.summary', {
      status: 'failed',
      goalText: inputs.goalText,
      costUsd: observedCostUsd,
      replans: 0,
      reextractions: 0,
      actions: [],
      reason,
    });
    process.stderr.write(`${JSON.stringify(runFailureEnvelope({ status: 'failed', reason }))}\n`);
    return 1;
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    // Drain before detaching the error listener: a late write failure must land on the sink, not
    // become an unhandled 'error' event after the listener is gone.
    await writeEnvelope.flush();
    writeEnvelope.dispose();
  }
}
