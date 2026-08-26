#!/usr/bin/env node
/**
 * Thin CLI entry for the M1 walking skeleton:
 *   `npx tsx backend/src/runner.ts [--yes] "<goal>"`          (bare-goal back-compat form)
 *   `npx tsx backend/src/runner.ts [--yes] --request <file>`  (canonical request form, RR5)
 *
 * Wires the REAL loop now (the stubs from item 1 are gone): a goal flows through the LlmExtractor
 * (`claude -p`) → deterministic `plan()` → confirm-DoD gate → the Orchestrator's serial
 * execute→verify→replan loop (real `claude` executor in per-run worktrees, shell verify) → a final
 * structured summary. `runner.ts` still carries NO business logic of its own — argv, the structured
 * JSON-lines log sink, and exit-code control flow only. It never calls `process.exit()` mid-run.
 * The request form derives goal/config/auto-confirm exclusively through `run/request-to-run.ts`
 * (RR3's single mapping path); mode fail-closed rejection (RR4) happens there before any wiring.
 *
 *   --yes, -y   auto-confirm the definition-of-done gate (non-interactive; for automation/the
 *               probe). Sign-off is deliberately NOT auto-accepted (see below).
 */
import { pathToFileURL } from 'node:url';
import { ClaudeCodeExecutor } from './executors/claude-code-executor';
import { ShellVerifier } from './executors/shell-verifier';
import { ClaudeLlmClient, LlmExtractorImpl } from './extractors/llm-extractor';
import { IntakeValidationFailure } from './intake';
import { defaultRunConfig } from './orchestrator/guardrails';
import { Orchestrator } from './orchestrator/orchestrator';
import type { DodConfirmer } from './orchestrator/orchestrator';
import { loadRunRequest, requestToRunInputs } from './run/request-to-run';
import type { RunConfig, RunSummary } from './types';

/** Structured JSON-lines log line to stdout (one self-describing event per line). */
function log(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
}

export type RunnerArgs =
  | { kind: 'usage'; message: string }
  | { kind: 'goal'; goalText: string; autoConfirm: boolean }
  | { kind: 'request'; requestPath: string; autoConfirm: boolean };

/**
 * Pure argv parsing, exported so tests cover it without constructing real executors. Only
 * leading flags are consumed; parsing stops at the first non-flag argument so a goal that
 * happens to contain '--yes' is preserved verbatim (existing behavior). `--request` and a bare
 * goal are mutually exclusive — two sources of goal text would be ambiguous.
 */
export function parseRunnerArgs(args: string[]): RunnerArgs {
  let autoConfirm = false;
  let requestPath: string | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--yes' || arg === '-y') {
      autoConfirm = true;
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
    return { kind: 'request', requestPath, autoConfirm };
  }
  if (goalText === '') {
    return { kind: 'usage', message: 'usage: npx tsx backend/src/runner.ts [--yes] "<goal>" | [--yes] --request <file>' };
  }
  return { kind: 'goal', goalText, autoConfirm };
}

/** Run the real M1 loop for one goal and return its structured summary. */
async function run(args: string[]): Promise<RunSummary> {
  const parsed = parseRunnerArgs(args);
  if (parsed.kind === 'usage') {
    log({ ev: 'error', message: parsed.message });
    return { status: 'failed', goalText: '', costUsd: 0, replans: 0, reextractions: 0, actions: [], reason: parsed.message };
  }

  let goalText: string;
  let config: RunConfig;
  let autoConfirm: boolean;
  if (parsed.kind === 'request') {
    try {
      const inputs = requestToRunInputs(await loadRunRequest(parsed.requestPath));
      goalText = inputs.goalText;
      config = inputs.runConfig;
      // CLI --yes may force auto-confirm on top of the request; it never turns it off.
      autoConfirm = parsed.autoConfirm || inputs.autoConfirm;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const errors = e instanceof IntakeValidationFailure ? e.errors : undefined;
      log({ ev: 'error', message, ...(errors !== undefined ? { errors } : {}) });
      return { status: 'failed', goalText: '', costUsd: 0, replans: 0, reextractions: 0, actions: [], reason: message };
    }
  } else {
    goalText = parsed.goalText;
    config = defaultRunConfig();
    autoConfirm = parsed.autoConfirm;
  }

  log({ ev: 'run.start', goalText, autoConfirm });
  const extractor = new LlmExtractorImpl(new ClaudeLlmClient({ model: config.model }), { onEvent: log });
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
        log({ ev: 'gate.autoConfirm', kind });
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

  const orchestrator = new Orchestrator({ extractor, executor, verifier, config, onEvent: log, confirm, signal: ac.signal });
  return orchestrator.run({ goalText }).finally(() => {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  });
}

// Auto-run only when invoked as the entry script (so tests can import without side effects).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await run(process.argv.slice(2));
  log({ ev: 'run.summary', ...summary });
  process.exitCode = summary.status === 'succeeded' ? 0 : 1;
}

export { run };
