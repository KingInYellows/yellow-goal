/**
 * ZIP writer (`yazl`) and reader (`yauzl`) for packet archives. `07_PACKET_CONTRACT.md`
 * "Deterministic compilation" requires fixed entry mtimes so two compiles of the same logical
 * input are byte-comparable after normalizing only the manifest-declared timestamp fields —
 * every entry in a given archive gets the SAME injected `mtime`, never `new Date()`/`Date.now()`.
 *
 * `yazl`'s default per-entry file mode (`0o100664`, a plain regular file — see yazl's `Entry`
 * constructor) is used for every entry; nothing here ever sets a symlink mode, so a packet this
 * module produces can never itself contain a symlink entry. The reader side still treats symlink
 * detection as untrusted-input handling (an adversarial ZIP could be crafted by other tools),
 * which is why `readZipEntries` surfaces `externalFileAttributes` for the validator to check.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { ZipFile } from 'yazl';

export interface ZipSourceFile {
  /** Forward-slash entry path inside the archive (e.g. `contracts/request.json`). */
  entryPath: string;
  content: Buffer;
}

/** Symlink bit per the POSIX external-attribute convention yazl/yauzl both use:
 *  `(externalFileAttributes >>> 16) & 0xF000 === 0xA000` (S_IFLNK). */
export const SYMLINK_EXTERNAL_ATTR_MASK = 0xf000;
export const SYMLINK_EXTERNAL_ATTR_VALUE = 0xa000;

export function isSymlinkExternalAttributes(externalFileAttributes: number): boolean {
  return ((externalFileAttributes >>> 16) & SYMLINK_EXTERNAL_ATTR_MASK) === SYMLINK_EXTERNAL_ATTR_VALUE;
}

/** Writes `files` into a ZIP at `outputPath`, every entry stamped with the same `mtime` (so
 *  repeated compiles with the same injected clock produce byte-identical archive metadata).
 *  Entries are added in `files`' given order — callers must pass a stably-sorted list for
 *  deterministic output (this module does not sort). */
export async function writeZipArchive(outputPath: string, files: readonly ZipSourceFile[], mtime: Date): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const zip = new ZipFile();

  for (const file of files) {
    zip.addBuffer(file.content, file.entryPath, { mtime, mode: 0o100644 });
  }

  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve());
    zip.outputStream.on('error', reject);
  });
  zip.end();
  await done;

  await writeFile(outputPath, Buffer.concat(chunks));
}

export interface ReadZipEntry {
  entryPath: string;
  content: Buffer;
  externalFileAttributes: number;
  uncompressedSize: number;
}

export class ZipBombError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipBombError';
  }
}

/**
 * Reads every entry of the ZIP at `zipPath` into memory, enforcing `maxTotalInflatedBytes` as it
 * goes (throws {@link ZipBombError} the moment the running total would exceed it, without
 * finishing the inflation of an oversized entry). Entry order matches the archive's own order.
 */
export function readZipEntries(zipPath: string, maxTotalInflatedBytes: number): Promise<ReadZipEntry[]> {
  return new Promise((resolve, reject) => {
    const results: ReadZipEntry[] = [];
    let totalInflated = 0;

    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(openErr ?? new Error(`failed to open zip: ${zipPath}`));
        return;
      }

      const fail = (e: Error): void => {
        zipfile.close();
        reject(e);
      };

      zipfile.on('error', fail);
      zipfile.on('end', () => resolve(results));

      zipfile.on('entry', (entry) => {
        // Directory entries (trailing '/') carry no content; skip straight to the next one.
        if (entry.fileName.endsWith('/')) {
          zipfile.readEntry();
          return;
        }

        totalInflated += entry.uncompressedSize;
        if (totalInflated > maxTotalInflatedBytes) {
          fail(new ZipBombError(`zip inflation exceeds bound (${totalInflated} > ${maxTotalInflatedBytes} bytes) at entry "${entry.fileName}"`));
          return;
        }

        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            fail(streamErr ?? new Error(`failed to open read stream for "${entry.fileName}"`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', fail);
          stream.on('end', () => {
            results.push({
              entryPath: entry.fileName,
              content: Buffer.concat(chunks),
              externalFileAttributes: entry.externalFileAttributes,
              uncompressedSize: entry.uncompressedSize,
            });
            zipfile.readEntry();
          });
        });
      });

      zipfile.readEntry();
    });
  });
}
