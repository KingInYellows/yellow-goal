import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex, trustedCheckerIdentity } from './implementation-revision';

const checksDir = path.dirname(fileURLToPath(import.meta.url)) + '/observed-fixture-checks';

export const ObservedFixtureSchemaVersion = 'yellow-goal/observed-fixture-verification/v1' as const;

export type ObservedFixtureProfileId =
  | 'status-probe'
  | 'leftover-file'
  | 'leftover-empty-dir'
  | 'leftover-nested-git'
  | 'leftover-escaping-symlink'
  | 'leftover-stops-later'
  | 'timeout-probe'
  | 'timeout-ignore'
  | 'noisy-output'
  | 'spawn-missing'
  | 'descendant-pipe'
  | 'ready-never'
  | 'ready-exit'
  | 'precondition-escape';

export type ObservedCheckSpec = {
  id: string;
  argv: string[];
  command: string;
  cwd: '.';
  awaitReady?: boolean;
  awaitReadyMs?: number;
};

export type ObservedFixtureVariant = {
  files: Record<string, string>;
  symlinks?: Record<string, string>;
};

export type ObservedFixtureProfile = {
  id: ObservedFixtureProfileId;
  version: string;
  timeoutMs: number;
  requiredCheckIds: string[];
  checks: ObservedCheckSpec[];
  baseFiles: Record<string, string>;
  approvedFiles: Record<string, string>;
  variants: Record<string, ObservedFixtureVariant>;
};

function nodeCheck(script: string, extraArgs: string[] = []): string[] {
  return [process.execPath, path.join(checksDir, script), ...extraArgs];
}

function statusProfile(): ObservedFixtureProfile {
  const check: ObservedCheckSpec = {
    id: 'status',
    argv: nodeCheck('status-probe.mjs', ['STATUS']),
    command: 'observed-fixture:status-probe',
    cwd: '.',
  };
  return {
    id: 'status-probe',
    version: '1',
    timeoutMs: 5_000,
    requiredCheckIds: [check.id],
    checks: [check],
    baseFiles: { STATUS: 'fail\n', 'keep.txt': 'keep\n' },
    approvedFiles: { STATUS: 'ok\n', 'keep.txt': 'keep\n' },
    variants: {
      baseline: { files: {} },
      correct: { files: { STATUS: 'ok\n' } },
      incorrect: { files: { STATUS: 'nope\n' } },
    },
  };
}

function singleCheckProfile(
  id: ObservedFixtureProfileId,
  script: string,
  timeoutMs: number,
  baseFiles: Record<string, string> = { STATUS: 'ok\n', 'keep.txt': 'keep\n' },
  awaitReady = false,
): ObservedFixtureProfile {
  const check: ObservedCheckSpec = {
    id: 'probe',
    argv: nodeCheck(script),
    command: `observed-fixture:${id}`,
    cwd: '.',
    ...(awaitReady ? { awaitReady: true } : {}),
  };
  return {
    id,
    version: '1',
    timeoutMs,
    requiredCheckIds: [check.id],
    checks: [check],
    baseFiles,
    approvedFiles: { ...baseFiles },
    variants: { case: { files: {} } },
  };
}

export function listObservedFixtureProfiles(): ObservedFixtureProfile[] {
  return [
    statusProfile(),
    singleCheckProfile('leftover-file', 'write-leftover.mjs', 5_000),
    singleCheckProfile('leftover-empty-dir', 'mkdir-empty.mjs', 5_000),
    singleCheckProfile('leftover-nested-git', 'write-nested-git.mjs', 5_000, {
      'keep/file.txt': 'keep\n',
    }),
    singleCheckProfile('leftover-escaping-symlink', 'write-escape-symlink.mjs', 5_000),
    singleCheckProfile('timeout-probe', 'hang.mjs', 200, undefined, true),
    singleCheckProfile('timeout-ignore', 'hang-ignore.mjs', 200, undefined, true),
    singleCheckProfile('noisy-output', 'noisy.mjs', 5_000),
    spawnMissingProfile(),
    singleCheckProfile('descendant-pipe', 'descendant-pipe.mjs', 200, undefined, true),
    readyNeverProfile(),
    singleCheckProfile('ready-exit', 'ready-exit.mjs', 5_000, undefined, true),
    leftoverStopsLaterProfile(),
    preconditionEscapeProfile(),
  ];
}

