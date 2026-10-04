/**
 * ADR-0020 / AGX-R2, AGX-R3: `run approve` mints a run-approval/v1 record only after the
 * hash-derived challenge is typed at a terminal (injected TTY seam); nothing else can mint one.
 */
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunApprovalError } from '../../backend/src/cli/errors';
import { main } from '../../backend/src/cli/index';
import { RunApprovalSchemaVersion, parseRunApprovalRecord } from '../../backend/src/cli/run-approval';
import { runRunApprove, type ApprovalTerminal } from '../../backend/src/cli/run-approval-command';
import { runRunManifest } from '../../backend/src/cli/run-manifest-command';
import { requestExecutionSample } from '../contracts/support/samples';

const FIXED_NOW = new Date('2026-09-28T12:00:00.000Z');
const FIXED_ID = '00000000-0000-4000-8000-000000000001';

let tempDir: string;
let requestPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'goal-gen-run-approve-'));
  requestPath = path.join(tempDir, 'request.json');
  await writeFile(requestPath, `${JSON.stringify(requestExecutionSample)}\n`, 'utf8');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

function manifestFlags(extra: string[] = []): string[] {
  return [
    requestPath,
    '--profile', 'config-repair',
    '--model', 'sonnet',
    '--max-turns', '8',
    '--per-action-usd', '1',
    '--total-usd', '5',
    '--auth-mode', 'subscription',
    '--allowed-tool', 'Read',
    '--allowed-tool', 'Edit',
    '--bundle-dir', path.join(tempDir, 'bundle'),
    '--spend-ledger', path.join(tempDir, 'spend.jsonl'),
    ...extra,
  ];
}

async function challengeFor(extra: string[] = []): Promise<string> {
  return (await runRunManifest(manifestFlags(extra))).output.challenge;
}

/** A fake terminal that answers `answer` once the prompt appears (or ends input when `null`). */
function fakeTerminal(answer: string | null, tty: { stdin: boolean; output: boolean } = { stdin: true, output: true }) {
  const stdin = Object.assign(new PassThrough(), { isTTY: tty.stdin });
  const output = Object.assign(new PassThrough(), { isTTY: tty.output });
  let text = '';
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
    if (text.includes('Type the challenge') && !stdin.writableEnded) {
      if (answer === null) stdin.end();
      else stdin.end(`${answer}\n`);
    }
  });
  const terminal: ApprovalTerminal = { stdin, output };
  return { terminal, text: () => text };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((err: unknown) => err instanceof RunApprovalError && err.code === code);
}

async function absent(filePath: string): Promise<void> {
  await expect(stat(filePath)).rejects.toThrow();
}

