/**
 * `yellow-goal/run-approval/v1` record (ADR-0020, AGX-R3): what `run approve` mints and what the
 * verifier reads. Records are written with exclusive create and owner-only permissions and are
 * never overwritten. Pure data + fs — never spawns, never imports run-command or executors.
 */
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { RunApprovalError, type RunApprovalErrorCode } from './errors';
import { RunManifestSchema, computeManifestHash, type RunManifest } from './run-manifest';

export const RunApprovalSchemaVersion = 'yellow-goal/run-approval/v1' as const;

const MINUTE_MS = 60_000;

const RunApprovalRecordSchema = z
  .object({
    schemaVersion: z.literal(RunApprovalSchemaVersion),
    approvalId: z.string().uuid(),
    manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
    manifest: RunManifestSchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    // Also inside `manifest`: R3 lists it as a record field so a reader need not open the manifest,
    // and `parseRunApprovalRecord` refuses a record whose two copies disagree.
    engineVersion: z.string().min(1),
  })
  .strict();

export type RunApprovalRecord = z.infer<typeof RunApprovalRecordSchema>;

/** The production clock behind every injectable approval `clock` — never inline `Date.now()`. */
export const systemClock = (): Date => new Date();

/** Throws the coded approval refusal; shared by the record parser and the verifier. */
export function refuseApproval(code: RunApprovalErrorCode, message: string, details?: unknown): never {
  throw new RunApprovalError(code, message, details);
}

export type MintOptions = {
  /** Injectable clock; defaults to `systemClock`. */
  clock?: () => Date;
  newId?: () => string;
};

/** Mints a record for `manifest`. The manifest is re-validated here rather than trusted from its
 *  compile-time type, so a hand-built or spread object can never be approved unchecked. */
export function mintRunApprovalRecord(candidate: RunManifest, options: MintOptions = {}): RunApprovalRecord {
  const parsed = RunManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    refuseApproval('MANIFEST_INVALID', `invalid run manifest: ${parsed.error.issues[0]?.message ?? 'unknown'}`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  const manifest = parsed.data;
  const createdAt = (options.clock ?? systemClock)();
  const expiresAt = new Date(createdAt.getTime() + manifest.expiresInMinutes * MINUTE_MS);
  return {
    schemaVersion: RunApprovalSchemaVersion,
    approvalId: (options.newId ?? randomUUID)(),
    manifestHash: computeManifestHash(manifest),
    manifest,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    engineVersion: manifest.engineVersion,
  };
}

function invalid(message: string, details?: unknown): never {
  refuseApproval('APPROVAL_INVALID', message, details);
}

/**
 * Parses and self-checks a record: schema, hash over its own manifest, engine identity, and an
 * `expiresAt` that is exactly `createdAt + manifest.expiresInMinutes` (a hand-lengthened expiry is
 * invalid, not merely unexpired).
 */
export function parseRunApprovalRecord(raw: string): RunApprovalRecord {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw) as unknown;
  } catch (err) {
    invalid(`approval is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = RunApprovalRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    invalid('approval does not match yellow-goal/run-approval/v1', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  const record = parsed.data;
  if (record.manifestHash !== computeManifestHash(record.manifest)) {
    invalid('approval manifestHash does not match its own manifest');
  }
  if (record.engineVersion !== record.manifest.engineVersion) {
    invalid('approval engineVersion does not match its manifest');
  }
  const expected = Date.parse(record.createdAt) + record.manifest.expiresInMinutes * MINUTE_MS;
  if (Date.parse(record.expiresAt) !== expected) {
    invalid('approval expiresAt is not createdAt + manifest.expiresInMinutes');
  }
  return record;
}

/**
 * Creates `filePath` with `O_EXCL|O_NOFOLLOW` and owner-only mode 0600, writes `data`, fsyncs the
 * file, closes, then fsyncs its directory so the new entry itself survives a host crash — only
 * then is the write reported durable. Throws the raw `EEXIST` errno error when the path exists —
 * that atomic failure is what single-use consumption relies on — and `ELOOP` when it is a
 * symlink. `fchmod` makes the mode umask-proof. If anything fails after this call created the
 * file, the file is removed so a retry is not refused as existing; if that removal also fails,
 * the rethrown error says so.
 */
export async function writeFileExclusive(filePath: string, data: string): Promise<void> {
  const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    await fsyncDirectory(path.dirname(filePath));
  } catch (err) {
    await handle.close().catch(() => undefined);
    try {
      await unlink(filePath);
    } catch (cleanupErr) {
      throw new Error(`write to ${String(filePath)} failed and the partial file could not be removed`, {
        cause: new AggregateError([err, cleanupErr]),
      });
    }
    throw err;
  }
}

/** fsyncs a directory so entries created in it (a new file or subdirectory) survive a host crash. */
export async function fsyncDirectory(dirPath: string): Promise<void> {
  const handle = await open(dirPath, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function isErrnoCode(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === code;
}

/** `{ path, errno }` refusal details for a filesystem error. */
export function errnoDetails(filePath: string, err: unknown): { path: string; errno: string } {
  return { path: filePath, errno: err instanceof Error && 'code' in err ? String(err.code) : 'UNKNOWN' };
}
