/**
 * The approval-gated real-run engine (ADR-0020; AGX-R8–R10, R14, R16–R21). One invocation makes at
 * most one worker attempt on a fixed goal, in a fixed order where every refusal precedes the
 * approval's consumption:
 *
 *   recompute manifest → verify approval → auth + tool guards → evidence destinations
 *   → consume → seed worktree → one worker run → spend ledger → extract candidate → verify
 *   → outcome, with the scratch worktree removed on every path once it exists.
 *
 * The worker's exit status and narrative never decide success: only `acceptance verify-candidate`
 * over the allowed-path candidate does, and even then the outcome is `verified` (awaiting a human),
 * never accepted. Nothing is committed, merged, pushed or published.
 *
 * AGX-R5 marker decision: consumption has no intermediate `starting`/`spawned` states. A crash
 * between consume and spawn leaves the approval consumed with nothing spawned; the operator mints
 * a new one.
 *
 * `executorFactory` is the only seam for the worker: tests inject the fake worker through it, so
 * this module never names the test-only worker command option.
 *
 * `runWallClockMs` runs from consumption until the run ends: seeding, the worker attempt, candidate
 * extraction and verification. Extraction (each git call capped at 30 s) and verification
 * (per-check and recorder timeouts) are synchronous or do not take the abort signal, so they are not
 * interrupted; instead the abort state is checked after each, and a wall-clock expiry or cancel that
 * landed meanwhile yields `worker-failed` (`wall-clock` / `cancel`), never `verified` or
 * `verification-rejected`, and no bundle is persisted.
 *
 * The worker leads its own process group, so a terminal's Ctrl-C never reaches it directly: from
 * consumption until the run ends, SIGHUP, SIGINT and SIGTERM abort the attempt instead of killing
 * the engine, and the executor SIGKILLs any live worker group if the engine process exits.
 *
 * Contract: every invocation that gets past parsing returns exactly one `RealRunOutcome`. Before
 * the approval is read, a bad flag or an unreadable request throws (`CliUsageError`, request
 * validation errors) — a usage problem, not an outcome; nothing has been consumed or spawned.
 */
import { getCandidateOfflineProfile, type CandidateOfflineProfile } from '../cli/candidate-offline-profiles';
import { persistCandidateBundleExclusive, type CandidateOfflineBundle } from '../cli/candidate-offline-bundle';
import { verifyCandidateDocument } from '../cli/candidate-offline-command';
import { RunApprovalError } from '../cli/errors';
import { consumeRunApproval, verifyRunApproval, type VerifiedApproval } from '../cli/run-approval-verifier';
import type { RunManifest } from '../cli/run-manifest';
import { manifestFromFlags, type ManifestFlagValues } from '../cli/run-manifest-command';
import { createRealRunExecutor } from '../executors/real-run-executor';
import { assertAuthModeMatchesEnv, assertFilesystemToolsConfined } from '../executors/real-run-guards';
import { createWorktree, type WorktreeHandle } from '../executors/worktree';
import type { Action } from '../planner/types';
import type { AgentRun, AgentRunFailureClass, Executor } from '../types';
import { buildRealRunCandidate } from './candidate-builder';
import { assertEvidenceDestination, assertEvidenceDestinations, REAL_RUN_WORKTREE_PREFIX } from './evidence-destinations';
import { buildFixedAction } from './fixed-goal';
import type { RealRunOutcome, RealRunSpend, RealRunWorkerFailureReason, SpendExitClass } from './outcome';
import { createSpendLedger, SpendLedgerSchemaVersion } from './spend-ledger';

export type RealRunInput = {
  requestPath: string;
  /** The `run manifest` flag values of this invocation; the manifest is recomputed from them. */
  manifestFlags: ManifestFlagValues;
  approvalPath: string | undefined;
  /** Builds the worker executor from the approved manifest (default `createRealRunExecutor`). */
  executorFactory?: (manifest: RunManifest) => Executor;
  /** The environment the auth guard checks (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  /** Approval consumption state dir (default: the verifier's XDG state dir). */
  stateDir?: string;
  /**
   * Caller cancellation. Before consumption it refuses (`RUN_CANCELLED`, approval still usable);
   * afterwards the worker is killed and the outcome is `worker-failed` `cancel`.
   */
  signal?: AbortSignal;
};

