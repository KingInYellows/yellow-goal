/**
 * ADR-0020 static regression: `createRealRunExecutor` is the single construction site for a
 * real-run worker. `realRun` and `workerCommand` are public `ClaudeCodeExecutor` options, so the
 * type system alone does not stop another production module from passing them; this scan does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = path.join(__dirname, '..', '..', 'backend', 'src');
const DEFINING_MODULE = 'executors/claude-code-executor.ts';
const CONSTRUCTION_SITE = 'executors/real-run-executor.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [path.relative(srcRoot, full).split(path.sep).join('/')] : [];
  });
}

/** An object-literal key or shorthand, including quoted and quoted computed keys. */
const optionKey = (name: string) => new RegExp(String.raw`\b${name}\s*[:,}]|(["'])${name}\1\s*:|\[\s*(["'])${name}\2\s*\]\s*:`);

describe('real-run option key scan', () => {
  it.each(['realRun', 'workerCommand'])('recognizes supported key forms for %s', (name) => {
    for (const source of [
      `{ ${name}: config }`,
      `{ ${name} }`,
      `{ ${name}, other }`,
      `{ "${name}": config }`,
      `{ '${name}': config }`,
      `{ ["${name}"]: config }`,
      `{ [ '${name}' ] : config }`,
    ]) expect(source).toMatch(optionKey(name));
    expect(`{ ["${name}Suffix"]: config }`).not.toMatch(optionKey(name));
  });
});

describe('only real-run-executor.ts configures a real-run worker (ADR-0020)', () => {
  const files = sourceFiles(srcRoot);

  it('scans the defining module and the construction site', () => {
    expect(files).toContain(DEFINING_MODULE);
    expect(files).toContain(CONSTRUCTION_SITE);
  });

  it.each([['realRun'], ['workerCommand']])('no other production module passes `%s`', (name) => {
    const offenders = files
      .filter((file) => file !== DEFINING_MODULE && file !== CONSTRUCTION_SITE)
      .filter((file) => optionKey(name).test(readFileSync(path.join(srcRoot, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the construction site does pass both (the scan pattern still matches)', () => {
    const source = readFileSync(path.join(srcRoot, CONSTRUCTION_SITE), 'utf8');
    expect(source).toMatch(optionKey('realRun'));
    expect(source).toMatch(optionKey('workerCommand'));
  });
});
