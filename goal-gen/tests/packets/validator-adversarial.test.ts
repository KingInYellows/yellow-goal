/**
 * Adversarial fixtures: hand-crafted ZIPs asserting `verifyZipPacket` rejects each with the
 * SPECIFIC check id/reason, never a generic failure. Fixtures are built at test time with `yazl`
 * (checked-in generation code, per the worker charter — preferred over binary blobs) into a temp
 * dir per test.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { createAnalyzeRepository, RecordedAnalysisProvider } from '../../backend/src/analysis';
import { createCompilePacket, sha256Hex, verifyExtractedDirectory, verifyZipPacket } from '../../backend/src/packets';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'analysis', 'node-plugin');
const PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packs', 'repository-goal-packet', 'v1');
const FIXED_CLOCK = (): Date => new Date('2026-08-22T00:00:00.000Z');

/** Builds a ZIP from `entries` (one per `{ path, content, mode }`) and returns its raw bytes. A
 *  symlink entry is produced by passing a POSIX symlink mode (`0o120000 << 16` external attrs via
 *  yazl's `mode` option — yazl computes `externalFileAttributes = (mode << 16) >>> 0`). */
async function buildZipBuffer(entries: { path: string; content: Buffer; mode?: number }[]): Promise<Buffer> {
  const zip = new ZipFile();
  for (const entry of entries) {
    zip.addBuffer(entry.content, entry.path, entry.mode !== undefined ? { mode: entry.mode } : {});
  }
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve());
    zip.outputStream.on('error', reject);
  });
  zip.end();
  await done;
  return Buffer.concat(chunks);
}

async function buildZip(zipPath: string, entries: { path: string; content: Buffer; mode?: number }[]): Promise<void> {
  await writeFile(zipPath, await buildZipBuffer(entries));
}

const MINIMAL_MANIFEST = Buffer.from(JSON.stringify({ files: [] }));
const MINIMAL_CHECKSUMS = Buffer.from('');

/**
 * `yazl` itself refuses to add an entry with a `../`-traversal or absolute metadata path
 * (`validateMetadataPath` throws) — a defensive property of the real writer this compiler uses,
 * but it means an adversarial fixture with such a path cannot be built through the normal
 * `addBuffer` API at all. Instead: build the archive with a same-length, well-formed placeholder
 * name, then patch the raw bytes, replacing every occurrence of the placeholder's ASCII bytes
 * with the malicious name's bytes. Because the names are the same length, every other length
 * field and offset in the ZIP structure (local file header, central directory) stays valid — only
 * the filename bytes themselves change.
 */
function patchEntryName(zipBuffer: Buffer, placeholder: string, malicious: string): Buffer {
  if (placeholder.length !== malicious.length) {
    throw new Error(`patchEntryName requires equal-length names: "${placeholder}" vs "${malicious}"`);
  }
  const patched = Buffer.from(zipBuffer);
  const needle = Buffer.from(placeholder, 'utf8');
  const replacement = Buffer.from(malicious, 'utf8');
  let occurrences = 0;
  let index = patched.indexOf(needle);
  while (index !== -1) {
    replacement.copy(patched, index);
    occurrences++;
    index = patched.indexOf(needle, index + needle.length);
  }
  // Expect exactly 2: local file header + central directory record.
  if (occurrences !== 2) {
    throw new Error(`expected 2 occurrences of "${placeholder}" (local header + central directory), found ${occurrences}`);
  }
  return patched;
}

