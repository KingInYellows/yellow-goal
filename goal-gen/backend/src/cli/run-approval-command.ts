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
import { parseArgs } from 'node:util';
import type { CommandOutput } from './commands';
import { CliUsageError, RunApprovalError } from './errors';
import { RUN_MANIFEST_OPTIONS, manifestFromFlags } from './run-manifest-command';
import { errnoDetails, isErrnoCode, mintRunApprovalRecord, writeFileExclusive, type MintOptions } from './run-approval';
import { askChallenge, displayText, isInteractive, newChallenge, openControllingTerminal, type ApprovalTerminal } from './terminal-challenge';

export type { ApprovalTerminal } from './terminal-challenge';

export type RunApproveOptions = MintOptions & { terminal?: ApprovalTerminal };

export type RunApproveOutput = { approvalId: string; manifestHash: string; expiresAt: string; path: string };

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
  if (!isInteractive(terminal)) {
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
    const answer = await askChallenge(terminal, 'Type the challenge to approve (anything else declines): ');
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
