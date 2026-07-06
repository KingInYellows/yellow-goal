#!/usr/bin/env node
/**
 * Thin CLI entry for the M1 walking skeleton: `npx tsx backend/src/runner.ts [--yes] "<goal>"`.
 *
 * Wires the REAL loop now (the stubs from item 1 are gone): a goal flows through the LlmExtractor
 * (`claude -p`) → deterministic `plan()` → confirm-DoD gate → the Orchestrator's serial
 * execute→verify→replan loop (real `claude` executor in per-run worktrees, shell verify) → a final
 * structured summary. `runner.ts` still carries NO business logic of its own — argv, the structured
 * JSON-lines log sink, and exit-code control flow only. It never calls `process.exit()` mid-run.
 *
 *   --yes, -y   auto-confirm the definition-of-done gate (non-interactive; for automation/the probe).
 */
import { pathToFileURL } from 'node:url';
import { ClaudeCodeExecutor } from './executors/claude-code-executor';
import { ShellVerifier } from './executors/shell-verifier';
import { ClaudeLlmClient, LlmExtractorImpl } from './extractors/llm-extractor';
import { defaultRunConfig } from './orchestrator/guardrails';
import { Orchestrator } from './orchestrator/orchestrator';
import type { AcceptanceGate, DodConfirmer } from './orchestrator/orchestrator';
import type { RunSummary } from './types';

/** Structured JSON-lines log line to stdout (one self-describing event per line). */
function log(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
}

/** Run the real M1 loop for one goal and return its structured summary. */
async function run(args: string[]): Promise<RunSummary> {
  // Only consume leading '--yes'/'-y' flags; stop flag parsing at the first non-flag argument so a
  // goal that happens to contain those literals is preserved verbatim.
  let flagCount = 0;
  while (flagCount < args.length && (args[flagCount] === '--yes' || args[flagCount] === '-y')) {
    flagCount++;
  }
  const autoConfirm = flagCount > 0;
  const goalText = args.slice(flagCount).join(' ').trim();
  if (goalText === '') {
    log({ ev: 'error', message: 'usage: npx tsx backend/src/runner.ts [--yes] "<goal>"' });
    return { status: 'failed', goalText: '', costUsd: 0, replans: 0, reextractions: 0, actions: [], reason: 'no goal text provided' };
  }

  log({ ev: 'run.start', goalText, autoConfirm });

  const config = defaultRunConfig();
  const extractor = new LlmExtractorImpl(new ClaudeLlmClient({ model: config.model }), { onEvent: log });
  const executor = new ClaudeCodeExecutor({
    model: config.model,
    timeoutMs: config.actionTimeoutMs,
    noiseFilterPaths: config.noiseFilterPaths,
  });
  const verifier = new ShellVerifier();
  const confirm: DodConfirmer | undefined = autoConfirm
    ? async (_dod, _signal, kind) => {
        log({ ev: 'gate.autoConfirm', kind });
        return true;
      }
    : undefined;
  const acceptanceGate: AcceptanceGate | undefined = autoConfirm
    ? async () => {
        log({ ev: 'gate.autoAccept' });
        return 'accept';
      }
    : undefined;

  const ac = new AbortController();
  const abort = () => ac.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  const orchestrator = new Orchestrator({ extractor, executor, verifier, config, onEvent: log, confirm, acceptanceGate, signal: ac.signal });
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