describe('verifyZipPacket — adversarial fixtures', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'adversarial-zip-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Cases a/b: `yauzl` itself refuses to parse an entry with a `../`-traversal or absolute path
  // as a normal directory entry — it emits an `error` event while reading entries (message
  // "invalid relative path: ..." / "absolute path: ..."), which `readZipEntries` turns into a
  // rejected promise. That surfaces here as the `zip-readable` check failing (the read never gets
  // far enough to run this module's own `no-path-traversal` check on that entry) — still a
  // specific, correct rejection, just caught one layer earlier than a hand-rolled reader would.

  it('a. rejects a path-traversal entry ("../evil")', async () => {
    const zipPath = path.join(dir, 'a.zip');
    const buffer = await buildZipBuffer([
      { path: 'MANIFEST.json', content: MINIMAL_MANIFEST },
      { path: 'CHECKSUMS.sha256', content: MINIMAL_CHECKSUMS },
      { path: 'xx/evil.txt', content: Buffer.from('evil') },
    ]);
    await writeFile(zipPath, patchEntryName(buffer, 'xx/evil.txt', '../evil.txt'));

    const result = await verifyZipPacket(zipPath);
    expect(result.overall).toBe('failed');
    const check = result.checks.find((c) => c.id === 'zip-readable');
    expect(check?.status).toBe('failed');
    expect(check?.details).toMatch(/relative path|\.\.\/evil\.txt/i);
  });

  it('b. rejects an absolute-path entry', async () => {
    const zipPath = path.join(dir, 'b.zip');
    const buffer = await buildZipBuffer([
      { path: 'MANIFEST.json', content: MINIMAL_MANIFEST },
      { path: 'CHECKSUMS.sha256', content: MINIMAL_CHECKSUMS },
      { path: 'xxtcxpasswd', content: Buffer.from('evil') },
    ]);
    await writeFile(zipPath, patchEntryName(buffer, 'xxtcxpasswd', '/etc/passwd'));

    const result = await verifyZipPacket(zipPath);
    expect(result.overall).toBe('failed');
    const check = result.checks.find((c) => c.id === 'zip-readable');
    expect(check?.status).toBe('failed');
    expect(check?.details).toMatch(/absolute path|\/etc\/passwd/i);
  });

  it('c. rejects a symlink entry (external attrs 0xA000)', async () => {
    const zipPath = path.join(dir, 'c.zip');
    const symlinkMode = 0o120777; // S_IFLNK | rwxrwxrwx
    await buildZip(zipPath, [
      { path: 'MANIFEST.json', content: MINIMAL_MANIFEST },
      { path: 'CHECKSUMS.sha256', content: MINIMAL_CHECKSUMS },
      { path: 'evil-link', content: Buffer.from('/etc/passwd'), mode: symlinkMode },
    ]);
    const result = await verifyZipPacket(zipPath);
    const check = result.checks.find((c) => c.id === 'no-symlinks');
    expect(check?.status).toBe('failed');
    expect(check?.details).toContain('evil-link');
  });

  it('d. rejects duplicate entry names', async () => {
    const zipPath = path.join(dir, 'd.zip');
    await buildZip(zipPath, [
      { path: 'MANIFEST.json', content: MINIMAL_MANIFEST },
      { path: 'CHECKSUMS.sha256', content: MINIMAL_CHECKSUMS },
      { path: '00_START_HERE.md', content: Buffer.from('first') },
      { path: '00_START_HERE.md', content: Buffer.from('second') },
    ]);
    const result = await verifyZipPacket(zipPath);
    const check = result.checks.find((c) => c.id === 'no-duplicate-entries');
    expect(check?.status).toBe('failed');
    expect(check?.details).toContain('00_START_HERE.md');
  });

  it('e. rejects a checksum-tampered file (recorded hash no longer matches content)', async () => {
    const zipPath = path.join(dir, 'e.zip');
    const content = Buffer.from('original content');
    const wrongHash = sha256Hex(Buffer.from('different content'));
    await buildZip(zipPath, [
      { path: 'MANIFEST.json', content: Buffer.from(JSON.stringify({ files: [{ path: '00_START_HERE.md', sha256: wrongHash }] })) },
      { path: 'CHECKSUMS.sha256', content: Buffer.from(`${wrongHash}  00_START_HERE.md\n`) },
      { path: '00_START_HERE.md', content },
    ]);
    const result = await verifyZipPacket(zipPath);
    const check = result.checks.find((c) => c.id === 'checksums-recompute');
    expect(check?.status).toBe('failed');
    expect(check?.details).toContain('checksum mismatch');
  });

  it('f. rejects a manifest/file-list divergence (manifest references a file not in the archive)', async () => {
    const zipPath = path.join(dir, 'f.zip');
    await buildZip(zipPath, [
      { path: 'MANIFEST.json', content: Buffer.from(JSON.stringify({ files: [{ path: 'ghost.md', sha256: 'a'.repeat(64) }] })) },
      { path: 'CHECKSUMS.sha256', content: Buffer.from(`${'a'.repeat(64)}  ghost.md\n`) },
    ]);
    const result = await verifyZipPacket(zipPath);
    const check = result.checks.find((c) => c.id === 'checksums-recompute');
    expect(check?.status).toBe('failed');
    expect(check?.details).toContain('not in archive');
  });

  it('g. rejects an oversized-inflation entry (bounded total inflated size exceeded)', async () => {
    const zipPath = path.join(dir, 'g.zip');
    // yazl reports uncompressedSize from the buffer it was given, so a real oversized buffer is
    // needed to exercise the bound — use a buffer just over a tiny test-only bound.
    const bigContent = Buffer.alloc(1024, 'x');
    await buildZip(zipPath, [
      { path: 'MANIFEST.json', content: MINIMAL_MANIFEST },
      { path: 'CHECKSUMS.sha256', content: MINIMAL_CHECKSUMS },
      { path: 'big.bin', content: bigContent },
    ]);

    // Import the low-level reader directly to pass a tiny bound (verifyZipPacket's own bound is
    // generous — this test proves the bound is enforced, not that 1KB is unreasonable).
    const { readZipEntries, ZipBombError } = await import('../../backend/src/packets/archive');
    await expect(readZipEntries(zipPath, 512)).rejects.toBeInstanceOf(ZipBombError);
  });

  it('tamper test: flipping one byte of a real compiled packet fails checksum verification', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'tamper-'));
    try {
      const analyze = createAnalyzeRepository(new RecordedAnalysisProvider(FIXTURE_DIR), FIXED_CLOCK);
      const analyzeResult = await analyze({
        requestPath: path.join(FIXTURE_DIR, 'request.json'),
        repoProfilePath: path.join(FIXTURE_DIR, 'repository-profile.json'),
        outputDir: path.join(workDir, 'analysis'),
      });
      const compile = createCompilePacket({ clock: FIXED_CLOCK, packDirOverride: PACK_DIR });
      const compileResult = await compile({
        requestPath: path.join(FIXTURE_DIR, 'request.json'),
        assessmentPath: analyzeResult.assessmentPath,
        pack: 'repository-goal-packet@1',
        outputDir: path.join(workDir, 'compiled'),
      });

      const before = await verifyZipPacket(compileResult.packetPath);
      expect(before.overall).toBe('passed');

      // Flip one byte in the middle of the ZIP file (well past the local file header of the
      // first entry) and re-verify.
      const bytes = await readFile(compileResult.packetPath);
      const mutated = Buffer.from(bytes);
      const flipAt = Math.floor(mutated.length / 2);
      mutated[flipAt] = mutated[flipAt]! ^ 0xff;
      const tamperedPath = `${compileResult.packetPath}.tampered.zip`;
      await writeFile(tamperedPath, mutated);

      const after = await verifyZipPacket(tamperedPath);
      expect(after.overall).toBe('failed');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe('verifyExtractedDirectory — path containment (directory input)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'adversarial-dir-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a MANIFEST.json that is valid JSON but omits required contract fields', async () => {
    await writeFile(path.join(dir, 'MANIFEST.json'), JSON.stringify({ files: [] }));
    await writeFile(path.join(dir, 'CHECKSUMS.sha256'), '');
    const result = await verifyExtractedDirectory(dir);
    expect(result.overall).toBe('failed');
    const check = result.checks.find((c) => c.id === 'manifest-schema');
    expect(check?.status).toBe('failed');
  });

  it('rejects a MANIFEST.json whose files[].sha256 disagrees with CHECKSUMS.sha256', async () => {
    await writeFile(path.join(dir, '00_START_HERE.md'), 'content');
    const goodHash = sha256Hex('content');
    const badHash = 'b'.repeat(64);
    const manifest = JSON.stringify({ files: [{ path: '00_START_HERE.md', sha256: badHash }] });
    await writeFile(path.join(dir, 'MANIFEST.json'), manifest);
    const manifestHash = sha256Hex(manifest);
    await writeFile(path.join(dir, 'CHECKSUMS.sha256'), `${goodHash}  00_START_HERE.md\n${manifestHash}  MANIFEST.json\n`);

    const result = await verifyExtractedDirectory(dir);
    expect(result.overall).toBe('failed');
    const check = result.checks.find((c) => c.id === 'manifest-hashes-match-checksums');
    expect(check?.status).toBe('failed');
    expect(check?.details).toContain('00_START_HERE.md');
  });

  it('rejects a CHECKSUMS.sha256 entry whose path escapes the packet root (dir input, unlike the zip path yauzl pre-filters)', async () => {
    await writeFile(path.join(dir, '00_START_HERE.md'), 'content');
    const goodHash = sha256Hex('content');
    await writeFile(
      path.join(dir, 'MANIFEST.json'),
      JSON.stringify({ files: [{ path: '00_START_HERE.md', sha256: goodHash }] }),
    );
    // A CHECKSUMS.sha256 that references a path escaping the packet root — this cannot come from
    // this compiler (canonical entries are always relative, non-traversal), but a hand-edited or
    // maliciously substituted CHECKSUMS.sha256 could claim one.
    await writeFile(
      path.join(dir, 'CHECKSUMS.sha256'),
      `${goodHash}  00_START_HERE.md\n${'a'.repeat(64)}  ../outside.txt\n`,
    );

    const result = await verifyExtractedDirectory(dir);
    expect(result.overall).toBe('failed');
    const check = result.checks.find((c) => c.id === 'checksums-recompute');
    expect(check?.status).toBe('failed');
    expect(check?.details).toContain('escapes packet root');
  });
});