/** Executor failure classes that mean no worker process was ever started. */
const NOT_SPAWNED: ReadonlySet<AgentRunFailureClass> = new Set(['auth-mode-mismatch', 'worktree-refused', 'mode-rejected']);

/** How much worker stderr a `worker-failed` outcome keeps as evidence. */
const STDERR_EVIDENCE_CHARS = 2_000;

/** Termination signals that abort the attempt (rather than kill the engine) once it is consumed. */
const TERMINATION_SIGNALS: readonly NodeJS.Signals[] = ['SIGHUP', 'SIGINT', 'SIGTERM'];

function refused(err: RunApprovalError, knownApprovalId: string | undefined): RealRunOutcome {
  // A consumed approval is refused by the verifier itself, which names it in its details.
  const details = err.details as { approvalId?: unknown } | undefined;
  const approvalId = knownApprovalId ?? (typeof details?.approvalId === 'string' ? details.approvalId : undefined);
  return {
    kind: 'refused',
    code: err.code,
    message: err.message,
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(err.details === undefined ? {} : { details: err.details }),
  };
}

type Prepared = {
  manifest: RunManifest;
  verified: VerifiedApproval;
  profile: CandidateOfflineProfile;
  action: Action;
  executor: Executor;
  targetRepository: string;
};

/**
 * Steps 1–5: every check that can refuse, then consumption. Throws `RunApprovalError` for a
 * refusal (with the approvalId once known); anything else (usage, unreadable request) propagates.
 */
async function prepare(input: RealRunInput, clock: () => Date, noteApproval: (id: string) => void): Promise<Prepared> {
  const { manifest, request } = await manifestFromFlags(input.manifestFlags, [input.requestPath], 'run');
  const verified = await verifyRunApproval({
    approvalPath: input.approvalPath,
    expectedManifest: manifest,
    engineVersion: manifest.engineVersion,
    clock,
    ...(input.stateDir === undefined ? {} : { stateDir: input.stateDir }),
  });
  noteApproval(verified.approvalId);
  assertAuthModeMatchesEnv(manifest.authMode, input.env ?? process.env);
  assertFilesystemToolsConfined(manifest.allowedTools);
  const profile = getCandidateOfflineProfile(manifest.profile.id, manifest.profile.version);
  // A profile version without a worker milestone refuses here, before consumption.
  const action = buildFixedAction(profile);
  const executor = (input.executorFactory ?? createRealRunExecutor)(manifest);
  assertEvidenceDestinations(manifest.evidence, { targetRepository: request.target.repository });
  // A cancel that arrives before consumption must not spend the approval.
  if (input.signal?.aborted) {
    throw new RunApprovalError('RUN_CANCELLED', 'the run was cancelled before the approval was consumed; the approval is still usable', {
      approvalId: verified.approvalId,
    });
  }
  await consumeRunApproval(verified, { clock, ...(input.stateDir === undefined ? {} : { stateDir: input.stateDir }) });
  return { manifest, verified, profile, action, executor, targetRepository: request.target.repository };
}

function workerFailureReason(run: AgentRun, wallClockExpired: boolean): AgentRunFailureClass | 'wall-clock' {
  const failureClass = run.failureClass ?? 'error-result';
  return failureClass === 'cancel' && wallClockExpired ? 'wall-clock' : failureClass;
}