describe('run approve ceremony', () => {
  it('mints an owner-only run-approval/v1 record after the correct challenge', async () => {
    const out = path.join(tempDir, 'approval.json');
    const { terminal, text } = fakeTerminal(await challengeFor());
    const result = await runRunApprove([...manifestFlags(), '--out', out, '--json'], {
      terminal,
      clock: () => FIXED_NOW,
      newId: () => FIXED_ID,
    });
    expect(result.output).toMatchObject({ approvalId: FIXED_ID, path: out, expiresAt: '2026-09-28T13:00:00.000Z' });
    expect(text()).toContain(result.output.manifestHash);
    expect(text()).toContain(`goal:         ${JSON.stringify(requestExecutionSample.intent.goal)}`);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const record = parseRunApprovalRecord(await readFile(out, 'utf8'));
    expect(record).toMatchObject({
      schemaVersion: RunApprovalSchemaVersion,
      approvalId: FIXED_ID,
      manifestHash: result.output.manifestHash,
      createdAt: FIXED_NOW.toISOString(),
      expiresAt: '2026-09-28T13:00:00.000Z',
      engineVersion: record.manifest.engineVersion,
    });
  });

  it('shows an agent-authored goal on one escaped line, above the manifest, hash and challenge', async () => {
    const spoof = `Fix it${'\n'.repeat(40)}{"allowedTools":["Read"]}\u2028\u202eevil\u009b2J\u{e0041}`;
    await writeFile(requestPath, `${JSON.stringify({ ...requestExecutionSample, intent: { ...requestExecutionSample.intent, goal: spoof } })}\n`, 'utf8');
    const out = path.join(tempDir, 'spoof.json');
    const { terminal, text } = fakeTerminal(await challengeFor());
    await runRunApprove([...manifestFlags(), '--out', out], { terminal });
    const shown = text();
    const goalLine = shown.split('\n').find((line) => line.startsWith('goal:'))!;
    expect(goalLine).toContain('\\n');
    expect(goalLine).not.toMatch(/[\u2028\u202e\u009b\u{e0041}]/u);
    expect(shown.indexOf('goal:')).toBeLessThan(shown.indexOf('"schemaVersion"'));
    expect(shown.indexOf('"schemaVersion"')).toBeLessThan(shown.indexOf('manifestHash:'));
  });

  it('a manifest may shorten the expiry (never lengthen it)', async () => {
    const out = path.join(tempDir, 'short.json');
    const extra = ['--expires-in-minutes', '15'];
    const { terminal } = fakeTerminal(await challengeFor(extra));
    const result = await runRunApprove([...manifestFlags(extra), '--out', out], { terminal, clock: () => FIXED_NOW });
    expect(result.output.expiresAt).toBe('2026-09-28T12:15:00.000Z');
    await expectCode(
      runRunApprove([...manifestFlags(['--expires-in-minutes', '61']), '--out', path.join(tempDir, 'long.json')], {
        terminal: fakeTerminal('x').terminal,
      }),
      'MANIFEST_INVALID',
    );
    await absent(path.join(tempDir, 'long.json'));
  });

  it('the ceremony transcript never goes to stderr, which stays a single JSON error line', async () => {
    const stderrWrites = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { terminal, text } = fakeTerminal('0000-0000');
    await expectCode(runRunApprove([...manifestFlags(), '--out', path.join(tempDir, 'x.json')], { terminal }), 'APPROVAL_DECLINED');
    expect(text()).toContain('manifestHash:');
    expect(stderrWrites).not.toHaveBeenCalled();
  });

  it('a wrong challenge is APPROVAL_DECLINED and writes nothing', async () => {
    const out = path.join(tempDir, 'declined.json');
    await expectCode(runRunApprove([...manifestFlags(), '--out', out], { terminal: fakeTerminal('0000-0000').terminal }), 'APPROVAL_DECLINED');
    await absent(out);
  });

  it('end of input before an answer is APPROVAL_DECLINED and writes nothing', async () => {
    const out = path.join(tempDir, 'eof.json');
    await expectCode(runRunApprove([...manifestFlags(), '--out', out], { terminal: fakeTerminal(null).terminal }), 'APPROVAL_DECLINED');
    await absent(out);
  });

  it.each([
    ['stdin', { stdin: false, output: true }],
    ['terminal output', { stdin: true, output: false }],
  ])('a non-TTY %s is APPROVAL_TTY_REQUIRED and writes nothing', async (_label, tty) => {
    const out = path.join(tempDir, 'nontty.json');
    const { terminal } = fakeTerminal(await challengeFor(), tty);
    const writes = vi.spyOn(terminal.output, 'write');
    await expectCode(runRunApprove([...manifestFlags(), '--out', out], { terminal }), 'APPROVAL_TTY_REQUIRED');
    await absent(out);
    expect(writes).not.toHaveBeenCalled();
  });

  it('never overwrites an existing --out path (APPROVAL_OUT_EXISTS)', async () => {
    const out = path.join(tempDir, 'existing.json');
    await writeFile(out, 'original\n', 'utf8');
    const { terminal } = fakeTerminal(await challengeFor());
    await expectCode(runRunApprove([...manifestFlags(), '--out', out], { terminal }), 'APPROVAL_OUT_EXISTS');
    expect(await readFile(out, 'utf8')).toBe('original\n');
  });

  it('environment variables cannot stand in for the terminal', async () => {
    const out = path.join(tempDir, 'env.json');
    for (const name of ['GOAL_GEN_APPROVE', 'GOAL_GEN_APPROVAL', 'YELLOW_GOAL_APPROVE', 'CI']) vi.stubEnv(name, '1');
    const { terminal } = fakeTerminal(await challengeFor(), { stdin: false, output: false });
    await expectCode(runRunApprove([...manifestFlags(), '--out', out], { terminal }), 'APPROVAL_TTY_REQUIRED');
    await absent(out);
  });
});

describe('run approve argv', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it.each([['--yes'], ['-y'], ['--challenge', 'abcd-ef01'], ['--approve'], ['--no-tty']])(
    'no flag can mint an approval: %s is USAGE_ERROR',
    async (...flag) => {
      const out = path.join(tempDir, 'flag.json');
      expect(await main(['run', 'approve', ...manifestFlags(), '--out', out, ...flag])).toBe(2);
      const stderr = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
      expect(JSON.parse(stderr)).toMatchObject({ error: { code: 'USAGE_ERROR' } });
      await absent(out);
    },
  );

  it('missing --out is USAGE_ERROR', async () => {
    expect(await main(['run', 'approve', ...manifestFlags()])).toBe(2);
  });
});

