/**
 * AGX-R15 static isolation: the production bin can never reach the test-only harness or the fake
 * worker, and neither can ship. Walks the relative static and dynamic import graph from
 * `bin/goal-gen.mjs` (which `tsImport`s `backend/src/cli/index.ts`) and asserts no reached module
 * lives under `tests/`; checks that no shipped source imports from `tests/`; and checks that the
 * `package.json` `files` allowlist does not cover `tests/`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = path.join(__dirname, '..', '..');
const testsDir = path.join(packageRoot, 'tests');

/**
 * Relative specifiers from `import … from`, `export … from`, `import '…'`, `import('…')`,
 * `require('…')` and `tsImport('…')`.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\btsImport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

function resolveModule(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function reachableModules(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|mjs|js)$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER)) {
      const resolved = resolveModule(file, match[1]!);
      if (resolved) queue.push(resolved);
    }
  }
  return seen;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|mjs|js)$/.test(entry.name) ? [full] : [];
  });
}

describe('test-only harness isolation (AGX-R15)', () => {
  it('the production bin never reaches a module under tests/', () => {
    const reached = [...reachableModules(path.join(packageRoot, 'bin', 'goal-gen.mjs'))];
    // Sanity: the walk actually followed the tsImport into the CLI and its lazy verb modules.
    expect(reached).toContain(path.join(packageRoot, 'backend', 'src', 'cli', 'index.ts'));
    expect(reached).toContain(path.join(packageRoot, 'backend', 'src', 'cli', 'candidate-offline-command.ts'));
    expect(reached.filter((file) => file.startsWith(testsDir + path.sep))).toEqual([]);
  });

  it('no shipped source imports from tests/', () => {
    const offenders = sourceFiles(path.join(packageRoot, 'backend', 'src')).filter((file) =>
      [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].some((match) => {
        const resolved = path.resolve(path.dirname(file), match[1]!);
        return resolved === testsDir || resolved.startsWith(testsDir + path.sep);
      }),
    );
    expect(offenders).toEqual([]);
  });

  it('no shipped source passes a worker command: the seam is constructor-only and test-only', () => {
    // The two modules that define and forward the option are the only ones allowed to name it.
    const definitions = new Set(
      ['claude-code-executor.ts', 'real-run-executor.ts'].map((file) => path.join(packageRoot, 'backend', 'src', 'executors', file)),
    );
    const offenders = sourceFiles(path.join(packageRoot, 'backend', 'src')).filter(
      (file) => !definitions.has(file) && readFileSync(file, 'utf8').includes('workerCommand'),
    );
    expect(offenders).toEqual([]);
  });

  it('package.json files does not cover the harness or the fake worker', () => {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { files: string[] };
    const shipped = pkg.files.map((entry) => entry.replace(/\/+$/, ''));
    for (const testOnly of ['tests/harness/real-run-harness.ts', 'tests/fixtures/claude-worker/fake-claude.mjs']) {
      expect(existsSync(path.join(packageRoot, testOnly))).toBe(true);
      expect(shipped.some((entry) => testOnly === entry || testOnly.startsWith(`${entry}/`))).toBe(false);
    }
  });
});
