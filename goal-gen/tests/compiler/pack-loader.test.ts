/**
 * Pack loader/render tests: `pack.json` validates and its engine range is respected (accept
 * compatible, reject incompatible), `output-layout.json` agrees with `requiredOutputs`, every
 * shipped template renders deterministically given a complete context, and rendering with an
 * incomplete context fails on the specific missing placeholder(s) rather than silently emitting
 * `{{ }}` into the output.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listTemplateLogicalPaths, loadPack, PackLoadError } from '../../backend/src/packs/pack-loader';
import { extractPlaceholders, renderTemplateStrict, UnresolvedPlaceholderError } from '../../backend/src/packs/template-renderer';

const PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packs', 'repository-goal-packet', 'v1');
const ENGINE_VERSION = '0.1.0';

describe('loadPack', () => {
  it('loads pack.json + output-layout.json and accepts a compatible engine version', async () => {
    const pack = await loadPack(PACK_DIR, ENGINE_VERSION);
    expect(pack.pack.id).toBe('repository-goal-packet');
    expect(pack.pack.requiredOutputs).toHaveLength(30);
    expect(pack.outputLayout.paths).toHaveLength(30);
  });

  it('rejects an incompatible engine version', async () => {
    await expect(loadPack(PACK_DIR, '1.5.0')).rejects.toBeInstanceOf(PackLoadError);
    await expect(loadPack(PACK_DIR, '0.0.9')).rejects.toBeInstanceOf(PackLoadError);
  });

  it('accepts every point inside the declared compatibleEngine range', async () => {
    await expect(loadPack(PACK_DIR, '0.1.0')).resolves.toBeDefined();
    await expect(loadPack(PACK_DIR, '0.9.9')).resolves.toBeDefined();
  });
});

describe('listTemplateLogicalPaths', () => {
  it('lists exactly the 9 numbered reports + 3 ledger/matrix/handoff + 3 prompts (15 templates)', async () => {
    const logicalPaths = await listTemplateLogicalPaths(PACK_DIR);
    expect(logicalPaths).toHaveLength(15);
    expect(logicalPaths).toContain('templates/00_START_HERE.md');
    expect(logicalPaths).toContain('templates/08_HUMAN_GATES.md');
    expect(logicalPaths).toContain('templates/FINDING_LEDGER.md');
    expect(logicalPaths).toContain('templates/VALIDATION_MATRIX.md');
    expect(logicalPaths).toContain('templates/FINAL_HANDOFF.md');
    expect(logicalPaths).toContain('prompts/MASTER_IMPLEMENTATION_PROMPT.md');
    expect(logicalPaths).toContain('prompts/PERSISTENT_GOAL.txt');
    expect(logicalPaths).toContain('prompts/REVIEW_PROMPT.md');
  });
});

describe('renderTemplateStrict against the real pack templates', () => {
  it('fails with the specific missing key when the context is incomplete', async () => {
    const pack = await loadPack(PACK_DIR, ENGINE_VERSION);
    const templateText = await pack.readTemplate('templates/01_EXECUTIVE_JUDGMENT.md');
    const placeholders = extractPlaceholders(templateText);
    expect(placeholders.length).toBeGreaterThan(0);

    // Provide every placeholder except one.
    const missingKey = placeholders[0]!;
    const partialValues = Object.fromEntries(placeholders.filter((p) => p !== missingKey).map((p) => [p, 'x']));

    try {
      renderTemplateStrict('templates/01_EXECUTIVE_JUDGMENT.md', templateText, partialValues);
      expect.unreachable('expected UnresolvedPlaceholderError');
    } catch (e) {
      expect(e).toBeInstanceOf(UnresolvedPlaceholderError);
      expect((e as UnresolvedPlaceholderError).unresolved).toEqual([missingKey]);
    }
  });

  it('renders deterministically given the same complete context twice', async () => {
    const pack = await loadPack(PACK_DIR, ENGINE_VERSION);
    const templateText = await pack.readTemplate('templates/05_MILESTONE.md');
    const placeholders = extractPlaceholders(templateText);
    const values = Object.fromEntries(placeholders.map((p) => [p, `value-for-${p}`]));

    const first = renderTemplateStrict('templates/05_MILESTONE.md', templateText, values);
    const second = renderTemplateStrict('templates/05_MILESTONE.md', templateText, values);
    expect(first).toBe(second);
    expect(first).not.toMatch(/\{\{[^{}]+\}\}/);
  });
});
