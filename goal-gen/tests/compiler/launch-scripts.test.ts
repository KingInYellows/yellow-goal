import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACK_SCRIPTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packs',
  'repository-goal-packet',
  'v1',
  'scripts',
);

describe('pack launch scripts feed the master implementation prompt', () => {
  it('launch.sh cats MASTER_IMPLEMENTATION_PROMPT.md into the claude argv', async () => {
    const script = await readFile(path.join(PACK_SCRIPTS, 'launch.sh'), 'utf8');
    expect(script).toContain('prompts/MASTER_IMPLEMENTATION_PROMPT.md');
    expect(script).toMatch(/claude[\s\S]*"\$\(cat "\$MASTER_PROMPT"\)"/);
    expect(script).toMatch(/missing prompts\/MASTER_IMPLEMENTATION_PROMPT\.md/);
  });

  it('launch.ps1 passes the master prompt text as the claude session argument', async () => {
    const script = await readFile(path.join(PACK_SCRIPTS, 'launch.ps1'), 'utf8');
    expect(script).toContain('prompts/MASTER_IMPLEMENTATION_PROMPT.md');
    expect(script).toContain('$PromptText = Get-Content -Raw $MasterPrompt');
    expect(script).toMatch(/claude[\s\S]*\$PromptText/);
  });
});
