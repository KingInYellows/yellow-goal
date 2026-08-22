import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const supportDir = path.dirname(fileURLToPath(import.meta.url));
const schemasRoot = path.resolve(supportDir, '../../../schemas');

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

export function loadVendoredSchema(name: string): Record<string, unknown> {
  return readJson(path.join(schemasRoot, 'vendored', `${name}.schema.json`));
}

export function loadAppSchema(name: string): Record<string, unknown> {
  return readJson(path.join(schemasRoot, 'app', `${name}.schema.json`));
}
