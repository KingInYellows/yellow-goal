/**
 * `run manifest <request.json> …` — offline render of a real-run manifest (ADR-0020, AGX-R1).
 *
 * Dynamically imported by the dispatcher before `./run-command` is ever loaded, so this path never
 * loads executors or the orchestrator loop and never spawns anything. Zero spend.
 */
import { parseArgs } from 'node:util';
import type { RepositoryGoalRequest } from '../contracts/request';
import { loadRunRequest } from '../run/request-to-run';
import { readArtifactVersion } from './artifact-version';
import type { CommandOutput } from './commands';
import { CliUsageError } from './errors';
import {
  approvalChallenge,
  buildRunManifest,
  computeManifestHash,
  type RunManifest,
} from './run-manifest';

/** Flags shared by `run manifest` and `run approve`: the same flags must yield the same manifest. */
export const RUN_MANIFEST_OPTIONS = {
  json: { type: 'boolean', default: false },
  profile: { type: 'string' },
  model: { type: 'string' },
  'max-turns': { type: 'string' },
  'per-action-usd': { type: 'string' },
  'total-usd': { type: 'string' },
  'action-timeout-ms': { type: 'string' },
  'run-wall-clock-ms': { type: 'string' },
  'auth-mode': { type: 'string' },
  'allowed-tool': { type: 'string', multiple: true },
  'disallowed-tool': { type: 'string', multiple: true },
  'expires-in-minutes': { type: 'string' },
  // Evidence destinations are approved with the manifest (AGX-R8a).
  'bundle-dir': { type: 'string' },
  'spend-ledger': { type: 'string' },
} as const;

/** Derived from the options table, so a flag added there is typed here automatically. */
export type ManifestFlagValues = ReturnType<typeof parseArgs<{ options: typeof RUN_MANIFEST_OPTIONS }>>['values'];

export type RunManifestOutput = { manifest: RunManifest; manifestHash: string; challenge: string };

type RequiredFlag = 'profile' | 'max-turns' | 'per-action-usd' | 'total-usd' | 'auth-mode' | 'bundle-dir' | 'spend-ledger';
type OptionalIntegerFlag = 'action-timeout-ms' | 'run-wall-clock-ms' | 'expires-in-minutes';

function required(values: ManifestFlagValues, flag: RequiredFlag): string {
  const value = values[flag];
  if (typeof value !== 'string' || value === '') throw new CliUsageError(`--${flag} is required`);
  return value;
}

function integerFlag(flag: string, raw: string): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new CliUsageError(`--${flag} must be a non-negative integer, got '${raw}'`);
  }
  return value;
}

function usdFlag(flag: string, raw: string): number {
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new CliUsageError(`--${flag} must be a decimal USD amount, got '${raw}'`);
  return Number(raw);
}

/** Builds the manifest from already-parsed flags; range violations surface as MANIFEST_INVALID.
 *  Also returns the loaded request so the approval ceremony can show what is being approved. */
export async function manifestFromFlags(
  values: ManifestFlagValues,
  positionals: string[],
  verb: string,
): Promise<RunManifestOutput & { request: RepositoryGoalRequest }> {
  if (positionals.length !== 1) {
    throw new CliUsageError(`${verb} requires exactly one <request.json> positional argument`);
  }
  const request = await loadRunRequest(positionals[0]!);
  // Absent optional flags stay undefined: `buildRunManifest` owns every default.
  const optional = (flag: OptionalIntegerFlag): number | undefined => {
    const raw = values[flag];
    return raw === undefined ? undefined : integerFlag(flag, raw);
  };
  const manifest = buildRunManifest({
    engineVersion: await readArtifactVersion(),
    request,
    profileId: required(values, 'profile'),
    allowedTools: values['allowed-tool'] ?? [],
    maxTurns: integerFlag('max-turns', required(values, 'max-turns')),
    perActionUsd: usdFlag('per-action-usd', required(values, 'per-action-usd')),
    totalUsd: usdFlag('total-usd', required(values, 'total-usd')),
    authMode: required(values, 'auth-mode'),
    model: values.model,
    disallowedTools: values['disallowed-tool'],
    actionTimeoutMs: optional('action-timeout-ms'),
    runWallClockMs: optional('run-wall-clock-ms'),
    expiresInMinutes: optional('expires-in-minutes'),
    bundleDir: required(values, 'bundle-dir'),
    spendLedgerPath: required(values, 'spend-ledger'),
  });
  const manifestHash = computeManifestHash(manifest);
  return { manifest, manifestHash, challenge: approvalChallenge(manifestHash), request };
}

export async function runRunManifest(argv: string[]): Promise<CommandOutput<RunManifestOutput>> {
  const { values, positionals } = parseArgs({ args: argv, options: RUN_MANIFEST_OPTIONS, allowPositionals: true });
  const { manifest, manifestHash, challenge } = await manifestFromFlags(values, positionals, 'run manifest');
  return { json: values.json === true, output: { manifest, manifestHash, challenge } };
}