function spendOf(run: AgentRun, exitClass: SpendExitClass): RealRunSpend {
  // Prefer the worker-reported duration; fall back to the engine-measured timestamp delta.
  const reported = run.durationMs;
  const elapsed = Date.parse(run.endedAt ?? run.startedAt) - Date.parse(run.startedAt);
  const durationMs =
    typeof reported === 'number' && Number.isFinite(reported) && reported >= 0
      ? reported
      : Number.isFinite(elapsed)
        ? Math.max(0, elapsed)
        : 0;
  return { costUsd: run.costUsd ?? null, turns: run.turns ?? null, durationMs, exitClass };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runRealRun(input: RealRunInput): Promise<RealRunOutcome> {
  const clock = input.clock ?? (() => new Date());
  let approvalId: string | undefined;
  let prepared: Prepared;
  try {
    prepared = await prepare(input, clock, (id) => {
      approvalId = id;
    });
  } catch (err) {
    if (err instanceof RunApprovalError) return refused(err, approvalId);
    throw err;
  }
  const { manifest, verified, profile, action, executor } = prepared;
  const after = { approvalId: verified.approvalId, targetRepositoryHonored: false as const };
  const failed = (
    reason: RealRunWorkerFailureReason,
    evidence: Record<string, unknown>,
    spend?: RealRunSpend,
  ): RealRunOutcome => ({ ...after, kind: 'worker-failed', reason, evidence, ...(spend === undefined ? {} : { spend }) });
  const writeLedger = (spend: RealRunSpend, startedAt: string, endedAt: string): Promise<void> =>
    createSpendLedger(manifest.evidence.spendLedgerPath, {
      schemaVersion: SpendLedgerSchemaVersion,
      approvalId: verified.approvalId,
      model: manifest.model,
      ...spend,
      startedAt,
      endedAt,
    });

  // The approval is consumed from here on; every path below ends in exactly one outcome.
  let worktree: WorktreeHandle | undefined;
  const controller = new AbortController();
  let wallClockExpired = false;
  const wallClock = setTimeout(() => {
    // A caller cancel already in progress stays a cancel.
    if (controller.signal.aborted) return;
    wallClockExpired = true;
    controller.abort();
  }, manifest.runWallClockMs);
  const onCallerAbort = (): void => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', onCallerAbort, { once: true });
  for (const sig of TERMINATION_SIGNALS) process.on(sig, onCallerAbort);

  try {
    try {
      worktree = await createWorktree({ seedFiles: profile.baseFiles, prefix: REAL_RUN_WORKTREE_PREFIX });
      assertEvidenceDestinations(manifest.evidence, { targetRepository: prepared.targetRepository, worktreeRoot: worktree.root });
    } catch (err) {
      if (err instanceof RunApprovalError) return failed('evidence-destination-refused', { code: err.code, message: err.message });
      return failed('worktree-refused', { message: errorMessage(err) });
    }

    // Cancelled or out of time before the worker started: spend nothing (no spawn, no ledger).
    // Nothing awaits between this check and the spawn, so no abort can land in between.
    if (controller.signal.aborted) return failed(wallClockExpired ? 'wall-clock' : 'cancel', { spawned: false });

    let run: AgentRun;
    try {
      run = await executor.run(action, {
        runId: verified.approvalId,
        worktreePath: worktree.worktreePath,
        signal: controller.signal,
        budgetUsdRemaining: manifest.caps.totalUsd,
        ...(worktree.gitDir === undefined ? {} : { gitDir: worktree.gitDir }),
      });
    } catch (err) {
      // The executor contract is to resolve, never reject. Whether a worker ran is unknown, so the
      // attempt is metered as unknown spend rather than left out of the ledger.
      const now = clock().toISOString();
      const spend: RealRunSpend = { costUsd: null, turns: null, durationMs: 0, exitClass: 'engine-error' };
      const ledgered = await writeLedger(spend, now, now).then(
        () => true,
        () => false,
      );
      return failed('engine-error', { stage: 'worker', message: errorMessage(err), spendLedgerWritten: ledgered }, spend);
    }

    const workerEvidence = {
      failureClass: run.failureClass ?? null,
      exitCode: run.exitCode ?? null,
      stderrTail: (run.stderr ?? '').slice(-STDERR_EVIDENCE_CHARS),
    };
    const reason: SpendExitClass = run.status === 'succeeded' ? 'success' : workerFailureReason(run, wallClockExpired);
    if (reason !== 'success' && NOT_SPAWNED.has(run.failureClass ?? 'error-result')) return failed(reason, workerEvidence);

    // One ledger entry for the one spawn, whatever its outcome (AGX-R16). A `spawn-error` is
    // metered too: the attempt was made, and its cost is recorded as unknown (null).
    const spend = spendOf(run, reason);
    try {
      // Each destination is re-checked just before its own write, so a problem with the bundle
      // path can never keep this spend out of the ledger.
      assertEvidenceDestination(manifest.evidence.spendLedgerPath, {
        targetRepository: prepared.targetRepository,
        worktreeRoot: worktree.root,
      });
      await writeLedger(spend, run.startedAt, run.endedAt ?? run.startedAt);
    } catch (err) {
      return failed(
        'evidence-write-failed',
        { code: 'EVIDENCE_WRITE_FAILED', path: manifest.evidence.spendLedgerPath, message: errorMessage(err), worker: workerEvidence },
        spend,
      );
    }
    if (reason !== 'success') return failed(reason, workerEvidence, spend);

    // An abort (wall-clock expiry, caller cancel, termination signal) that landed while extraction
    // or verification ran must not be accepted as a result.
    const abortedReason = (): RealRunWorkerFailureReason => (wallClockExpired ? 'wall-clock' : 'cancel');

    let built: ReturnType<typeof buildRealRunCandidate> | undefined;
    let bundle: CandidateOfflineBundle;
    try {
      built = buildRealRunCandidate(worktree.worktreePath, profile, worktree.gitDir);
      if (!built.ok) return failed(built.reason, built.evidence, spend);
      if (controller.signal.aborted) {
        return failed(abortedReason(), { stage: 'extract', candidate: built.candidate, outOfScopeChanges: built.outOfScopeChanges }, spend);
      }
      // The approved profile version is passed explicitly — never the verifier's default (AGX-R18).
      bundle = await verifyCandidateDocument(profile, built.candidate);
    } catch (err) {
      // The worktree is removed on return, so keep the bounded candidate and the out-of-scope
      // paths (if a candidate was built).
      return failed(
        'engine-error',
        {
          stage: 'verify',
          message: errorMessage(err),
          ...(built?.ok ? { candidate: built.candidate, outOfScopeChanges: built.outOfScopeChanges } : {}),
        },
        spend,
      );
    }
    if (controller.signal.aborted) {
      return failed(
        abortedReason(),
        {
          stage: 'verify',
          accepted: bundle.decision.accepted,
          reasons: bundle.decision.reasons,
          candidate: built.candidate,
          outOfScopeChanges: built.outOfScopeChanges,
        },
        spend,
      );
    }

    const { bundleDir } = manifest.evidence;
    // The worktree is removed on return, so a bundle that cannot be written keeps the (bounded)
    // candidate and the verifier's decision in the outcome instead.
    const unpersisted = {
      accepted: bundle.decision.accepted,
      reasons: bundle.decision.reasons,
      candidate: built.candidate,
      outOfScopeChanges: built.outOfScopeChanges,
    };
    try {
      assertEvidenceDestination(bundleDir, { targetRepository: prepared.targetRepository, worktreeRoot: worktree.root });
    } catch (err) {
      const code = err instanceof RunApprovalError ? err.code : 'EVIDENCE_DESTINATION_REFUSED';
      return failed('evidence-destination-refused', { code, message: errorMessage(err), ...unpersisted }, spend);
    }
    try {
      // Created exclusively through the held parent directory: nothing that appeared since, and no
      // swapped parent, is written into.
      persistCandidateBundleExclusive(bundleDir, bundle);
    } catch (err) {
      return failed('evidence-write-failed', { code: 'EVIDENCE_WRITE_FAILED', path: bundleDir, message: errorMessage(err), ...unpersisted }, spend);
    }
    if (bundle.decision.accepted === true) {
      return { ...after, kind: 'verified', bundleDir, spend, outOfScopeChanges: built.outOfScopeChanges };
    }
    return {
      ...after,
      kind: 'verification-rejected',
      bundleDir,
      reasons: bundle.decision.reasons,
      spend,
      outOfScopeChanges: built.outOfScopeChanges,
    };
  } finally {
    clearTimeout(wallClock);
    input.signal?.removeEventListener('abort', onCallerAbort);
    for (const sig of TERMINATION_SIGNALS) process.off(sig, onCallerAbort);
    // Teardown is best-effort (`rm --force` of an engine tmpdir); it must not replace the outcome.
    await worktree?.cleanup().catch(() => undefined);
  }
}
