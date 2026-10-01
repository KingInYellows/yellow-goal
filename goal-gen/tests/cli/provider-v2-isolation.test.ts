/**
 * AGX-R26: protocol v2 never reaches the legacy real-spend path. The legacy `claude-code` engine
 * (run-command.ts, `bypassPermissions`) is unreachable from the v2 surface, statically and at runtime.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../backend/src/cli/index';
import { requestExecutionSample } from '../contracts/support/samples';

const packageRoot = path.join(__dirname, '..', '..');
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

function resolveModule(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  return [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts')].find((c) => existsSync(c) && statSync(c).isFile());
}

function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const resolved = resolveModule(file, match[1]!);
      if (resolved) queue.push(resolved);
    }
  }
  return [...seen];
}

describe('provider v2 static isolation (AGX-R26)', () => {
  const entry = path.join(packageRoot, 'backend/src/cli/provider-run-v2-real.ts');
  const graph = reachable(entry);
  const rel = (file: string): string => path.relative(packageRoot, file).split(path.sep).join('/');

  it('the legacy engines, the extractor, run-command, and tests/ are unreachable from the real-run module', () => {
    const files = graph.map(rel);
    // Sanity: the walk follows the engine and the executor it is allowed to use.
    expect(files).toEqual(expect.arrayContaining(['backend/src/real-run/real-run-engine.ts', 'backend/src/executors/real-run-executor.ts']));
    for (const file of ['backend/src/orchestrator/orchestrator.ts', 'backend/src/extractors/llm-extractor.ts', 'backend/src/cli/run-command.ts', 'backend/src/runner.ts']) {
      expect(files, file).not.toContain(file);
    }
    expect(files.filter((file) => file.startsWith('tests/'))).toEqual([]);
  });

  it('ClaudeCodeExecutor is reached only through the hardened real-run executor, never directly', () => {
    // The approved worker IS a ClaudeCodeExecutor, constructed in exactly one place from the manifest
    // (executors/real-run-executor.ts, AGX-R11). Nothing else on the v2 path may import it.
    const importers = graph.filter((file) => /claude-code-executor['"]/.test(readFileSync(file, 'utf8'))).map(rel);
    expect(importers).toEqual(['backend/src/executors/real-run-executor.ts']);
    const specifiers = [...readFileSync(entry, 'utf8').matchAll(SPECIFIER)].map((match) => match[1]!).sort();
    expect(specifiers).toEqual([
      '../events/protocol-stdout-writer', '../events/run-event-emitter', '../real-run/outcome',
      '../real-run/real-run-engine', './protocol-run-options', './provider-capabilities',
    ]);
  });

  it('the v2 module and the real-run engine never name bypassPermissions', () => {
    const own = graph.filter((file) => rel(file).startsWith('backend/src/real-run/') || file === entry || rel(file) === 'backend/src/executors/real-run-executor.ts');
    expect(own.length).toBeGreaterThan(3);
    for (const file of own) expect(readFileSync(file, 'utf8'), rel(file)).not.toContain('bypassPermissions');
  });

  it('run-command dispatches provider-v2-real only to runProviderV2Real', () => {
    const source = readFileSync(path.join(packageRoot, 'backend/src/cli/run-command.ts'), 'utf8');
    const start = source.indexOf("if (invocation.mode === 'provider-v2-real') {");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('\n  }\n', start));
    expect(block).toContain("import('./provider-run-v2-real')");
    expect(block.match(/\b(?:run|import)\w*\(/g)?.sort()).toEqual(['import(', 'runProviderV2Real('].sort());
    // Dispatch precedes any request load or legacy engine wiring.
    expect(source.indexOf("invocation.mode === 'provider-v2-real'")).toBeLessThan(source.indexOf('loadRunRequest(invocation.requestPath)'));
  });
});

describe('--protocol v2 --executor claude-code (AGX-R26)', () => {
  let dir: string;
  let record: string;
  let originalPath: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'provider-v2-isolation-'));
    record = path.join(dir, 'claude-invocations');
    await writeFile(path.join(dir, 'claude'), `#!/bin/sh\necho invoked >> '${record}'\n`);
    await chmod(path.join(dir, 'claude'), 0o755);
    originalPath = process.env.PATH;
    vi.stubEnv('PATH', `${dir}${path.delimiter}${originalPath ?? ''}`);
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

  it('is a usage error before any request load, and a fake claude on PATH is never invoked', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // The request path does not exist: reaching a request load would fail differently.
    expect(await main(['run', path.join(dir, 'missing.json'), '--protocol', 'v2', '--executor', 'claude-code'])).toBe(2);
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(String(stderr.mock.calls[0]![0]))).toEqual({
      error: { code: 'USAGE_ERROR', message: 'provider protocol v2 does not support --executor claude-code; use agx-claude-code with an approval' },
    });
    expect(existsSync(record)).toBe(false);
  });

  it('keeps v1 requiring the stub executor with the same exit code', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await writeFile(path.join(dir, 'request.json'), JSON.stringify(requestExecutionSample));
    expect(await main(['run', path.join(dir, 'request.json'), '--protocol', 'v1', '--executor', 'claude-code'])).toBe(2);
    expect(String(stderr.mock.calls[0]![0])).toContain('provider protocol v1 requires --executor stub');
    expect(existsSync(record)).toBe(false);
  });
});