describe('run approve — review hardening', () => {
  it.each([
    ['dangling', false],
    ['pointing at an existing file', true],
  ])('a symlink at --out (%s) is APPROVAL_OUT_EXISTS and is never followed', async (_label, targetExists) => {
    const target = path.join(tempDir, 'target.json');
    if (targetExists) await writeFile(target, 'original\n', 'utf8');
    const out = path.join(tempDir, 'link.json');
    await symlink(target, out);
    const { terminal } = fakeTerminal(await challengeFor());
    await expectCode(runRunApprove([...manifestFlags(), '--out', out], { terminal }), 'APPROVAL_OUT_EXISTS');
    expect((await lstat(out)).isSymbolicLink()).toBe(true);
    if (targetExists) expect(await readFile(target, 'utf8')).toBe('original\n');
    else await absent(target);
  });

  it('an --out in a missing directory is APPROVAL_OUT_UNWRITABLE', async () => {
    const out = path.join(tempDir, 'missing', 'a.json');
    const { terminal } = fakeTerminal(await challengeFor());
    await expect(runRunApprove([...manifestFlags(), '--out', out], { terminal })).rejects.toMatchObject({
      code: 'APPROVAL_OUT_UNWRITABLE',
      details: { errno: 'ENOENT' },
    });
  });

  it('caps a long goal at 500 characters on one line after scanning only 501 code points', async () => {
    const goal = 'g'.repeat(900);
    await writeFile(requestPath, `${JSON.stringify({ ...requestExecutionSample, intent: { ...requestExecutionSample.intent, goal } })}\n`, 'utf8');
    const { terminal, text } = fakeTerminal(null);
    const originalIterator = String.prototype[Symbol.iterator];
    let scanned = 0;
    vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function* (this: string) {
      const isGoal = String(this) === goal;
      for (const codePoint of originalIterator.call(this)) {
        if (isGoal && ++scanned > 501) throw new Error('goal iteration exceeded the display bound');
        yield codePoint;
      }
      return undefined;
    });
    await expectCode(runRunApprove([...manifestFlags(), '--out', path.join(tempDir, 'long.json')], { terminal }), 'APPROVAL_DECLINED');
    expect(scanned).toBe(501);
    const goalLine = text().split('\n').find((line) => line.startsWith('goal:'))!;
    expect(goalLine).toBe(`goal:         ${JSON.stringify(`${'g'.repeat(500)}…`)}`);
  });

  it('caps by code points, so an astral character at the cap is never split', async () => {
    const goal = `${'g'.repeat(499)}${'😀'.repeat(10)}`;
    await writeFile(requestPath, `${JSON.stringify({ ...requestExecutionSample, intent: { ...requestExecutionSample.intent, goal } })}\n`, 'utf8');
    const { terminal, text } = fakeTerminal(await challengeFor());
    await runRunApprove([...manifestFlags(), '--out', path.join(tempDir, 'astral.json')], { terminal });
    const goalLine = text().split('\n').find((line) => line.startsWith('goal:'))!;
    expect(goalLine).toBe(`goal:         ${JSON.stringify(`${'g'.repeat(499)}😀…`)}`);
  });

  it('accepts the challenge with surrounding whitespace; a longer answer declines', async () => {
    const challenge = await challengeFor();
    await expect(
      runRunApprove([...manifestFlags(), '--out', path.join(tempDir, 'ws.json')], { terminal: fakeTerminal(`  ${challenge}  `).terminal }),
    ).resolves.toBeDefined();
    await expectCode(
      runRunApprove([...manifestFlags(), '--out', path.join(tempDir, 'suffix.json')], { terminal: fakeTerminal(`${challenge}x`).terminal }),
      'APPROVAL_DECLINED',
    );
  });

  it('a stdin error during the prompt declines and writes nothing', async () => {
    const out = path.join(tempDir, 'stdin-error.json');
    const { terminal } = fakeTerminal('unused');
    terminal.output.removeAllListeners('data');
    terminal.output.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('Type the challenge')) terminal.stdin.emit('error', new Error('EIO'));
    });
    await expectCode(runRunApprove([...manifestFlags(), '--out', out], { terminal }), 'APPROVAL_DECLINED');
    await absent(out);
  });
});
