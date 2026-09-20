import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const forbiddenModules = [
  '../../backend/src/cli/run-command',
  '../../backend/src/cli/provider-run-v1',
  '../../backend/src/executors/claude-code-executor',
  '../../backend/src/extractors/llm-extractor',
  '../../backend/src/orchestrator/orchestrator',
];

const observerCommand = '../../backend/src/cli/observed-fixture-command';
const observer = '../../backend/src/cli/observed-fixture-observer';
const recorderCommand = '../../backend/src/cli/acceptance-record-command';

afterEach(() => {
  for (const modulePath of [...forbiddenModules, observerCommand, observer, recorderCommand]) {
    vi.doUnmock(modulePath);
  }
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('observed fixture isolation (OF-11)', () => {
  it('compiler/protocol cold paths do not load the observer', async () => {
    vi.resetModules();
    vi.doMock(observerCommand, () => {
      throw new Error('unexpected observer import');
    });
    vi.doMock(observer, () => {
      throw new Error('unexpected observer import');
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { main } = await import('../../backend/src/cli/index');
    expect(await main(['version', '--json'])).toBe(0);
    expect(await main(['capabilities', '--json'])).toBe(0);
    expect(stderr.mock.calls).toHaveLength(0);
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('acceptance record does not load the observer', async () => {
    vi.resetModules();
    vi.doMock(observerCommand, () => {
      throw new Error('unexpected observer import');
    });
    vi.doMock(observer, () => {
      throw new Error('unexpected observer import');
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'observed-iso-record-'));
    try {
      const fixturePath = path.join(dir, 'ok.json');
      const tree = 'b'.repeat(40);
      await writeFile(
        fixturePath,
        JSON.stringify({
          schemaVersion: 'yellow-goal/acceptance-evidence/v1',
          baseRevision: 'a'.repeat(40),
          candidateIdentity: { kind: 'tree', value: tree },
          candidateTree: tree,
          requiredChecks: [{ id: 'typecheck', command: '__ACCEPTANCE_RECORDER_MUST_NOT_EXECUTE__', cwd: 'goal-gen' }],
          checks: [
            {
              id: 'typecheck',
              status: 'passed',
              command: '__ACCEPTANCE_RECORDER_MUST_NOT_EXECUTE__',
              cwd: 'goal-gen',
              candidateIdentity: { kind: 'tree', value: tree },
              preCheckTree: tree,
              postCheckTree: tree,
              exitStatus: 0,
            },
          ],
        }),
        'utf8',
      );
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { main } = await import('../../backend/src/cli/index');
      expect(await main(['acceptance', 'record', fixturePath, '--json'])).toBe(0);
      expect(stderr.mock.calls).toHaveLength(0);
      stdout.mockRestore();
      stderr.mockRestore();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('observer sources may spawn git/child_process but do not load run-command', () => {
    const observerFile = path.join(packageRoot, 'backend/src/cli/observed-fixture-observer.ts');
    const source = readFileSync(observerFile, 'utf8');
    expect(source).toMatch(/from ['"]node:child_process['"]/);
    expect(source).not.toMatch(/from ['"]\.\/run-command['"]/);
  });

  it('acceptance verify-fixture does not load run-command or executor modules', async () => {
    vi.resetModules();
    for (const modulePath of forbiddenModules) {
      vi.doMock(modulePath, () => {
        throw new Error(`unexpected execution import: ${modulePath}`);
      });
    }
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { main } = await import('../../backend/src/cli/index');
    expect(await main(['acceptance', 'verify-fixture', 'status-probe', 'baseline', '--json'])).toBe(0);
    expect(stderr.mock.calls).toHaveLength(0);
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
