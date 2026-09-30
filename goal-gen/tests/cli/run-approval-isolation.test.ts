/**
 * ADR-0020: the approval modules are zero-spend by construction — no subprocess APIs, no
 * run-command/executor/orchestrator loading, no `bypassPermissions`, and the compiler/protocol
 * cold paths never load them.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestExecutionSample } from '../contracts/support/samples';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const approvalFiles = [
  'run-manifest.ts',
  'run-manifest-command.ts',
  'run-approval.ts',
  'run-approval-command.ts',
  'run-approval-verifier.ts',
].map((file) => path.join(packageRoot, 'backend/src/cli', file));

const forbiddenModules = [
  '../../backend/src/cli/run-command',
  '../../backend/src/cli/provider-run-v1',
  '../../backend/src/executors/claude-code-executor',
  '../../backend/src/extractors/llm-extractor',
  '../../backend/src/orchestrator/orchestrator',
];

const approvalModules = [
  '../../backend/src/cli/run-manifest-command',
  '../../backend/src/cli/run-approval-command',
  '../../backend/src/cli/run-approval-verifier',
];

afterEach(() => {
  for (const modulePath of [...forbiddenModules, ...approvalModules]) vi.doUnmock(modulePath);
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('run approval isolation', () => {
  it('approval sources never import subprocess APIs, run-command, or name bypassPermissions', () => {
    for (const file of approvalFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/child_process/);
      expect(source, file).not.toMatch(/from ['"]\.\/run-command['"]/);
      expect(source, file).not.toMatch(/spawnSync|execFileSync|execSync|\bspawn\(|\bexec\(/);
      expect(source, file).not.toMatch(/executors\/|orchestrator\/orchestrator|llm-extractor/);
      expect(source, file).not.toContain('bypassPermissions');
    }
  });

  it('version and capabilities never load the approval modules', async () => {
    vi.resetModules();
    for (const modulePath of approvalModules) {
      vi.doMock(modulePath, () => {
        throw new Error(`unexpected approval import: ${modulePath}`);
      });
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { main } = await import('../../backend/src/cli/index');
    expect(await main(['version', '--json'])).toBe(0);
    expect(await main(['capabilities', '--json'])).toBe(0);
    expect(stderr.mock.calls).toHaveLength(0);
  });

  it('run manifest does not load run-command, executor, extractor, or orchestrator modules', async () => {
    vi.resetModules();
    for (const modulePath of forbiddenModules) {
      vi.doMock(modulePath, () => {
        throw new Error(`unexpected execution import: ${modulePath}`);
      });
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'goal-gen-run-approval-iso-'));
    try {
      const requestPath = path.join(dir, 'request.json');
      await writeFile(requestPath, JSON.stringify(requestExecutionSample), 'utf8');
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { main } = await import('../../backend/src/cli/index');
      const flags = ['--profile', 'config-repair', '--max-turns', '8', '--per-action-usd', '1', '--total-usd', '5', '--auth-mode', 'subscription', '--allowed-tool', 'Edit', '--bundle-dir', path.join(dir, 'bundle'), '--spend-ledger', path.join(dir, 'spend.jsonl')];
      expect(await main(['run', 'manifest', requestPath, ...flags, '--json'])).toBe(0);
      expect(stderr.mock.calls).toHaveLength(0);
      // A refused approve (injected non-TTY terminal, so a developer's real TTY never prompts)
      // also stays isolated: it fails with its own code, not an unexpected-import error.
      const { runRunApprove } = await import('../../backend/src/cli/run-approval-command');
      const terminal = { stdin: Object.assign(new PassThrough(), { isTTY: false }), output: Object.assign(new PassThrough(), { isTTY: false }) };
      await expect(runRunApprove([requestPath, ...flags, '--out', path.join(dir, 'a.json')], { terminal })).rejects.toMatchObject({
        code: 'APPROVAL_TTY_REQUIRED',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
