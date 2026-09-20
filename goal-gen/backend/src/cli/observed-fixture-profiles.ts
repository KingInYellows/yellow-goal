import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checksDir = path.dirname(fileURLToPath(import.meta.url)) + '/observed-fixture-checks';

export const ObservedFixtureSchemaVersion = 'yellow-goal/observed-fixture-verification/v1' as const;

export type ObservedFixtureProfileId =
  | 'status-probe'
  | 'leftover-file'
  | 'leftover-empty-dir'
  | 'leftover-nested-git'
  | 'leftover-escaping-symlink'
  | 'timeout-probe'
  | 'precondition-escape';

export type ObservedCheckSpec = {
  id: string;
  argv: string[];
  command: string;
  cwd: '.';
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
): ObservedFixtureProfile {
  const check: ObservedCheckSpec = {
    id: 'probe',
    argv: nodeCheck(script),
    command: `observed-fixture:${id}`,
    cwd: '.',
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
    singleCheckProfile('timeout-probe', 'hang.mjs', 200),
    preconditionEscapeProfile(),
  ];
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
