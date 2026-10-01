/**
 * `run approve <request.json> … --out <path>` — the terminal-only approval ceremony (ADR-0020,
 * AGX-R2/R3).
 *
 * An approval is minted only after the operator types a fresh random challenge, shown only on the
 * controlling terminal (stdin AND stderr are TTYs) directly under the manifest it approves. No flag, environment variable, or piped stdin can mint
 * one: a non-TTY invocation is refused with APPROVAL_TTY_REQUIRED before anything is written. The
 * ceremony is consent, not authentication — it stops agent sessions and piped input.
 *
 * Dynamically imported by the dispatcher before `./run-command` is loaded; never spawns.
 */
import { randomBytes } from 'node:crypto';
import { openSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { WriteStream } from 'node:tty';
import { parseArgs } from 'node:util';
import type { CommandOutput } from './commands';
import { CliUsageError, RunApprovalError } from './errors';
import { RUN_MANIFEST_OPTIONS, manifestFromFlags } from './run-manifest-command';
import { errnoDetails, isErrnoCode, mintRunApprovalRecord, writeFileExclusive, type MintOptions } from './run-approval';

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
function openControllingTerminal(): { terminal: ApprovalTerminal; close: () => void } | null {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return null;
  let output: WriteStream;
  try {
    output = new WriteStream(openSync('/dev/tty', 'w'));
  } catch {
    return null;
  }
  return { terminal: { stdin: process.stdin, output }, close: () => output.destroy() };
}

export type RunApproveOptions = MintOptions & { terminal?: ApprovalTerminal };

export type RunApproveOutput = { approvalId: string; manifestHash: string; expiresAt: string; path: string };

/**
 * Asks for the challenge; resolves `null` — a decline — when input ends before an answer
 * (EOF / Ctrl-D), when stdin errors, or when the question itself rejects (e.g. stdin already
 * closed). The abort in `finally` settles a still-pending question; the race has already won.
 */
async function askChallenge(terminal: ApprovalTerminal): Promise<string | null> {
  const rl = createInterface({ input: terminal.stdin, output: terminal.output, terminal: false });
  const abort = new AbortController();
  const onStdinError = () => rl.close();
  terminal.stdin.once('error', onStdinError);
  try {
    const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
    const answered = rl
      .question('Type the challenge to approve (anything else declines): ', { signal: abort.signal })
      .catch(() => null);
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
function newChallenge(): string {
  const hex = randomBytes(4).toString('hex');
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

const DISPLAY_MAX_CHARS = 500;

/**
 * Request text shown to the approver as one JSON-quoted line: newlines/tabs are escaped, bidi,
 * zero-width and line-separator characters are replaced, and length is capped — so an
 * agent-authored request can neither disguise itself nor push a fake manifest into view.
 */
function displayText(value: string): string {
  // DEL/C1 (U+009B is CSI on some terminals), soft hyphen, bidi marks/overrides, zero-width and
  // line separators, variation selectors, BOM, and Unicode tag characters ("ASCII smuggling").
  const cleaned = value.replace(/[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}]/gu, '?');
  // Cap by code points, not UTF-16 units, so the cut never leaves a lone surrogate.
  const codePoints = Array.from(cleaned);
  const capped = codePoints.length > DISPLAY_MAX_CHARS ? `${codePoints.slice(0, DISPLAY_MAX_CHARS).join('')}…` : cleaned;
  return JSON.stringify(capped);
}

export async function runRunApprove(argv: string[], options: RunApproveOptions = {}): Promise<CommandOutput<RunApproveOutput>> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { ...RUN_MANIFEST_OPTIONS, out: { type: 'string' } },
    allowPositionals: true,
  });
  if (typeof values.out !== 'string' || values.out === '') throw new CliUsageError('--out is required');
  const outPath = values.out;

  const { manifest, manifestHash, request } = await manifestFromFlags(values, positionals, 'run approve');

  const controlling = options.terminal === undefined ? openControllingTerminal() : null;
  const terminal = options.terminal ?? controlling?.terminal;
  if (terminal === undefined || terminal.stdin.isTTY !== true || terminal.output.isTTY !== true) {
    throw new RunApprovalError(
      'APPROVAL_TTY_REQUIRED',
      'run approve must be run by a human at a terminal (stdin and stderr must be TTYs); nothing was written',
    );
  }

  const challenge = newChallenge();
  try {
    // Request first, manifest last: the approved manifest sits directly above hash and challenge.
    terminal.output.write(
      `request:      ${displayText(request.requestId)} (${displayText(request.mode)})\n` +
        `goal:         ${displayText(request.intent.goal)}\n\n` +
        `${JSON.stringify(manifest, null, 2)}\n\n` +
        `manifestHash: ${manifestHash}\nchallenge:    ${challenge}\n\n`,
    );
    const answer = await askChallenge(terminal);
    if (answer === null || answer.trim() !== challenge) {
      throw new RunApprovalError('APPROVAL_DECLINED', 'challenge not confirmed; no approval was written');
    }

    const record = mintRunApprovalRecord(manifest, options);
    try {
      await writeFileExclusive(outPath, `${JSON.stringify(record, null, 2)}\n`);
    } catch (err) {
      // ELOOP: a symlink occupies --out (O_NOFOLLOW) — also "exists", never followed.
      if (isErrnoCode(err, 'EEXIST') || isErrnoCode(err, 'ELOOP')) {
        throw new RunApprovalError('APPROVAL_OUT_EXISTS', `${outPath} already exists; approvals are never overwritten`, { path: outPath });
      }
      throw new RunApprovalError(
        'APPROVAL_OUT_UNWRITABLE',
        `cannot write approval to ${outPath}: ${err instanceof Error ? err.message : String(err)}`,
        errnoDetails(outPath, err),
      );
    }
    terminal.output.write(`approved: ${record.approvalId} (expires ${record.expiresAt})\n`);
    return {
      json: values.json === true,
      output: { approvalId: record.approvalId, manifestHash, expiresAt: record.expiresAt, path: outPath },
    };
  } finally {
    controlling?.close();
  }
}
