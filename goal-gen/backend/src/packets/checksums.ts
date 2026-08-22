/**
 * SHA-256 hashing and `CHECKSUMS.sha256` rendering, in the GNU `sha256sum` text format
 * (`<64-hex-lowercase>  <path>\n`, two spaces) — the pack's `scripts/launch.sh`/`preflight.sh`
 * verify with `sha256sum -c CHECKSUMS.sha256 --quiet`, so the format must match exactly.
 */
import { createHash } from 'node:crypto';

export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface ChecksumEntry {
  /** Forward-slash path relative to the packet root (matches ZIP entry paths and
   *  `PacketManifest.files[].path`). */
  path: string;
  sha256: string;
}

/** Renders `entries` (already computed) as `CHECKSUMS.sha256` text, sorted by path for
 *  deterministic output regardless of the order hashes were computed in. */
export function renderChecksumsFile(entries: readonly ChecksumEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sorted.map((e) => `${e.sha256}  ${e.path}`).join('\n') + (sorted.length > 0 ? '\n' : '');
}

/** Parses a `CHECKSUMS.sha256` file's text back into entries (used by the post-extraction
 *  verifier). Rejects a malformed line rather than silently skipping it. */
export function parseChecksumsFile(text: string): ChecksumEntry[] {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error(`CHECKSUMS.sha256 line ${i + 1} is malformed: "${line}"`);
    return { sha256: match[1]!, path: match[2]! };
  });
}
