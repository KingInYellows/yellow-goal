/**
 * The terminal-challenge seam shared by `run approve` (ADR-0020, AGX-R2/R3) and the M1 runner's
 * spend confirmation (RR22): a fresh random challenge shown only on the controlling terminal,
 * which the operator must type back. No flag, environment variable, or piped stdin can answer
 * it. The ceremony is consent, not authentication — it stops agent sessions and piped input.
 *
 * Zero-spend by construction: no subprocess APIs, no executor/orchestrator imports.
 */
import { randomBytes } from 'node:crypto';
import { openSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { WriteStream } from 'node:tty';

/**
 * The TTY seam: tests inject streams. In production `stdin` is `process.stdin` and `output` is the
 * controlling terminal (`/dev/tty`) — never stderr, which stays reserved for the single-line JSON
 * error envelope (process contract, ADR-0016), so a refused ceremony leaves stderr parseable.
 */
export type ApprovalTerminal = {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
};

/**
 * Binds the ceremony to the controlling terminal. Requires stdin and stderr to be TTYs (AGX-R2);
 * returns null — a refusal — when either is not, or when `/dev/tty` cannot be opened.
 */
export function openControllingTerminal(): { terminal: ApprovalTerminal; close: () => void } | null {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return null;
  let output: WriteStream;
  try {
    output = new WriteStream(openSync('/dev/tty', 'w'));
  } catch {
    return null;
  }
  return { terminal: { stdin: process.stdin, output }, close: () => output.destroy() };
}

/** True only when both sides of the seam are TTYs. */
export function isInteractive(terminal: ApprovalTerminal | undefined): terminal is ApprovalTerminal {
  return terminal !== undefined && terminal.stdin.isTTY === true && terminal.output.isTTY === true;
}

/**
 * Asks for the challenge; resolves `null` — a decline — when input ends before an answer
 * (EOF / Ctrl-D), when stdin errors, or when the question itself rejects (e.g. stdin already
 * closed). The abort in `finally` settles a still-pending question; the race has already won.
 */
export async function askChallenge(terminal: ApprovalTerminal, prompt: string): Promise<string | null> {
  // A stream that already ended never emits `close` to a new interface, so the question would hang.
  const input = terminal.stdin as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
  if (input.readableEnded === true || input.destroyed === true) return null;
  const rl = createInterface({ input: terminal.stdin, output: terminal.output, terminal: false });
  const abort = new AbortController();
  const onStdinError = () => rl.close();
  terminal.stdin.once('error', onStdinError);
  try {
    const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
    const answered = rl.question(prompt, { signal: abort.signal }).catch(() => null);
    return await Promise.race([answered, closed]);
  } finally {
    terminal.stdin.removeListener('error', onStdinError);
    abort.abort();
    rl.close();
  }
}

/**
 * A fresh challenge per ceremony, e.g. `3f9a-01bc`. It is random rather than derived from the
 * manifest hash, so no earlier output (`run manifest` prints the hash) lets a session alongside the
 * operator relay the answer before the manifest has been shown here (AGX-R2).
 */
export function newChallenge(): string {
  const hex = randomBytes(4).toString('hex');
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

const DISPLAY_MAX_CHARS = 500;

/**
 * Request text shown to the approver as one JSON-quoted line: newlines/tabs are escaped, bidi,
 * zero-width and line-separator characters are replaced, and length is capped — so an
 * agent-authored request can neither disguise itself nor push a fake manifest into view.
 */
export function displayText(value: string): string {
  // DEL/C1 (U+009B is CSI on some terminals), soft hyphen, bidi marks/overrides, zero-width and
  // line separators, variation selectors, BOM, and Unicode tag characters ("ASCII smuggling").
  const cleaned = value.replace(/[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}]/gu, '?');
  // Cap by code points, not UTF-16 units, so the cut never leaves a lone surrogate.
  const codePoints: string[] = [];
  for (const codePoint of cleaned) {
    codePoints.push(codePoint);
    if (codePoints.length > DISPLAY_MAX_CHARS) break;
  }
  const capped = codePoints.length > DISPLAY_MAX_CHARS ? `${codePoints.slice(0, DISPLAY_MAX_CHARS).join('')}…` : cleaned;
  return JSON.stringify(capped);
}
