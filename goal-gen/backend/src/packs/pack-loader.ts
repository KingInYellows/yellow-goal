/**
 * Loads a versioned pack directory (`packs/repository-goal-packet/v1/`): validates `pack.json`,
 * checks engine-version compatibility (fails on incompatible — 08_PACK_SYSTEM.md "Pack
 * resolution"), and exposes template/prompt/script file access. Pure filesystem + validation;
 * no rendering logic lives here (that's `template-renderer.ts`).
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { satisfiesRange } from './semver-range';

const PackJsonSchema = z
  .object({
    schemaVersion: z.literal('yellow-goal/pack/v1'),
    id: z.string().min(1),
    version: z.string().min(1),
    description: z.string(),
    compatibleEngine: z.string().min(1),
    requiredSchemas: z.record(z.string()),
    defaultPolicy: z.string(),
    requiredOutputs: z.array(z.string()).min(1),
  })
  .strict();
export type PackJson = z.infer<typeof PackJsonSchema>;

const OutputLayoutSchema = z
  .object({
    schemaVersion: z.literal('yellow-goal/output-layout/v1'),
    paths: z.array(z.string()).min(1),
  })
  .strict();
export type OutputLayout = z.infer<typeof OutputLayoutSchema>;

/** Thrown when a pack's `pack.json` fails schema validation, is version-incompatible with the
 *  running engine, or its `output-layout.json` disagrees with `pack.json`'s `requiredOutputs`. */
export class PackLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackLoadError';
  }
}

export interface LoadedPack {
  packDir: string;
  pack: PackJson;
  outputLayout: OutputLayout;
  /** Reads a template/prompt file by its packet-relative logical path (e.g.
   *  `templates/00_START_HERE.md`, `prompts/MASTER_IMPLEMENTATION_PROMPT.md`), appending the
   *  on-disk `.tmpl` suffix internally. Throws if the file is missing. */
  readTemplate(logicalPath: string): Promise<string>;
  /** Reads a non-templated pack asset verbatim by its packet-relative path (e.g.
   *  `scripts/launch.sh`, `policies/compiler-read-only.json`). No `.tmpl` suffix handling. */
  readAsset(relativePath: string): Promise<string>;
}

async function readJson<T>(filePath: string, schema: z.ZodType<T>, label: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    throw new PackLoadError(`${label}: cannot read ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new PackLoadError(`${label}: ${filePath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new PackLoadError(`${label}: ${filePath} failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Loads and validates the pack at `packDir`, checking `engineVersion` against `pack.json`'s
 * `compatibleEngine` range. Throws {@link PackLoadError} on any incompatibility — never resolves
 * a pack the engine cannot support.
 */
export async function loadPack(packDir: string, engineVersion: string): Promise<LoadedPack> {
  const pack = await readJson(path.join(packDir, 'pack.json'), PackJsonSchema, 'pack.json');
  const outputLayout = await readJson(
    path.join(packDir, 'output-layout.json'),
    OutputLayoutSchema,
    'output-layout.json',
  );

  if (!satisfiesRange(engineVersion, pack.compatibleEngine)) {
    throw new PackLoadError(
      `pack "${pack.id}@${pack.version}" requires engine ${pack.compatibleEngine}, but the running engine is ${engineVersion}`,
    );
  }

  const packRequired = [...pack.requiredOutputs].sort();
  const layoutPaths = [...outputLayout.paths].sort();
  if (JSON.stringify(packRequired) !== JSON.stringify(layoutPaths)) {
    throw new PackLoadError(
      `pack.json requiredOutputs and output-layout.json paths disagree for "${pack.id}@${pack.version}"`,
    );
  }

  return {
    packDir,
    pack,
    outputLayout,
    async readTemplate(logicalPath: string): Promise<string> {
      const onDiskPath = path.join(packDir, `${logicalPath}.tmpl`);
      try {
        return await readFile(onDiskPath, 'utf8');
      } catch (e) {
        throw new PackLoadError(
          `template "${logicalPath}" not found at ${onDiskPath}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    async readAsset(relativePath: string): Promise<string> {
      const onDiskPath = path.join(packDir, relativePath);
      try {
        return await readFile(onDiskPath, 'utf8');
      } catch (e) {
        throw new PackLoadError(
          `asset "${relativePath}" not found at ${onDiskPath}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}

/** Lists every `.tmpl` file under `packDir/templates` and `packDir/prompts`, as logical paths
 *  (`.tmpl` suffix stripped, forward-slash-joined, relative to `packDir`). Used by tests that
 *  assert every template renders without an unresolved required placeholder. */
export async function listTemplateLogicalPaths(packDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const subdir of ['templates', 'prompts']) {
    const dir = path.join(packDir, subdir);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.tmpl')) {
        out.push(`${subdir}/${entry.slice(0, -'.tmpl'.length)}`);
      }
    }
  }
  return out.sort();
}
