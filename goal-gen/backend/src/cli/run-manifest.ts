/**
 * Real-run manifest (ADR-0020, AGX-R1): the deterministic, offline description of exactly what a
 * human approves before any real `claude` spend. Never spawns, never touches the network, never
 * imports run-command, executors, or the orchestrator loop. Its only filesystem access is
 * resolving the evidence destinations' parent directories to canonical paths (AGX-R8a).
 *
 * `expiresInMinutes` is relative on purpose: the manifest (and so `manifestHash`) must be
 * byte-identical across `run manifest`, `run approve`, and the later real-run recompute; the
 * absolute `expiresAt` lives only on the approval record.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { RepositoryGoalRequest } from '../contracts/request';
import {
  ACTION_TIMEOUT_MS,
  DEFAULT_MODEL,
  MAX_BUDGET_USD,
  REAL_RUN_ACTION_TIMEOUT_MS,
  REAL_RUN_WALL_CLOCK_MS,
  RUN_WALL_CLOCK_MS,
} from '../orchestrator/guardrails';
import { canonicalJson } from '../packs/canonical-json';
import { sha256Hex } from '../packets/checksums';
import { candidateProfileDigest, getCandidateOfflineProfile, type CandidateOfflineProfile } from './candidate-offline-profiles';
import { RunApprovalError } from './errors';
import { ProviderProtocolV2 } from './provider-capabilities';

export const RunManifestSchemaVersion = 'yellow-goal/run-manifest/v1' as const;
/** Protocol the approved real run speaks; owned by `provider-capabilities` (direction: manifest → capabilities). */
export const RealRunProtocolId = ProviderProtocolV2;
/** Default and ceiling for approval lifetime; a manifest may shorten it, never lengthen it (AGX-R3). */
export const RUN_APPROVAL_MAX_EXPIRY_MINUTES = 60;

const HEX64 = /^[0-9a-f]{64}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/**
 * A Claude Code tool rule: a tool name (`Edit`, `mcp__srv__tool`) optionally followed by one
 * parenthesised printable-ASCII specifier without nested parentheses (`Bash(git status:*)`), so
 * one entry cannot smuggle a second rule. The leading letter means no entry
 * can be read as a CLI flag when the list is later passed as `--allowedTools` argv, and ASCII-only
 * keeps the ceremony display free of bidi/zero-width look-alikes.
 */
const TOOL_RULE = /^[A-Za-z][A-Za-z0-9_]*(\([\x20-\x27\x2a-\x7e]*\))?$/;

const ToolNameSchema = z.string().regex(TOOL_RULE, 'expected a tool name like Edit or Bash(git status:*)');

/** An absolute path already in canonical form (`path.resolve` leaves it unchanged), never a root. */
const CanonicalPathSchema = z
  .string()
  .refine(
    (value) => path.isAbsolute(value) && path.resolve(value) === value && path.parse(value).root !== value,
    'must be an absolute canonical path that is not a filesystem root',
  );

/** Where a real run writes its evidence (AGX-R8a): approved with the manifest, never chosen later. */
const EvidenceDestinationsSchema = z
  .object({ bundleDir: CanonicalPathSchema, spendLedgerPath: CanonicalPathSchema })
  .strict();

/** Lexical containment of canonical absolute paths: `child` is `parent` or below it. */
export function isSameOrInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export const RunManifestSchema = z
  .object({
    schemaVersion: z.literal(RunManifestSchemaVersion),
    engineVersion: z.string().min(1),
    protocolId: z.literal(RealRunProtocolId),
    profile: z
      .object({ id: z.string().min(1), version: z.string().min(1), digest: z.string().regex(HEX64) })
      .strict(),
    requestHash: z.string().regex(HEX64),
    model: z.string().regex(MODEL_NAME),
    // The only representable mode: no wider permission mode can be expressed by a manifest (AGX-R11).
    permissionMode: z.literal('acceptEdits'),
    allowedTools: z.array(ToolNameSchema).min(1),
    disallowedTools: z.array(ToolNameSchema),
    maxTurns: z.number().int().positive(),
    caps: z.object({ perActionUsd: z.number().positive(), totalUsd: z.number().positive() }).strict(),
    actionTimeoutMs: z.number().int().positive(),
    runWallClockMs: z.number().int().positive(),
    authMode: z.enum(['subscription', 'api-key']),
    attemptCount: z.literal(1),
    expiresInMinutes: z.number().int().min(1).max(RUN_APPROVAL_MAX_EXPIRY_MINUTES),
    evidence: EvidenceDestinationsSchema,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    // ADR-0010 ceilings: a manifest may lower caps, never raise them (AGX-R12).
    if (manifest.caps.totalUsd > MAX_BUDGET_USD) {
      ctx.addIssue({ code: 'custom', path: ['caps', 'totalUsd'], message: `must be <= ${MAX_BUDGET_USD}` });
    }
    if (manifest.caps.perActionUsd > manifest.caps.totalUsd) {
      ctx.addIssue({ code: 'custom', path: ['caps', 'perActionUsd'], message: 'must be <= caps.totalUsd' });
    }
    if (manifest.actionTimeoutMs > ACTION_TIMEOUT_MS) {
      ctx.addIssue({ code: 'custom', path: ['actionTimeoutMs'], message: `must be <= ${ACTION_TIMEOUT_MS}` });
    }
    if (manifest.runWallClockMs > RUN_WALL_CLOCK_MS) {
      ctx.addIssue({ code: 'custom', path: ['runWallClockMs'], message: `must be <= ${RUN_WALL_CLOCK_MS}` });
    }
    const { bundleDir, spendLedgerPath } = manifest.evidence;
    if (isSameOrInside(bundleDir, spendLedgerPath) || isSameOrInside(spendLedgerPath, bundleDir)) {
      ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'bundleDir and spendLedgerPath must be separate paths, neither inside the other' });
    }
    const overlap = manifest.allowedTools.filter((tool) => manifest.disallowedTools.includes(tool));
    if (overlap.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['disallowedTools'], message: `tools both allowed and disallowed: ${overlap.join(', ')}` });
    }
  });

