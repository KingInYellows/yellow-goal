/**
 * Deterministic JSON rendering for compiler-mode outputs (07_PACKET_CONTRACT.md "Deterministic
 * compilation": same inputs + engine + pack must produce logically identical files). Plain
 * `JSON.stringify` does not guarantee key order across engines/inputs, so every canonical
 * contract file (contracts/*.json, MANIFEST.json) must go through this helper instead.
 */

/** Recursively sorts object keys (arrays keep their element order — order is meaningful there). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeysDeep(v)] as const);
    return Object.fromEntries(sortedEntries);
  }
  return value;
}

/**
 * Renders `value` as canonical JSON: recursively sorted object keys, 2-space indent, `\n` line
 * endings (never `\r\n`, regardless of host OS), single trailing newline. Byte-comparable across
 * two compiles of the same logical input.
 */
export function canonicalJson(value: unknown): string {
  const sorted = sortKeysDeep(value);
  const withUnixNewlines = JSON.stringify(sorted, null, 2).replace(/\r\n/g, '\n');
  return `${withUnixNewlines}\n`;
}

/** Same as {@link canonicalJson} but for one JSON value per line (evidence.jsonl-style ledgers). */
export function canonicalJsonLines(values: readonly unknown[]): string {
  return values.map((v) => JSON.stringify(sortKeysDeep(v))).join('\n') + (values.length > 0 ? '\n' : '');
}