function leftoverStopsLaterProfile(): ObservedFixtureProfile {
  const mutate: ObservedCheckSpec = {
    id: 'mutate',
    argv: nodeCheck('write-leftover.mjs'),
    command: 'observed-fixture:leftover-stops-later:mutate',
    cwd: '.',
  };
  const later: ObservedCheckSpec = {
    id: 'later',
    argv: nodeCheck('status-probe.mjs', ['STATUS']),
    command: 'observed-fixture:leftover-stops-later:later',
    cwd: '.',
  };
  return {
    id: 'leftover-stops-later',
    version: '1',
    timeoutMs: 5_000,
    requiredCheckIds: [mutate.id, later.id],
    checks: [mutate, later],
    baseFiles: { STATUS: 'ok\n', 'keep.txt': 'keep\n' },
    approvedFiles: { STATUS: 'ok\n', 'keep.txt': 'keep\n' },
    variants: { case: { files: {} } },
  };
}

function spawnMissingProfile(): ObservedFixtureProfile {
  const missing: ObservedCheckSpec = {
    id: 'missing',
    argv: [path.join(checksDir, 'no-such-observed-binary')],
    command: 'observed-fixture:spawn-missing:missing',
    cwd: '.',
  };
  const later: ObservedCheckSpec = {
    id: 'later',
    argv: nodeCheck('status-probe.mjs', ['STATUS']),
    command: 'observed-fixture:spawn-missing:later',
    cwd: '.',
  };
  return {
    id: 'spawn-missing',
    version: '1',
    timeoutMs: 5_000,
    requiredCheckIds: [missing.id, later.id],
    checks: [missing, later],
    baseFiles: { STATUS: 'ok\n', keep: 'keep\n' },
    approvedFiles: { STATUS: 'ok\n', keep: 'keep\n' },
    variants: { case: { files: {} } },
  };
}

function preconditionEscapeProfile(): ObservedFixtureProfile {
  const check: ObservedCheckSpec = {
    id: 'status',
    argv: nodeCheck('status-probe.mjs', ['STATUS']),
    command: 'observed-fixture:precondition-escape',
    cwd: '.',
  };
  return {
    id: 'precondition-escape',
    version: '1',
    timeoutMs: 5_000,
    requiredCheckIds: [check.id],
    checks: [check],
    baseFiles: { STATUS: 'ok\n', 'keep.txt': 'keep\n' },
    approvedFiles: { STATUS: 'ok\n', 'keep.txt': 'keep\n' },
    variants: {
      case: { files: {}, symlinks: { escape: '/tmp' } },
    },
  };
}

function readyNeverProfile(): ObservedFixtureProfile {
  const check: ObservedCheckSpec = {
    id: 'probe',
    argv: nodeCheck('ready-never.mjs'),
    command: 'observed-fixture:ready-never',
    cwd: '.',
    awaitReady: true,
    awaitReadyMs: 400,
  };
  return {
    id: 'ready-never',
    version: '1',
    timeoutMs: 5_000,
    requiredCheckIds: [check.id],
    checks: [check],
    baseFiles: { STATUS: 'ok\n', 'keep.txt': 'keep\n' },
    approvedFiles: { STATUS: 'ok\n', 'keep.txt': 'keep\n' },
    variants: { case: { files: {} } },
  };
}

export function observedProfileDigest(profile: ObservedFixtureProfile): string {
  return sha256Hex(
    JSON.stringify({
      id: profile.id,
      version: profile.version,
      timeoutMs: profile.timeoutMs,
      requiredCheckIds: profile.requiredCheckIds,
      baseFiles: profile.baseFiles,
      approvedFiles: profile.approvedFiles,
      checkers: profile.checks.map(trustedCheckerIdentity),
    }),
  );
}

export function getObservedFixtureProfile(id: string): ObservedFixtureProfile {
  const match = listObservedFixtureProfiles().find((profile) => profile.id === id);
  if (!match) {
    throw new Error(`unknown observed fixture profile: ${id}`);
  }
  return match;
}

export function getObservedFixtureVariant(
  profile: ObservedFixtureProfile,
  variantId: string,
): ObservedFixtureVariant {
  const variant = profile.variants[variantId];
  if (!variant) {
    throw new Error(`unknown variant ${variantId} for profile ${profile.id}`);
  }
  return variant;
}
