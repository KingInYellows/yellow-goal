/**
 * AGX-R11 static regression: the real-run construction path can never name, and so never resolve
 * to, the bypass permission mode, and never shares a module with the legacy real path
 * (`cli/run-command.ts`, `runner.ts`) that hardcodes it. The mode name is assembled at runtime so
 * this file does not itself contain the literal.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BYPASS_MODE = ['bypass', 'Permissions'].join('');
const REAL_RUN_MODULES = ['backend/src/executors/real-run-executor.ts', 'backend/src/executors/real-run-guards.ts'];

describe('real-run modules cannot reach the bypass permission mode (AGX-R11)', () => {
  it.each(REAL_RUN_MODULES.map((file) => [file]))('%s never names the bypass mode', (file) => {
    const source = readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    expect(source).not.toContain(BYPASS_MODE);
  });

  it.each(REAL_RUN_MODULES.map((file) => [file]))('%s never imports the legacy real-run path', (file) => {
    const source = readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    expect(source).not.toMatch(/from ['"][./]*(cli\/)?run-command['"]/);
    expect(source).not.toMatch(/from ['"][./]*runner['"]/);
  });
});
