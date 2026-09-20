import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function sha256FileIfPresent(filePath: string | undefined): string {
  if (filePath === undefined || filePath === '') return 'missing';
  try {
    return sha256File(filePath);
  } catch {
    return 'missing';
  }
}

export function packageVersion(): string {
  const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

export type RuntimeLabel = {
  node: string;
};

/** Node/runtime label. Not hashed into `implementationRevision`. */
export function runtimeLabel(): RuntimeLabel {
  return { node: process.version };
}

export type TrustedCheckInput = {
  id: string;
  command: string;
  cwd: string;
  argv: readonly string[];
  awaitReady?: boolean;
  awaitReadyMs?: number;
};

export type TrustedCheckerIdentity = {
  id: string;
  command: string;
  cwd: string;
  script: string;
  extraArgv: readonly string[];
  awaitReady: boolean;
  awaitReadyMs: number | null;
  scriptSha256: string;
};

function checkerScriptPath(argv: readonly string[]): string | undefined {
  if (typeof argv[1] === 'string' && argv[1] !== '') return argv[1];
  if (typeof argv[0] === 'string' && argv[0] !== '') return argv[0];
  return undefined;
}

/**
 * Portable checker identity: script basename, trailing argv, readiness, and
 * checker bytes. `process.execPath` and install-directory prefixes are omitted.
 */
export function trustedCheckerIdentity(check: TrustedCheckInput): TrustedCheckerIdentity {
  const scriptPath = checkerScriptPath(check.argv);
  const extraStart = typeof check.argv[1] === 'string' && check.argv[1] !== '' ? 2 : 1;
  return {
    id: check.id,
    command: check.command,
    cwd: check.cwd,
    script: path.basename(scriptPath ?? ''),
    extraArgv: check.argv.slice(extraStart).map(String),
    awaitReady: check.awaitReady === true,
    awaitReadyMs: check.awaitReadyMs ?? null,
    scriptSha256: sha256FileIfPresent(scriptPath),
  };
}

/**
 * Trusted observer/recorder/validator/profile-policy sources plus the executed
 * CLI boundary (`bin/goal-gen.mjs`, `index.ts`, `direct-invocation.ts`,
 * `commands.ts`, `errors.ts`). `direct-invocation.ts` is the load-time gate
 * that decides whether `index.ts` runs `main()`; a change there can skip or
 * double-invoke dispatch without a version bump. Candidate-offline command,
 * bundle, decider, and profile modules are hashed because they change
 * recorder/dispatch/check identity for that verb. Do not expand this list for
 * unrelated imports. Runtime and npm dependency trees are labeled by
 * `packageVersion()` and `runtimeLabel()`, not this digest. Checker identity
 * is `trustedCheckerIdentity()`, not argv paths. Do not hash the unrelated tree.
 */
export const ENGINE_SOURCES = [
  'bin/goal-gen.mjs',
  'backend/src/cli/index.ts',
  'backend/src/cli/direct-invocation.ts',
  'backend/src/cli/commands.ts',
  'backend/src/cli/errors.ts',
  'backend/src/cli/implementation-revision.ts',
  'backend/src/cli/observed-fixture-observer.ts',
  'backend/src/cli/observed-fixture-child.ts',
  'backend/src/cli/observed-fixture-decider.ts',
  'backend/src/cli/observed-fixture-command.ts',
  'backend/src/cli/observed-fixture-profiles.ts',
  'backend/src/cli/acceptance-record-command.ts',
  'backend/src/cli/acceptance-evidence.ts',
  'backend/src/cli/candidate-offline-command.ts',
  'backend/src/cli/candidate-offline-bundle.ts',
  'backend/src/cli/candidate-offline-decider.ts',
  'backend/src/cli/candidate-offline-profiles.ts',
] as const;

export function engineSourceDigest(): string {
  const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const pieces = ENGINE_SOURCES.map((name) => `${name}:${sha256File(path.join(packageRoot, name))}`);
  return sha256Hex(pieces.join('\n'));
}

export function implementationRevision(profileDigest: string): string {
  return `goal-gen@${packageVersion()}#${sha256Hex(`${engineSourceDigest()}:${profileDigest}`)}`;
}
