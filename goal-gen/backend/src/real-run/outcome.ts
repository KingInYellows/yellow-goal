/**
 * The one terminal outcome of a real run (AGX-R19). Shell 04 maps it onto run events; nothing here
 * is transport. There is no "accepted" kind (AGX-R20): `verified` means the verifier accepted the
 * candidate and it now awaits a human decision. Every kind carries `approvalId` once a valid
 * approval was read (AGX-R6), and every post-consumption kind records that the request's target
 * repository was not used (the worker ran in an engine-seeded scratch worktree, AGX-R8).
 */
import type { CandidateFileDocument } from '../cli/candidate-offline-profiles';
import type { RunApprovalErrorCode } from '../cli/errors';
import type { AgentRunFailureClass } from '../types';
import type { UnsafeEntryKind } from './candidate-builder';

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

/** What the executor reported for a worker attempt (stderr bounded by the engine). */
export type WorkerRunEvidence = { failureClass: AgentRunFailureClass | null; exitCode: number | null; stderrTail: string };

/** The bounded candidate and the out-of-scope paths, kept because the worktree is removed on return. */
export type CandidateEvidence = { candidate: CandidateFileDocument; outOfScopeChanges: string[] | null };

/** The verifier's decision, with the candidate it judged. */
export type VerifierDecisionEvidence = CandidateEvidence & { accepted: boolean; reasons: string[] };

/** A destination that failed its re-check after consumption: the refusal's code, else the generic one. */
export type DestinationRefusedEvidence = { code: RunApprovalErrorCode; message: string };

/** An evidence file that could not be written. */
export type EvidenceWriteFailedEvidence = { code: 'EVIDENCE_WRITE_FAILED'; path: string; message: string };

/** The engine itself failed after consumption; `stage` says where (`protocol` is the v2 transport). */
export type EngineErrorEvidence =
  | { stage: 'onStarted' | 'onSpend' | 'protocol'; message: string }
  | { stage: 'worker'; message: string; spendLedgerWritten: boolean; onSpendError?: string }
  | ({ stage: 'verify'; message: string } & Partial<CandidateEvidence>);

/**
 * Why a run ended as `worker-failed`, with the evidence that reason carries — a union keyed on
 * `reason`. A reason that can end the run at several stages has one evidence shape per stage.
 */
export type RealRunWorkerFailure =
  /** The worker failed, or the executor refused it: what the executor reported. */
  | { reason: AgentRunFailureClass | 'wall-clock'; evidence: WorkerRunEvidence }
  /** Cancelled or out of time before the spawn, during extraction, or during verification. */
  | {
      reason: 'cancel' | 'wall-clock';
      evidence: { spawned: false } | ({ stage: 'extract' } & CandidateEvidence) | ({ stage: 'verify' } & VerifierDecisionEvidence);
    }
  /** The engine could not seed the scratch worktree. */
  | { reason: 'worktree-refused'; evidence: { message: string } }
  | { reason: 'unsafe-allowed-path'; evidence: { path: string; kind: UnsafeEntryKind } }
  | { reason: 'non-utf8-candidate'; evidence: { path: string } }
  /** An evidence destination failed its re-check after the approval was consumed; the verifier's
   *  result is kept when it had run. */
  | { reason: 'evidence-destination-refused'; evidence: DestinationRefusedEvidence | (DestinationRefusedEvidence & VerifierDecisionEvidence) }
  /** The spend ledger (with the worker's report) or the bundle (with the verifier's result) could
   *  not be written (EVIDENCE_WRITE_FAILED). */
  | {
      reason: 'evidence-write-failed';
      evidence: EvidenceWriteFailedEvidence & ({ worker: WorkerRunEvidence; onSpendError?: string } | VerifierDecisionEvidence);
    }
  | { reason: 'engine-error'; evidence: EngineErrorEvidence };

export type RealRunWorkerFailureReason = RealRunWorkerFailure['reason'];

type AfterConsumption = {
  approvalId: string;
  /** The request's `target.repository` was never read or written (AGX-R8). */
  targetRepositoryHonored: false;
};

export type RealRunOutcome =
  /** Refused before any spawn: nothing ran and nothing was metered (AGX-R4/R5/R8a/R13). */
  | { kind: 'refused'; code: RunApprovalErrorCode; message: string; approvalId?: string; details?: unknown }
  | (AfterConsumption &
      RealRunWorkerFailure & {
        kind: 'worker-failed';
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
