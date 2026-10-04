/**
 * Pre-spawn approval verification and single-use consumption (ADR-0020, AGX-R4/R5/R6).
 *
 * The real-run path must call, in order: `verifyRunApproval` (recomputed manifest vs. approval) →
 * its own remaining refusals → `consumeRunApproval` → spawn. Nothing may spawn before consumption,
 * and consumption is final regardless of the run's outcome (including cancel). Never spawns,
 * never imports run-command or executors.
 *
 * Consumption is keyed by `approvalId` in an engine state directory, not by the approval's path,
 * so copying or linking an approval file cannot replay it (ADR-0020).
 */
import { access, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { errnoDetails, fsyncDirectory, isErrnoCode, parseRunApprovalRecord, refuseApproval as refuse, systemClock, writeFileExclusive } from './run-approval';
import { computeManifestHash, type RunManifest } from './run-manifest';

/** Tolerated clock skew for a record's `createdAt` being ahead of this host's clock. */
const CREATED_AT_SKEW_MS = 5 * 60_000;

declare const verifiedApprovalBrand: unique symbol;

/** What a verified approval hands the real run. `approvalId` is carried into `run.start`, the
 *  spend ledger, and the terminal outcome (AGX-R6). Branded: only `verifyRunApproval` produces
 *  one, so `consumeRunApproval` cannot be handed an unverified object of the same shape. */
export type VerifiedApproval = {
  approvalId: string;
  manifestHash: string;
  manifest: RunManifest;
  expiresAt: string;
  approvalPath: string;
} & { readonly [verifiedApprovalBrand]: true };

/** Where consumption markers live; tests inject a temp dir, production uses the default. */
export type ApprovalStateOptions = { stateDir?: string };

export type VerifyRunApprovalInput = ApprovalStateOptions & {
  approvalPath: string | undefined;
  /** The manifest recomputed from the ACTUAL invocation — never the one stored in the approval. */
  expectedManifest: RunManifest;
  engineVersion: string;
  clock?: () => Date;
};

/** `$XDG_STATE_HOME/yellow-goal`, else `~/.local/state/yellow-goal`. A relative `XDG_STATE_HOME`
 *  is ignored (XDG spec), so markers never depend on the current directory. */
export function defaultApprovalStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(homedir(), '.local', 'state');
  return path.join(base, 'yellow-goal');
}

/** The consumption marker for one approval; its atomic exclusive create is the single-use guarantee.
 *  `approvalId` is schema-validated as a UUID, so it is a safe file name; it is lower-cased because
 *  UUIDs are case-insensitive and a re-cased id must not name a fresh marker. */
export function approvalMarkerPath(approvalId: string, options: ApprovalStateOptions = {}): string {
  return path.join(options.stateDir ?? defaultApprovalStateDir(), 'consumed', approvalId.toLowerCase());
}

/** A state-dir that cannot be read or written refuses the run (fail closed) with its own code. */
function stateUnavailable(filePath: string, err: unknown): never {
  refuse('APPROVAL_STATE_UNAVAILABLE', `approval state at ${filePath} is unavailable: ${err instanceof Error ? err.message : String(err)}`, errnoDetails(filePath, err));
}

/** Marker presence; only ENOENT means absent — any other error refuses rather than guessing. */
async function markerExists(markerPath: string): Promise<boolean> {
  try {
    await access(markerPath);
    return true;
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return false;
    stateUnavailable(markerPath, err);
  }
}

function assertUnexpired(now: number, expiresAt: string): void {
  if (now >= Date.parse(expiresAt)) refuse('APPROVAL_EXPIRED', `approval expired at ${expiresAt}`, { expiresAt });
}

