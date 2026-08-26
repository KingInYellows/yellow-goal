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
import { ClaudeCodeExecutor } from '../executors/claude-code-executor';
import { ShellVerifier } from '../executors/shell-verifier';
import { StubExecutor, StubVerifier } from '../executors/stub-executor';
import { ClaudeLlmClient, LlmExtractorImpl } from '../extractors/llm-extractor';
import { StubExtractor } from '../extractors/stub-extractor';
import { Orchestrator } from '../orchestrator/orchestrator';
import type { DodConfirmer, OrchestratorDeps, WorktreeProvider } from '../orchestrator/orchestrator';
import type { GoalSpec } from '../planner/types';
import { loadRunRequest, requestToRunInputs, type RunInputs } from '../run/request-to-run';
import type { RunConfig } from '../types';
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

export async function runRunCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      executor: { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
      // Accepted for cross-verb consistency; `run` output is ALWAYS machine-readable JSON Lines.
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const requestPath = positionals[0];
  if (!requestPath) throw new CliUsageError('run requires a <request-file> positional argument');
  const executorKind = values.executor;
  if (executorKind !== 'claude-code' && executorKind !== 'stub') {
    throw new CliUsageError(
      `run requires --executor claude-code|stub (got ${executorKind ?? '(none)'}) — real spend is never a default`,
    );
  }

  // Throws IntakeValidationFailure (VALIDATION_FAILED, exit 1) on a malformed request or a
  // non-executable mode (RR4) — before any engine construction.
  const inputs: RunInputs = requestToRunInputs(await loadRunRequest(requestPath));
  const autoConfirm = values.yes === true || inputs.autoConfirm;

  const emitter = new RunEventEmitter({
    sink: (envelope) => process.stdout.write(`${JSON.stringify(envelope)}\n`),
  });
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

  const engine = executorKind === 'stub' ? stubEngine(inputs.goalText) : claudeCodeEngine(inputs.runConfig, emitter.handle);
  const orchestrator = new Orchestrator({
    ...engine,
    config: inputs.runConfig,
    events: emitter,
    confirm,
    signal: ac.signal,
    // No persistence wiring (RR15) — parity with the M1 runner; DB-backed runs are a later milestone.
  });

  try {
    const summary = await orchestrator.run({ goalText: inputs.goalText });
    return summary.status === 'succeeded' ? 0 : 1;
  } catch (e) {
    // Orchestrator.run() documents never-throws, but RR12's "the last stdout line is the
    // run.summary envelope" must hold even if that contract is ever violated (e.g. a default
    // gate rethrowing on a dead stdin). Terminate the stream, then let main()'s catch-all
    // produce the stderr envelope and exit code.
    emitter.next('run.summary', {
      status: 'failed',
      goalText: inputs.goalText,
      reason: `run aborted by unexpected error: ${e instanceof Error ? e.message : String(e)}`,
    });
    throw e;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
