/**
 * The one terminal outcome of a real run (AGX-R19). Shell 04 maps it onto run events; nothing here
 * is transport. There is no "accepted" kind (AGX-R20): `verified` means the verifier accepted the
 * candidate and it now awaits a human decision. Every kind carries `approvalId` once a valid
 * approval was read (AGX-R6), and every post-consumption kind records that the request's target
 * repository was not used (the worker ran in an engine-seeded scratch worktree, AGX-R8).
 */
import type { RunApprovalErrorCode } from '../cli/errors';
import type { AgentRunFailureClass } from '../types';

/**
 * How a metered worker attempt ended, as the v1 spend ledger records it: success, the executor's
 * failure class, a wall-clock expiry, or `engine-error` when the executor rejected and the attempt
 * could not be classified. Extraction and evidence reasons never reach the ledger.
 */
export type SpendExitClass = 'success' | AgentRunFailureClass | 'wall-clock' | 'engine-error';

/** One worker spawn's metering, as written to the spend ledger (AGX-R16). */
export type RealRunSpend = {
  costUsd: number | null;
  turns: number | null;
  /** The worker-reported duration when the envelope carried one, else the engine-measured wall time of the attempt. */
  durationMs: number;
  exitClass: SpendExitClass;
};

/** Why a run ended as `worker-failed`: an executor failure class, or an engine-side reason. */
export type RealRunWorkerFailureReason =
  | AgentRunFailureClass
  | 'unsafe-allowed-path'
  | 'non-utf8-candidate'
  | 'wall-clock'
  /** The spend ledger or bundle could not be written (EVIDENCE_WRITE_FAILED). */
  | 'evidence-write-failed'
  /** An evidence destination failed its re-check after the approval was consumed. */
  | 'evidence-destination-refused'
  /** The engine itself failed after consumption; `evidence.stage` says where. */
  | 'engine-error';

type AfterConsumption = {
  approvalId: string;
  /** The request's `target.repository` was never read or written (AGX-R8). */
  targetRepositoryHonored: false;
};

export type RealRunOutcome =
  /** Refused before any spawn: nothing ran and nothing was metered (AGX-R4/R5/R8a/R13). */
  | { kind: 'refused'; code: RunApprovalErrorCode; message: string; approvalId?: string; details?: unknown }
  | (AfterConsumption & {
      kind: 'worker-failed';
      reason: RealRunWorkerFailureReason;
      /** Diagnostic details for `reason` (stderr tail, offending path, failed stage, …); not a typed contract. */
      evidence: Record<string, unknown>;
      /** Absent when no worker attempt was metered (nothing was spawned). */
      spend?: RealRunSpend;
    })
  | (AfterConsumption & {
      kind: 'verification-rejected';
      bundleDir: string;
      reasons: string[];
      spend: RealRunSpend;
      /** Changed paths outside the allowed paths — evidence only; `null` if git could not list them. */
      outOfScopeChanges: string[] | null;
    })
  | (AfterConsumption & {
      kind: 'verified';
      bundleDir: string;
      spend: RealRunSpend;
      outOfScopeChanges: string[] | null;
    });
