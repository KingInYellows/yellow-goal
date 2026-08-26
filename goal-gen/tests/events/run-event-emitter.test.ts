/**
 * RR6–RR8 (plans/specs/request-to-run-pipeline.md): the single per-run run-event/v1 mint.
 * Every envelope must validate against BOTH the zod contract and the vendored JSON Schema —
 * the same dual-oracle rule the compat gate applies to the other contracts.
 */
import { describe, expect, it } from 'vitest';
import { RunEventSchema } from '../../backend/src/contracts/run-event';
import { RunEventEmitter } from '../../backend/src/events/run-event-emitter';
import { validateAgainstJsonSchema } from '../contracts/support/json-schema-checker';
import { loadVendoredSchema } from '../contracts/support/load-schema';

const FIXED_CLOCK = () => new Date('2026-08-26T12:00:00.000Z');

function collect() {
  const envelopes: unknown[] = [];
  const emitter = new RunEventEmitter({ runId: 'run-emitter-test', sink: (e) => envelopes.push(e), clock: FIXED_CLOCK });
  return { envelopes, emitter };
}

describe('RunEventEmitter', () => {
  it('mints envelopes that validate against zod AND the vendored JSON Schema (RR6)', () => {
    const { envelopes, emitter } = collect();
    emitter.handle({ ev: 'run.start', goalText: 'demo', autoConfirm: true });
    emitter.next('AwaitingAcceptance', { goalState: { built: true } });

    const vendored = loadVendoredSchema('run-event');
    for (const envelope of envelopes) {
      expect(RunEventSchema.safeParse(envelope).success).toBe(true);
      const jsonResult = validateAgainstJsonSchema(vendored, envelope);
      expect(jsonResult.valid, jsonResult.errors.join('; ')).toBe(true);
    }
  });

  it('mints a monotonic sequence starting at 0 across all sources (RR7)', () => {
    const { envelopes, emitter } = collect();
    // Interleave the two entry styles the way extractor (handle) + orchestrator (handle) +
    // gate-entry persistence (next) do in production — one counter serves them all.
    emitter.handle({ ev: 'a' });
    emitter.next('b');
    emitter.handle({ ev: 'c' });
    expect((envelopes as Array<{ sequence: number }>).map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it('maps ad-hoc {ev, ...rest} onto type/payload and returns the minted envelope (RR8)', () => {
    const { emitter } = collect();
    const envelope = emitter.handle({ ev: 'step.pass', actionId: 'a1', attempts: 2 });
    expect(envelope).toMatchObject({
      schemaVersion: 'yellow-goal/run-event/v1',
      runId: 'run-emitter-test',
      sequence: 0,
      timestamp: '2026-08-26T12:00:00.000Z',
      type: 'step.pass',
      payload: { actionId: 'a1', attempts: 2 },
    });
  });

  it('keeps a malformed emit visible instead of dropping it', () => {
    const { emitter } = collect();
    const envelope = emitter.handle({ message: 'no ev field' });
    expect(envelope.type).toBe('unknown');
    expect(envelope.payload).toEqual({ message: 'no ev field' });
  });

  it('mints its own runId when none is given', () => {
    const emitter = new RunEventEmitter({ sink: () => {} });
    expect(emitter.runId.length).toBeGreaterThan(0);
    expect(emitter.next('x').runId).toBe(emitter.runId);
  });
});
