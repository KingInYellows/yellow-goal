/**
 * Shared async control-flow primitives for the gate/pause mechanics (R22-R27, R29-R31): a
 * kind-aware single-slot pending gate and a re-armable pause/resume latch, both composed with an
 * `AbortSignal` via one shared race helper. Deepen-plan external research (p-defer /
 * `Promise.withResolvers`, `abort-controller-x`) confirms this reduces to the standard JS
 * deferred-promise pattern — deliberately NOT the `p-cancelable` promise-subclass shape, which
 * breaks `.then()` typing (p-cancelable#20); these are plain objects with control methods.
 */

/**
 * Resolve `promise`'s value, or `onAbort()`'s value if `signal` fires first — never rejects,
 * PROVIDED `promise` itself never rejects (true of every caller here: both `PendingGate` and
 * `AsyncLatch` construct `promise` from a `new Promise((resolve) => ...)` with no reject path
 * exposed). Mirrors `stdinConfirm`'s existing short-circuit-on-abort shape so every gate/latch
 * here settles to a value (declined/paused-forever-avoided) rather than throwing on cancellation.
 */
export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => T): Promise<T> {
  if (signal.aborted) return Promise.resolve(onAbort());
  return new Promise<T>((resolve) => {
    const onSignalAbort = () => resolve(onAbort());
    signal.addEventListener('abort', onSignalAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', onSignalAbort);
      resolve(value);
    });
  });
}

/** The three gate kinds that share one slot (R23/R24/R30) — `dod`/`reconfirm` resolve with a
 *  boolean via `POST /runs/:id/step`, `accept` resolves with `'accept' | 'reject'` via
 *  `POST /runs/:id/accept`. */
export type GateKind = 'dod' | 'reconfirm' | 'accept';

type GateSlot =
  | { kind: 'dod' | 'reconfirm'; resolve: (decision: boolean) => void }
  | { kind: 'accept'; resolve: (decision: 'accept' | 'reject') => void }
  | null;

/**
 * Single outstanding gate at a time (R23 — "not a registry keyed by request ID"), kind-aware so
 * the gate's own type ties which decision shape is valid to which kind is currently open — a
 * caller cannot resolve a `dod`/`reconfirm` gate with `'accept'`/`'reject'` or vice versa, since
 * `resolve()` checks `typeof decision` against the open slot's kind and no-ops on mismatch rather
 * than silently coercing (an earlier generic `PendingGate<T>` design relied on an unchecked `as`
 * cast at each call site instead — flagged in review as a real, if latent, correctness gap once a
 * future HTTP layer resolves gates from arbitrary client input).
 *
 * `resolve()` is idempotent (no-op, returns `false`) when nothing is pending, or when the
 * decision's shape doesn't match the open gate's kind — this is load-bearing, not defensive: the
 * two automatic mid-run re-confirms and the initial DoD confirm all route through the same
 * mechanism, so a stale/duplicate/wrong-shape decision arriving after the gate already settled
 * (abort race or a prior `resolve()`) is a realistic case, not a hypothetical one.
 */
export class PendingGate {
  private slot: GateSlot = null;

  /** The kind of the currently-open gate, or `null` if none is open. */
  kind(): GateKind | null {
    return this.slot?.kind ?? null;
  }

  /** Opens a `dod`/`reconfirm` gate and awaits a boolean decision. Throws if a gate is already
   *  open on this instance — callers must fully await one open call before starting another (true
   *  by construction: the orchestrator's confirm gates are always awaited serially). */
  async openBoolean(kind: 'dod' | 'reconfirm', signal: AbortSignal): Promise<boolean> {
    if (this.slot) throw new Error('PendingGate: a gate is already open on this instance');
    let resolveFn!: (decision: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveFn = resolve;
    });
    this.slot = { kind, resolve: resolveFn };
    try {
      return await raceWithAbort(promise, signal, () => false);
    } finally {
      this.slot = null;
    }
  }

  /** Opens the `accept` (sign-off) gate and awaits an accept/reject decision. Same single-open
   *  contract as `openBoolean`. */
  async openAccept(signal: AbortSignal): Promise<'accept' | 'reject'> {
    if (this.slot) throw new Error('PendingGate: a gate is already open on this instance');
    let resolveFn!: (decision: 'accept' | 'reject') => void;
    const promise = new Promise<'accept' | 'reject'>((resolve) => {
      resolveFn = resolve;
    });
    this.slot = { kind: 'accept', resolve: resolveFn };
    try {
      return await raceWithAbort(promise, signal, () => 'reject');
    } finally {
      this.slot = null;
    }
  }

  /** Idempotent and shape-checked: `false` if no gate is open, or if `decision`'s shape doesn't
   *  match the open gate's kind (e.g. a boolean arriving while the `accept` gate is open). */
  resolve(decision: boolean | 'accept' | 'reject'): boolean {
    if (!this.slot) return false;
    if (this.slot.kind === 'accept') {
      if (decision !== 'accept' && decision !== 'reject') return false;
      this.slot.resolve(decision);
      return true;
    }
    if (typeof decision !== 'boolean') return false;
    this.slot.resolve(decision);
    return true;
  }
}

/**
 * Re-armable pause/resume latch (R26/R27), in-memory only — never persisted, does not survive an
 * API server restart, consistent with the accepted no-crash-resume constraint (R32). A second
 * `pause()` after a `resume()` creates a fresh pending wait rather than reusing a settled one.
 */
export class AsyncLatch {
  private deferred: { promise: Promise<void>; resolve: () => void } | null = null;

  pause(): void {
    if (this.deferred) return; // already paused — idempotent
    let resolveFn!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    this.deferred = { promise, resolve: resolveFn };
  }

  resume(): void {
    if (!this.deferred) return; // not paused — idempotent
    this.deferred.resolve();
    this.deferred = null;
  }

  /** Resolves immediately if not paused; otherwise waits for `resume()` or `signal` to fire —
   *  never rejects, so callers must re-check `signal.aborted` after awaiting this to distinguish
   *  "resumed" from "aborted while paused". */
  async whenResumed(signal: AbortSignal): Promise<void> {
    if (!this.deferred) return;
    await raceWithAbort(this.deferred.promise, signal, () => undefined);
  }
}
