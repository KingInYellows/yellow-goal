/**
 * Unit tests for the shared gate/latch primitives (plan Step 8) — deterministic and
 * timing-precise at this level, which the full async orchestrator loop cannot guarantee (e.g.
 * re-arming a pause between two dispatches races against the loop's own microtask ordering).
 */
import { describe, expect, it } from 'vitest';
import { AsyncLatch, PendingGate } from '../../backend/src/orchestrator/async-gate';

describe('PendingGate', () => {
  it('openBoolean() resolves to the value passed to resolve()', async () => {
    const gate = new PendingGate();
    const controller = new AbortController();
    const opened = gate.openBoolean('dod', controller.signal);
    expect(gate.resolve(true)).toBe(true);
    expect(await opened).toBe(true);
  });

  it('openAccept() resolves to the value passed to resolve()', async () => {
    const gate = new PendingGate();
    const controller = new AbortController();
    const opened = gate.openAccept(controller.signal);
    expect(gate.resolve('accept')).toBe(true);
    expect(await opened).toBe('accept');
  });

  it('resolve() is idempotent: false and a no-op when nothing is pending', () => {
    const gate = new PendingGate();
    expect(gate.resolve(true)).toBe(false); // nothing open yet
  });

  it('resolve() after the gate already settled (late/duplicate decision) is a safe no-op', async () => {
    const gate = new PendingGate();
    const controller = new AbortController();
    const opened = gate.openBoolean('reconfirm', controller.signal);
    expect(gate.resolve(true)).toBe(true); // first decision settles it
    expect(await opened).toBe(true);
    expect(gate.resolve(false)).toBe(false); // late duplicate — no-op, does not throw
  });

  it('openBoolean() resolves to false (onAbort) when the signal is already aborted before opening', async () => {
    const gate = new PendingGate();
    const controller = new AbortController();
    controller.abort();
    expect(await gate.openBoolean('dod', controller.signal)).toBe(false);
  });

  it('openAccept() resolves to \'reject\' (onAbort) when the signal is already aborted before opening', async () => {
    const gate = new PendingGate();
    const controller = new AbortController();
    controller.abort();
    expect(await gate.openAccept(controller.signal)).toBe('reject');
  });

  it('openBoolean() resolves to onAbort when the signal fires while the gate is open (R25 abort-race)', async () => {
    const gate = new PendingGate();
    const controller = new AbortController();
    const opened = gate.openBoolean('dod', controller.signal);
    controller.abort();
    expect(await opened).toBe(false);
  });

  it('a late resolve() after an abort-settled gate is a safe no-op (not a crash)', async () => {
    const gate = new PendingGate();
    const controller = new AbortController();
    const opened = gate.openBoolean('dod', controller.signal);
    controller.abort();
    await opened;
    expect(gate.resolve(true)).toBe(false); // gate already settled via abort — no-op
  });

  it('throws if open is called again while a gate is already open on the same instance', async () => {
    const gate = new PendingGate();
    const controller = new AbortController();
    const firstOpen = gate.openBoolean('dod', controller.signal); // left open deliberately
    await expect(gate.openBoolean('reconfirm', controller.signal)).rejects.toThrow(/already open/);
    gate.resolve(true); // settle the first one so it doesn't dangle
    await firstOpen;
  });

  it('kind() reflects the currently-open gate, or null when none is open', async () => {
    const gate = new PendingGate();
    const controller = new AbortController();
    expect(gate.kind()).toBeNull();
    const opened = gate.openBoolean('reconfirm', controller.signal);
    expect(gate.kind()).toBe('reconfirm');
    gate.resolve(true);
    await opened;
    expect(gate.kind()).toBeNull();
  });

  it('resolve() with a wrong-shape decision (boolean while accept is open) is a safe no-op, not a miscoercion', async () => {
    const gate = new PendingGate();
    const controller = new AbortController();
    const opened = gate.openAccept(controller.signal);
    expect(gate.resolve(true)).toBe(false); // wrong shape for an 'accept' gate — rejected at runtime
    expect(gate.kind()).toBe('accept'); // still open — the bad decision didn't settle it
    gate.resolve('reject');
    expect(await opened).toBe('reject');
  });

  it('resolve() with an invalid accept decision string is a safe no-op', async () => {
    const gate = new PendingGate();
    const controller = new AbortController();
    const opened = gate.openAccept(controller.signal);
    expect(gate.resolve('maybe' as unknown as 'accept')).toBe(false);
    expect(gate.kind()).toBe('accept');
    gate.resolve('accept');
    expect(await opened).toBe('accept');
  });

  it('resolve() with a wrong-shape decision (string while dod is open) is a safe no-op', async () => {
    const gate = new PendingGate();
    const controller = new AbortController();
    const opened = gate.openBoolean('dod', controller.signal);
    expect(gate.resolve('accept')).toBe(false); // wrong shape for a 'dod' gate — rejected at runtime
    expect(gate.kind()).toBe('dod'); // still open
    gate.resolve(false);
    expect(await opened).toBe(false);
  });
});

describe('AsyncLatch', () => {
  it('whenResumed() resolves immediately when never paused', async () => {
    const latch = new AsyncLatch();
    const controller = new AbortController();
    await expect(latch.whenResumed(controller.signal)).resolves.toBeUndefined();
  });

  it('pause() blocks whenResumed() until resume() is called', async () => {
    const latch = new AsyncLatch();
    const controller = new AbortController();
    latch.pause();
    let resumed = false;
    const waiting = latch.whenResumed(controller.signal).then(() => {
      resumed = true;
    });
    await Promise.resolve(); // let a microtask turn pass
    expect(resumed).toBe(false); // still blocked
    latch.resume();
    await waiting;
    expect(resumed).toBe(true);
  });

  it('re-arms: pause() -> resume() -> pause() again blocks a FRESH whenResumed() call', async () => {
    const latch = new AsyncLatch();
    const controller = new AbortController();
    latch.pause();
    latch.resume();
    latch.pause(); // second pause after a resume — must not reuse the already-settled wait
    let resumed = false;
    const waiting = latch.whenResumed(controller.signal).then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(resumed).toBe(false); // the re-armed pause is genuinely blocking
    latch.resume();
    await waiting;
    expect(resumed).toBe(true);
  });

  it('whenResumed(signal) settles (does not hang) when the signal aborts while paused, with no resume()', async () => {
    const latch = new AsyncLatch();
    const controller = new AbortController();
    latch.pause();
    const waiting = latch.whenResumed(controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined(); // never rejects, never hangs

    // abort unblocks the WAITER only — the latch's own paused state is untouched, so a fresh
    // whenResumed() on a non-aborted signal still blocks until an explicit resume().
    const freshController = new AbortController();
    let resumed = false;
    const stillWaiting = latch.whenResumed(freshController.signal).then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);
    latch.resume();
    await stillWaiting;
    expect(resumed).toBe(true);
  });

  it('pause() and resume() are idempotent (double-pause, double-resume are no-ops)', async () => {
    const latch = new AsyncLatch();
    const controller = new AbortController();
    latch.pause();
    latch.pause(); // no-op, does not create a second/orphaned deferred
    latch.resume();
    latch.resume(); // no-op
    await expect(latch.whenResumed(controller.signal)).resolves.toBeUndefined();
  });
});
