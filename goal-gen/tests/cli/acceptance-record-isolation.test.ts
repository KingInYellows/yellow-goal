import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const recorderFiles = [
  path.join(packageRoot, 'backend/src/cli/acceptance-evidence.ts'),
  path.join(packageRoot, 'backend/src/cli/acceptance-record-command.ts'),
];

const forbiddenModules = [
  '../../backend/src/cli/run-command',
  '../../backend/src/cli/provider-run-v1',
  '../../backend/src/executors/claude-code-executor',
  '../../backend/src/extractors/llm-extractor',
  '../../backend/src/orchestrator/orchestrator',
];

const recorderModule = '../../backend/src/cli/acceptance-record-command';
const evidenceModule = '../../backend/src/cli/acceptance-evidence';

afterEach(() => {
  for (const modulePath of [...forbiddenModules, recorderModule, evidenceModule]) vi.doUnmock(modulePath);
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('acceptance recorder isolation', () => {
  it('recorder sources never import child_process, git, or run-command', () => {
    for (const file of recorderFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/from ['"]node:child_process['"]/);
      expect(source).not.toMatch(/from ['"]\.\/run-command['"]/);
      expect(source).not.toMatch(/spawnSync|execFileSync|execSync|\bspawn\(/);
      expect(source).not.toMatch(/git rev-parse|git add|git write-tree/);
    }
  });

  it('compiler/protocol cold paths do not load the recorder', async () => {
    vi.resetModules();
    vi.doMock(recorderModule, () => {
      throw new Error('unexpected recorder import');
    });
    vi.doMock(evidenceModule, () => {
      throw new Error('unexpected recorder import');
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

  it('acceptance record does not load run-command or executor modules', async () => {
    vi.resetModules();
    for (const modulePath of forbiddenModules) {
      vi.doMock(modulePath, () => {
        throw new Error(`unexpected execution import: ${modulePath}`);
      });
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'acceptance-iso-'));
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
});
