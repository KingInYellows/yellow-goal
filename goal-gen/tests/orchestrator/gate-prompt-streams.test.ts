/**
 * RR12 protocol purity: stdout is the run-event/v1 JSON Lines stream for both entry points, so
 * the default stdin gates must put their human-facing prompt text on stderr. An aborted signal
 * lets these run to completion without touching stdin.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { stdinAcceptanceGate, stdinConfirm } from '../../backend/src/orchestrator/orchestrator';
import type { DodInfo } from '../../backend/src/orchestrator/orchestrator';

const dod: DodInfo = {
  goalText: 'demo goal',
  goalState: { done: true },
  completionPolicy: 'verify+signoff',
  actions: [{ name: 'a1', verify: { command: 'verify-a1' } }],
  plannedSequence: ['a1'],
};

function abortedSignal(): AbortSignal {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
}

describe('default stdin gates keep prompts off protocol stdout', () => {
  it('stdinConfirm writes its prompt to stderr only', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(stdinConfirm(dod, abortedSignal(), 'dod')).resolves.toBe(false);
      expect(out).not.toHaveBeenCalled();
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('Definition of Done');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('stdinAcceptanceGate writes its prompt to stderr only', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(stdinAcceptanceGate(dod, abortedSignal())).resolves.toBe('reject');
      expect(out).not.toHaveBeenCalled();
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('ACCEPT sign-off');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

/** Swap process.stdin for a stream that is already at EOF — what a non-interactive invocation
 *  (`< /dev/null`, a drained pipe) looks like to readline. */
function withClosedStdin<T>(fn: () => Promise<T>): Promise<T> {
  const closed = new PassThrough();
  closed.end();
  const spy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(closed as unknown as typeof process.stdin);
  return fn().finally(() => spy.mockRestore());
}

describe('default stdin gates on a closed stdin end the prompt line (stderr stays line-parseable)', () => {
  it('stdinConfirm declines and terminates the dangling prompt with a newline', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const ac = new AbortController();
      await expect(withClosedStdin(() => stdinConfirm(dod, ac.signal, 'dod'))).resolves.toBe(false);
      const text = err.mock.calls.map((c) => String(c[0])).join('');
      expect(text).toContain('Proceed? [y/N] ');
      expect(text.endsWith('\n')).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  it('stdinAcceptanceGate fails loudly and terminates the dangling prompt with a newline', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const ac = new AbortController();
      await expect(withClosedStdin(() => stdinAcceptanceGate(dod, ac.signal))).rejects.toThrow(/stdin closed/);
      const text = err.mock.calls.map((c) => String(c[0])).join('');
      expect(text).toContain('Accept? [y/N] ');
      expect(text.endsWith('\n')).toBe(true);
    } finally {
      err.mockRestore();
    }
  });
});
