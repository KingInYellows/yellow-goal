/**
 * The single construction site for the approval-gated real-run worker (ADR-0020). It maps an
 * approved run manifest onto `ClaudeCodeExecutor` options, so nothing but the manifest decides
 * the worker's model, turns, timeout, tools, budget and auth mode. The mapping lives here, not in
 * the approval modules, because those must never import `executors/`.
 *
 * This module must never name the permission mode a real run can never reach (static test,
 * AGX-R11); the executor resolves the mode only through `resolveRealRunPermissionMode`.
 */
import { RunApprovalError } from '../cli/errors';
import { type RunManifest, RunManifestSchema } from '../cli/run-manifest';
import { ClaudeCodeExecutor, type WorkerCommand } from './claude-code-executor';

export interface RealRunExecutorOverrides {
  /** Test-only fake worker (AGX-R15). Production callers never pass it (static test). */
  workerCommand?: WorkerCommand;
}

export function createRealRunExecutor(manifest: RunManifest, opts: RealRunExecutorOverrides = {}): ClaudeCodeExecutor {
  const parsed = RunManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new RunApprovalError('MANIFEST_INVALID', `invalid run manifest: ${parsed.error.issues[0]?.message ?? 'unknown'}`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  const approved = parsed.data;
  return new ClaudeCodeExecutor({
    model: approved.model,
    maxTurns: approved.maxTurns,
    timeoutMs: approved.actionTimeoutMs,
    // The executor resolves this through the acceptEdits-only resolver (AGX-R11).
    permissionMode: approved.permissionMode,
    ...(opts.workerCommand ? { workerCommand: opts.workerCommand } : {}),
    realRun: {
      allowedTools: approved.allowedTools,
      disallowedTools: approved.disallowedTools,
      maxBudgetUsd: approved.caps.perActionUsd,
      authMode: approved.authMode,
    },
  });
}
