import { PassThrough } from 'node:stream';
import type { ApprovalTerminal } from '../../backend/src/cli/run-approval-command';

/** A terminal that types the challenge the ceremony shows, as soon as it asks for it. */
export function answeringTerminal(): ApprovalTerminal {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let text = '';
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
    const shown = /^challenge:\s+(\S+)$/m.exec(text)?.[1];
    if (shown !== undefined && text.includes('Type the challenge') && !stdin.writableEnded) stdin.end(`${shown}\n`);
  });
  return { stdin, output };
}
