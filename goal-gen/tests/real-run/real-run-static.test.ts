/**
 * AGX-R21 static smoke check, lexical in scope: no module under `backend/src/real-run/` spawns a
 * process itself or names a history- or remote-writing git verb as a string literal. Modules it
 * imports are out of scope (the verifier commits inside its own disposable observation repo); the
 * behavioural guarantee is that the request's target repository is never touched (AGX-R8).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const engineDir = path.join(__dirname, '..', '..', 'backend', 'src', 'real-run');
const modules = readdirSync(engineDir).filter((file) => file.endsWith('.ts'));

describe('the real-run engine never commits or publishes (AGX-R21)', () => {
  it.each(modules.map((file) => [file]))('%s names no history- or remote-writing git verb', (file) => {
    const source = readFileSync(path.join(engineDir, file), 'utf8');
    for (const verb of ['commit', 'push', 'merge', 'rebase', 'tag', 'publish']) {
      expect(source, `${file}: '${verb}'`).not.toMatch(new RegExp(`['"]${verb}['"]`));
    }
  });

  it.each(modules.map((file) => [file]))('%s never spawns a process itself', (file) => {
    const source = readFileSync(path.join(engineDir, file), 'utf8');
    expect(source).not.toMatch(/child_process/);
  });
});