export async function verifyRunApproval(input: VerifyRunApprovalInput): Promise<VerifiedApproval> {
  const { approvalPath } = input;
  if (approvalPath === undefined || approvalPath === '') refuse('APPROVAL_MISSING', 'no approval path was supplied');

  let raw: string;
  try {
    raw = await readFile(approvalPath, 'utf8');
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) refuse('APPROVAL_MISSING', `approval ${approvalPath} does not exist`, { path: approvalPath });
    refuse('APPROVAL_INVALID', `cannot read approval ${approvalPath}: ${err instanceof Error ? err.message : String(err)}`, errnoDetails(approvalPath, err));
  }
  const record = parseRunApprovalRecord(raw);
  const now = (input.clock ?? systemClock)().getTime();

  // A record dated in the future would otherwise stay valid past the 60-minute ceiling (the record
  // parser already pins expiresAt = createdAt + expiresInMinutes <= 60).
  if (Date.parse(record.createdAt) > now + CREATED_AT_SKEW_MS) {
    refuse('APPROVAL_INVALID', `approval createdAt ${record.createdAt} is in the future`);
  }
  // Engine before hash: the engine version is inside the manifest, so a hash check first would
  // mask the more specific refusal.
  if (record.engineVersion !== input.engineVersion) {
    refuse('APPROVAL_ENGINE_MISMATCH', `approval was minted by engine ${record.engineVersion}, this is ${input.engineVersion}`, {
      approved: record.engineVersion,
      actual: input.engineVersion,
    });
  }
  const expectedHash = computeManifestHash(input.expectedManifest);
  if (record.manifestHash !== expectedHash) {
    refuse('APPROVAL_HASH_MISMATCH', 'this invocation does not match the approved manifest', {
      approved: record.manifestHash,
      actual: expectedHash,
    });
  }
  assertUnexpired(now, record.expiresAt);
  // Early, friendlier refusal; `consumeRunApproval` is the authoritative (atomic) check.
  if (await markerExists(approvalMarkerPath(record.approvalId, input))) {
    refuse('APPROVAL_CONSUMED', `approval ${record.approvalId} was already used`, { approvalId: record.approvalId });
  }
  return {
    approvalId: record.approvalId,
    manifestHash: record.manifestHash,
    manifest: record.manifest,
    expiresAt: record.expiresAt,
    approvalPath,
  } as VerifiedApproval;
}

/**
 * Consumes the approval exactly once. Call after every other refusal and before any spawn. Expiry
 * is re-checked here: other refusals run between verify and consume, and an approval that lapses
 * in that window must not be spent.
 */
export async function consumeRunApproval(
  verified: VerifiedApproval,
  options: ApprovalStateOptions & { clock?: () => Date } = {},
): Promise<void> {
  const now = (options.clock ?? systemClock)();
  assertUnexpired(now.getTime(), verified.expiresAt);
  const markerPath = approvalMarkerPath(verified.approvalId, options);
  const consumedDir = path.dirname(markerPath);
  let firstCreated: string | undefined;
  try {
    firstCreated = await mkdir(consumedDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    stateUnavailable(consumedDir, err);
  }
  // Every directory this call created must be durable before the marker is written, or a host
  // crash could drop the whole state-dir chain (and the marker with it) and let the still-unexpired
  // approval run again. A failure here happens before consumption, so nothing is spent.
  for (const dir of newlyCreatedDirParents(consumedDir, firstCreated)) {
    try {
      await fsyncDirectory(dir);
    } catch (err) {
      stateUnavailable(dir, err);
    }
  }
  // `writeFileExclusive` fsyncs the marker and its directory entry before returning.
  const marker = { approvalId: verified.approvalId, manifestHash: verified.manifestHash, approvalPath: verified.approvalPath, consumedAt: now.toISOString() };
  try {
    await writeFileExclusive(markerPath, `${JSON.stringify(marker)}\n`);
  } catch (err) {
    if (isErrnoCode(err, 'EEXIST')) {
      refuse('APPROVAL_CONSUMED', `approval ${verified.approvalId} was already used`, { approvalId: verified.approvalId });
    }
    stateUnavailable(markerPath, err);
  }
}

/**
 * The parents whose entries changed because `mkdir -p` created `firstCreated`…`leaf`: the parent of
 * each newly created directory, from `leaf`'s parent up to `firstCreated`'s parent. Empty when
 * nothing was created.
 */
export function newlyCreatedDirParents(leaf: string, firstCreated: string | undefined): string[] {
  if (firstCreated === undefined) return [];
  const parents: string[] = [];
  let dir = path.resolve(leaf);
  const top = path.resolve(firstCreated);
  for (;;) {
    parents.push(path.dirname(dir));
    if (dir === top || path.dirname(dir) === dir) return parents;
    dir = path.dirname(dir);
  }
}
