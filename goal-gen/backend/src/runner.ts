#!/usr/bin/env node
/**
 * Thin CLI entry for the M1 walking skeleton:
 *   `npx tsx backend/src/runner.ts [--yes] "<goal>"`          (bare-goal back-compat form)
 *   `npx tsx backend/src/runner.ts [--yes] --request <file>`  (canonical request form, RR5)
 *
 * Wires the REAL loop now (the stubs from item 1 are gone): a goal flows through the LlmExtractor
 * (`claude -p`) → deterministic `plan()` → confirm-DoD gate → the Orchestrator's serial
 * execute→verify→replan loop (real `claude` executor in per-run worktrees, shell verify) → a final
 * structured summary. `runner.ts` still carries NO business logic of its own — argv, the event
 * sink, and exit-code control flow only. It never calls `process.exit()` mid-run.
 * The request form derives goal/config/auto-confirm exclusively through `run/request-to-run.ts`
 * (RR3's single mapping path); mode fail-closed rejection (RR4) happens there before any wiring.
 *
 * stdout is run-event/v1 JSON Lines (RR6): every line is a `{schemaVersion, runId, sequence,
 * timestamp, type, payload}` envelope minted by ONE per-run `RunEventEmitter` shared by the
 * extractor, the orchestrator, and this entry (RR7) — the previous ad-hoc `{t, ev, ...}` shape
 * is gone. The last line of every run, success or failure, is the `run.summary` envelope (RR10).
 * A broken stdout pipe (EPIPE) is handled at the stream level by `createStdoutSink`
 * (`events/stdout-sink.ts`, shared with the `run` verb), not by the emitter — see its doc comment.
 *
 *   --yes, -y   auto-confirm the definition-of-done gate (non-interactive; for automation/the
 *               probe). Sign-off is deliberately NOT auto-accepted (see below).
 */
import { pathToFileURL } from 'node:url';
import { RunEventEmitter } from './events/run-event-emitter';
import { createStdoutSink } from './events/stdout-sink';
import { ClaudeCodeExecutor } from './executors/claude-code-executor';
import { ShellVerifier } from './executors/shell-verifier';
import { ClaudeLlmClient, LlmExtractorImpl } from './extractors/llm-extractor';
import { IntakeValidationFailure } from './intake';
import { defaultRunConfig } from './orchestrator/guardrails';
import { Orchestrator } from './orchestrator/orchestrator';
import type { DodConfirmer } from './orchestrator/orchestrator';
import { loadRunRequest, requestToRunInputs } from './run/request-to-run';
import type { RunConfig, RunSummary } from './types';

// Both protocol entry points share one stream-level sink (see its doc comment for the EPIPE
// reason). Re-exported here because this module was its original home and tests import it here.
export { createStdoutSink } from './events/stdout-sink';

const stdoutSink = createStdoutSink();

export type RunnerArgs =
  | { kind: 'usage'; message: string }
  | { kind: 'goal'; goalText: string; autoConfirm: boolean }
  | { kind: 'request'; requestPath: string; autoConfirm: boolean; allowGuardrailOverride: boolean };

/**
 * Pure argv parsing, exported so tests cover it without constructing real executors. Only
 * leading flags are consumed; parsing stops at the first non-flag argument so a goal that
 * happens to contain '--yes' is preserved verbatim (existing behavior). `--request` and a bare
 * goal are mutually exclusive — two sources of goal text would be ambiguous.
 */
export function parseRunnerArgs(args: string[]): RunnerArgs {
  let autoConfirm = false;
  let allowGuardrailOverride = false;
  let requestPath: string | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--yes' || arg === '-y') {
      autoConfirm = true;
      i++;
      continue;
    }
    if (arg === '--allow-guardrail-override') {
      allowGuardrailOverride = true;
      i++;
      continue;
    }
    if (arg === '--request') {
      const value = args[i + 1];
      if (value === undefined || value === '') {
        return { kind: 'usage', message: '--request requires a <file> argument' };
      }
      requestPath = value;
      i += 2;
      continue;
    }
    break;
  }
  const goalText = args.slice(i).join(' ').trim();
  if (requestPath !== undefined) {
    if (goalText !== '') {
      return { kind: 'usage', message: '--request and a bare goal are mutually exclusive' };
    }
    return { kind: 'request', requestPath, autoConfirm, allowGuardrailOverride };
  }
  if (allowGuardrailOverride) {
    // Bare-goal runs use the defaults; there are no request guardrails to consent to (RR18).
    return { kind: 'usage', message: '--allow-guardrail-override is only valid with --request' };
  }
  if (goalText === '') {
    return { kind: 'usage', message: 'usage: npx tsx backend/src/runner.ts [--yes] "<goal>" | [--yes] --request <file>' };
  }
  return { kind: 'goal', goalText, autoConfirm };
}

