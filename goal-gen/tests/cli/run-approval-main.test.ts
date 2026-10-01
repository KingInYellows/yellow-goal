/**
 * `main(['run', 'approve', …])` end to end in-process: the CLI entry opens the controlling
 * terminal itself (no injected seam), runs the ceremony, writes the record, and renders the
 * `--json` success payload on stdout with exit 0. A CI runner has no `/dev/tty`, so the terminal is
 * faked one level down: `node:tty` `WriteStream` and the `/dev/tty` open are mocked, and
 * `process.stdin` / `process.stderr` report TTYs. Everything else is the production path.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tty = vi.hoisted(() => ({ outputs: [] as Array<{ text: () => string }>, answer: '' }));

vi.mock('node:tty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:tty')>();
  const { PassThrough: Pass } = await import('node:stream');
  class FakeTtyWriteStream extends Pass {
    readonly isTTY = true;
    private written = '';
    constructor(_fd: number) {
      super();
      this.on('data', (chunk: Buffer) => {
        this.written += chunk.toString('utf8');
      });
      tty.outputs.push({ text: () => this.written });
    }
  }
  return { ...actual, WriteStream: FakeTtyWriteStream };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((file: Parameters<typeof actual.openSync>[0], ...rest: unknown[]) =>
      file === '/dev/tty' ? -1 : (actual.openSync as (...args: unknown[]) => number)(file, ...rest)) as typeof actual.openSync,
  };
});

import { main } from '../../backend/src/cli/index';
import { parseRunApprovalRecord } from '../../backend/src/cli/run-approval';
import { requestExecutionSample } from '../contracts/support/samples';

let tempDir: string;
let requestPath: string;
const stderrIsTTY = process.stderr.isTTY;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'goal-gen-run-approve-main-'));
  requestPath = path.join(tempDir, 'request.json');
  await writeFile(requestPath, `${JSON.stringify(requestExecutionSample)}\n`, 'utf8');
  tty.outputs.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.stderr.isTTY = stderrIsTTY;
  await rm(tempDir, { recursive: true, force: true });
});

function manifestFlags(): string[] {
  return [
    requestPath,
    '--profile', 'config-repair',
    '--max-turns', '8',
    '--per-action-usd', '1',
    '--total-usd', '5',
    '--auth-mode', 'subscription',
    '--allowed-tool', 'Read',
    '--allowed-tool', 'Edit',
    '--bundle-dir', path.join(tempDir, 'bundle'),
    '--spend-ledger', path.join(tempDir, 'spend.jsonl'),
  ];
}

describe('main run approve', () => {
  it('mints through the controlling terminal and renders the --json success payload', async () => {
    // The controlling terminal's input: answers once the prompt has been written to /dev/tty.
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    // Typed like an operator would: the answer only, with no EOF on its heels.
    let challenge: string | undefined;
    const answerWhenPrompted = setInterval(() => {
      const screen = tty.outputs.map((out) => out.text()).join('');
      if (challenge === undefined && screen.includes('Type the challenge')) {
        challenge = /^challenge:\s+(\S+)$/m.exec(screen)?.[1] ?? '';
        stdin.write(`${challenge}\n`);
      }
    }, 5);
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    process.stderr.isTTY = true;
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });

    const out = path.join(tempDir, 'approval.json');
    let code: number;
    try {
      code = await main(['run', 'approve', ...manifestFlags(), '--out', out, '--json']);
    } finally {
      clearInterval(answerWhenPrompted);
    }

    expect(code).toBe(0);
    expect(tty.outputs).toHaveLength(1);
    expect(challenge).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
    const record = parseRunApprovalRecord(await readFile(out, 'utf8'));
    expect(JSON.parse(stdout)).toEqual({
      approvalId: record.approvalId,
      manifestHash: record.manifestHash,
      expiresAt: record.expiresAt,
      path: out,
    });
  });
});