export type RunManifest = z.infer<typeof RunManifestSchema>;

export type RunManifestInputs = {
  engineVersion: string;
  request: RepositoryGoalRequest;
  profileId: string;
  allowedTools: readonly string[];
  maxTurns: number;
  perActionUsd: number;
  totalUsd: number;
  authMode: string;
  /** Optional settings; defaults are applied here and only here (see `RUN_MANIFEST_DEFAULTS`). */
  model?: string;
  disallowedTools?: readonly string[];
  actionTimeoutMs?: number;
  runWallClockMs?: number;
  expiresInMinutes?: number;
  /** Evidence destinations (AGX-R8a). Required by the schema; optional here so a missing one
   *  refuses as MANIFEST_INVALID like every other out-of-range input. */
  bundleDir?: string;
  spendLedgerPath?: string;
};

/**
 * The single source of manifest defaults. Every caller that turns an invocation into a manifest —
 * `run manifest`, `run approve`, and the later real run that must recompute the approved manifest
 * (AGX-R4) — goes through `buildRunManifest`, so a default can never differ between them.
 */
export const RUN_MANIFEST_DEFAULTS = {
  model: DEFAULT_MODEL,
  disallowedTools: [] as readonly string[],
  actionTimeoutMs: REAL_RUN_ACTION_TIMEOUT_MS,
  runWallClockMs: REAL_RUN_WALL_CLOCK_MS,
  expiresInMinutes: RUN_APPROVAL_MAX_EXPIRY_MINUTES,
} as const;

/** Trim, de-duplicate and sort so tool-list order never changes the hash. */
function normalizeTools(tools: readonly string[]): string[] {
  return [...new Set(tools.map((tool) => tool.trim()))].sort();
}

export function computeRequestHash(request: RepositoryGoalRequest): string {
  return sha256Hex(canonicalJson(request));
}

/** Hash input is `canonicalJson(manifest)` — sorted keys, 2-space indent, trailing newline. */
export function computeManifestHash(manifest: RunManifest): string {
  return sha256Hex(canonicalJson(manifest));
}

/**
 * Resolves `<id>` (version '1', unchanged since before versioning) or `<id>@<version>`, so a real
 * run can select `config-repair@2` (AGX-R7). An unknown id or version is MANIFEST_INVALID.
 */
function resolveProfile(profileId: string): CandidateOfflineProfile {
  const at = profileId.indexOf('@');
  try {
    if (at === -1) return getCandidateOfflineProfile(profileId);
    return getCandidateOfflineProfile(profileId.slice(0, at), profileId.slice(at + 1));
  } catch (err) {
    throw new RunApprovalError('MANIFEST_INVALID', err instanceof Error ? err.message : String(err), { profileId });
  }
}

/**
 * The canonical form of an evidence destination: its parent resolved through `realpath` plus its
 * own basename, so the approved path names no symlinked directory. The destination itself need not
 * exist (and must not, at run time). An unresolvable parent is MANIFEST_INVALID.
 */
function canonicalDestination(flag: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const absolute = path.resolve(raw);
  const parent = path.dirname(absolute);
  if (parent === absolute) {
    throw new RunApprovalError('MANIFEST_INVALID', `${flag} must not be a filesystem root`, { [flag]: raw });
  }
  try {
    return path.join(realpathSync(parent), path.basename(absolute));
  } catch (err) {
    throw new RunApprovalError('MANIFEST_INVALID', `${flag} parent directory ${parent} cannot be resolved: ${err instanceof Error ? err.message : String(err)}`, {
      [flag]: raw,
    });
  }
}

export function buildRunManifest(inputs: RunManifestInputs): RunManifest {
  const profile = resolveProfile(inputs.profileId);
  const candidate = {
    schemaVersion: RunManifestSchemaVersion,
    engineVersion: inputs.engineVersion,
    protocolId: RealRunProtocolId,
    profile: { id: profile.id, version: profile.version, digest: candidateProfileDigest(profile) },
    requestHash: computeRequestHash(inputs.request),
    model: inputs.model ?? RUN_MANIFEST_DEFAULTS.model,
    permissionMode: 'acceptEdits',
    allowedTools: normalizeTools(inputs.allowedTools),
    disallowedTools: normalizeTools(inputs.disallowedTools ?? RUN_MANIFEST_DEFAULTS.disallowedTools),
    maxTurns: inputs.maxTurns,
    caps: { perActionUsd: inputs.perActionUsd, totalUsd: inputs.totalUsd },
    actionTimeoutMs: inputs.actionTimeoutMs ?? RUN_MANIFEST_DEFAULTS.actionTimeoutMs,
    runWallClockMs: inputs.runWallClockMs ?? RUN_MANIFEST_DEFAULTS.runWallClockMs,
    authMode: inputs.authMode,
    attemptCount: 1,
    expiresInMinutes: inputs.expiresInMinutes ?? RUN_MANIFEST_DEFAULTS.expiresInMinutes,
    evidence: {
      bundleDir: canonicalDestination('bundleDir', inputs.bundleDir),
      spendLedgerPath: canonicalDestination('spendLedgerPath', inputs.spendLedgerPath),
    },
  };
  const parsed = RunManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new RunApprovalError('MANIFEST_INVALID', 'run manifest inputs are out of range', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}
