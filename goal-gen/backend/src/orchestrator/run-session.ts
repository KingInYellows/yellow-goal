/**
 * Per-API-invoked-run wrapper (R4, R23): owns the single pending-gate slot, the pause/resume
 * latch, and the `AbortController` — none of which live on `Orchestrator` itself, since a bare
 * orchestrator instance has no concept of "an HTTP caller resolves this decision later." This is
 * the first concrete thing to actually BE the wrapper `OrchestratorDeps`' header comment
 * anticipates ("the later API layer wraps it"), ahead of the real HTTP layer (a later shell).
 *
 * Constructs exactly one fresh `Orchestrator` per `RunSession`, matching R4's "one Orchestrator
 * instance per API-invoked run" — so `RunSession` and `Orchestrator` share a 1:1 lifetime.
 */
import { randomUUID } from 'node:crypto';
import { AsyncLatch, PendingGate } from './async-gate';
import { RUN_WALL_CLOCK_MS } from './guardrails';
import type { GateKind } from './async-gate';
import { Orchestrator } from './orchestrator';
import type { AcceptanceGate, DodConfirmer, OrchestratorDeps } from './orchestrator';
import type { ExtractRequest, RunSummary } from '../types';

export type { GateKind } from './async-gate';
/** Every gate this session can open resolves to one of these shapes — `boolean` for the
 *  dod/reconfirm gates (`POST /runs/:id/step`), `'accept' | 'reject'` for the sign-off gate
 *  (`POST /runs/:id/accept`). `PendingGate` itself validates a decision's shape against the kind
 *  of gate currently open (see `async-gate.ts`), so a mismatched decision is a safe no-op rather
 *  than a silent miscoercion. */
export type GateDecision = boolean | 'accept' | 'reject';

export type RunSessionDeps = Omit<OrchestratorDeps, 'confirm' | 'acceptanceGate' | 'signal' | 'pauseLatch'> & {
  /** runId minted by the caller (R3/R4, e.g. the future HTTP layer); defaults to a fresh UUID for
   *  CLI/test callers that don't mint one themselves. */
  runId?: string;
};

export class RunSession {
  readonly runId: string;
  private readonly controller = new AbortController();
  private readonly gate = new PendingGate();
  private readonly latch = new AsyncLatch();
  private readonly orchestrator: Orchestrator;

  constructor(deps: RunSessionDeps) {
    const { runId, ...rest } = deps;
    this.runId = runId ?? rest.events?.runId ?? randomUUID();

    const confirm: DodConfirmer = async (_dod, signal, kind) => this.gate.openBoolean(kind, signal);
    const acceptanceGate: AcceptanceGate = async (_dod, signal) => this.gate.openAccept(signal);

    this.orchestrator = new Orchestrator({
      ...rest,
      confirm,
      acceptanceGate,
      signal: this.controller.signal,
      pauseLatch: this.latch,
    });
  }

  run(req: ExtractRequest): Promise<RunSummary> {
    // CLAUDE.md invariant #6 / ADR-0010: whoever owns the run's AbortController owns the run-wide
    // wall-clock — the same deadline the CLI entry points arm. An API-driven run parked at a gate
    // nobody resolves must still terminate ('cancelled') instead of holding resources forever.
    const deadline = setTimeout(() => this.controller.abort(), RUN_WALL_CLOCK_MS);
    return this.orchestrator.run(req, this.runId).finally(() => clearTimeout(deadline));
  }

  /** What decision shape the currently-open gate expects, or `null` if no gate is open — for a
   *  future HTTP layer's `GET /runs/:id` response and `409` checks on stale/already-resolved
   *  gates (R12). */
  pendingGateKind(): GateKind | null {
    return this.gate.kind();
  }

  /** Resolve the currently-open gate. Idempotent and shape-checked: returns `false` if no gate is
   *  open, or if `decision`'s shape doesn't match the open gate's kind (e.g. a boolean arriving
   *  while the `accept` gate is open) — a stale/duplicate/wrong-endpoint decision is a safe
   *  no-op, never a silent miscoercion (see `PendingGate.resolve()`). */
  resolveGate(decision: GateDecision): boolean {
    return this.gate.resolve(decision);
  }

  /** R26: takes effect before the orchestrator's next step dispatch, never preempting an
   *  in-flight step. */
  pause(): void {
    this.latch.pause();
  }

  resume(): void {
    this.latch.resume();
  }

  /** R22: cancel triggers the existing per-run `AbortSignal` — no orchestrator-side change
   *  needed, it already checks `signal.aborted` at loop-top and races confirmers against it. */
  cancel(): void {
    this.controller.abort();
  }
}