/** Run the real M1 loop for one goal and return its structured summary. Every path — including
 *  the early usage/request failures below, which never reach the orchestrator — ends the stream
 *  with a `run.summary` envelope (RR10); orchestrator paths emit it from `summary()` itself. */
async function run(args: string[], emitter: RunEventEmitter = new RunEventEmitter({ sink: stdoutSink })): Promise<RunSummary> {
  const failedSummary = (reason: string): RunSummary => {
    const summary: RunSummary = { status: 'failed', goalText: '', costUsd: 0, replans: 0, reextractions: 0, actions: [], reason };
    emitter.handle({ ev: 'run.summary', ...summary });
    return summary;
  };

  const parsed = parseRunnerArgs(args);
  if (parsed.kind === 'usage') {
    emitter.handle({ ev: 'error', message: parsed.message });
    return failedSummary(parsed.message);
  }

  let goalText: string;
  let config: RunConfig;
  let autoConfirm: boolean;
  let requestAskedAutoConfirm = false;
  if (parsed.kind === 'request') {
    try {
      const inputs = requestToRunInputs(await loadRunRequest(parsed.requestPath), {
        allowGuardrailOverride: parsed.allowGuardrailOverride,
      });
      goalText = inputs.goalText;
      config = inputs.runConfig;
      // RR19: the runner is ALWAYS the real executor, so a request file alone cannot skip the
      // DoD gate — only the invoking operator's CLI --yes can. The ignored ask is surfaced
      // in-stream below, never silently dropped.
      autoConfirm = parsed.autoConfirm;
      requestAskedAutoConfirm = inputs.autoConfirm;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const errors = e instanceof IntakeValidationFailure ? e.errors : undefined;
      emitter.handle({ ev: 'error', message, ...(errors !== undefined ? { errors } : {}) });
      return failedSummary(message);
    }
  } else {
    goalText = parsed.goalText;
    config = defaultRunConfig();
    autoConfirm = parsed.autoConfirm;
  }

  // Audit envelope (RR18/RR19): effective spend configuration first, always.
  emitter.handle({ ev: 'run.start', goalText, autoConfirm, runConfig: config });
  if (requestAskedAutoConfirm && !autoConfirm) {
    emitter.handle({
      ev: 'gate.requestAutoConfirmIgnored',
      reason: "request asked for autoConfirmDod, but the runner is a real executor — only the operator's CLI --yes can skip the DoD gate (RR19)",
    });
  }
  const extractor = new LlmExtractorImpl(new ClaudeLlmClient({ model: config.model }), { onEvent: emitter.handle });
  const executor = new ClaudeCodeExecutor({
    model: config.model,
    timeoutMs: config.actionTimeoutMs,
    noiseFilterPaths: config.noiseFilterPaths,
    // Explicit host opt-in (never a fallback): the M1 walking skeleton runs against a throwaway
    // scratch repo in tmpdir (ADR-0009 blast-radius posture). Unknown/absent modes now fail closed
    // inside the executor; this line is the single place bypass is deliberately chosen.
    permissionMode: 'bypassPermissions',
  });
  const verifier = new ShellVerifier();
  const confirm: DodConfirmer | undefined = autoConfirm
    ? async (_dod, _signal, kind) => {
        emitter.handle({ ev: 'gate.autoConfirm', kind });
        return true;
      }
    : undefined;
  // Sign-off gate deliberately NOT auto-accepted by --yes: DoD confirmation is about trusting the
  // plan, sign-off is about verifying results. Keep them separate so --yes enables automation
  // without silently bypassing the acceptance control (CodeAnt AI review: Critical severity).

  const ac = new AbortController();
  const abort = () => ac.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  // `events` supersedes onEvent; the run's id defaults to emitter.runId so stream and summary agree.
  const orchestrator = new Orchestrator({ extractor, executor, verifier, config, events: emitter, confirm, signal: ac.signal });
  return orchestrator.run({ goalText }).finally(() => {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  });
}

// Auto-run only when invoked as the entry script (so tests can import without side effects).
// `run()` guarantees the terminal `run.summary` envelope on every path — nothing to emit here.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await run(process.argv.slice(2));
  process.exitCode = summary.status === 'succeeded' ? 0 : 1;
}

export { run };
