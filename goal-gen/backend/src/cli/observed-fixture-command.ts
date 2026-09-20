/**
 * `acceptance verify-fixture <profile-id> <variant-id>` — observe a disposable
 * fixture, record through the installed `acceptance record` binary, decide.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandOutput } from './commands';
import { CliUsageError, ObservedFixtureError } from './errors';
import {
  AcceptanceEvidenceSchemaVersion,
  type AcceptanceEvidenceRecord,
} from './acceptance-evidence';
import { decideObservedFixture, type RecorderInvocation } from './observed-fixture-decider';
import { observeFixture, removeObservationRepo, type ObservedCheckOutcome } from './observed-fixture-observer';
import {
  ObservedFixtureSchemaVersion,
  getObservedFixtureProfile,
  getObservedFixtureVariant,
  listObservedFixtureProfiles,
  type ObservedFixtureProfile,
} from './observed-fixture-profiles';

export type ObservedFixtureBundle = {
  schemaVersion: typeof ObservedFixtureSchemaVersion;
  profile: { id: string; version: string };
  implementationRevision: string;
  identities: {
    baseRevision: string;
    candidateIdentity: { kind: 'tree'; value: string };
    candidateTree: string;
  };
  bindings: { id: string; command: string; cwd: string }[];
  outcomes: ObservedCheckOutcome[];
  diff: string;
  recorder: RecorderInvocation | null;
  decision: { accepted: boolean; reasons: string[] };
  reproduction: { argv: string[]; profileId: string; variantId: string };
};

function packageVersion(): string {
  const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function goalGenBin(): string {
  return fileURLToPath(new URL('../../../bin/goal-gen.mjs', import.meta.url));
}

function knownProfiles(): string {
  return listObservedFixtureProfiles()
    .map((profile) => profile.id)
    .join('|');
}

function omitUndefined<T extends Record<string, unknown>>(row: T): T {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as T;
}

function buildRecorderFixture(profile: ObservedFixtureProfile, observation: {
  baseRevision: string;
  candidateTree: string;
  checks: ObservedCheckOutcome[];
}): Record<string, unknown> {
  const identity = { kind: 'tree' as const, value: observation.candidateTree };
  return {
    schemaVersion: AcceptanceEvidenceSchemaVersion,
    baseRevision: observation.baseRevision,
    candidateIdentity: identity,
    candidateTree: observation.candidateTree,
    requiredChecks: profile.checks.map((check) => ({
      id: check.id,
      command: check.command,
      cwd: check.cwd,
    })),
    checks: observation.checks.map((row) =>
      omitUndefined({
        id: row.id,
        status: row.status,
        command: row.command,
        cwd: row.cwd,
        candidateIdentity: identity,
        preCheckTree: row.preCheckTree,
        postCheckTree: row.postCheckTree,
        exitStatus: row.exitStatus,
        reason: row.reason,
        signal: row.signal,
      }),
    ),
  };
}

function writeSentinel(dir: string, name: string, marker: string): void {
  writeFileSync(path.join(dir, name), `#!/bin/sh\nprintf invoked > '${marker}'\nexit 97\n`, {
    encoding: 'utf8',
    mode: 0o755,
  });
  chmodSync(path.join(dir, name), 0o755);
}

async function invokeInstalledRecorder(
  fixture: Record<string, unknown>,
): Promise<RecorderInvocation> {
  const work = await mkdtemp(path.join(tmpdir(), 'observed-recorder-'));
  const fixturePath = path.join(work, 'fixture.json');
  const sentinel = path.join(work, 'sentinel-bin');
  mkdirSync(sentinel);
  writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`, 'utf8');
  writeSentinel(sentinel, 'git', path.join(work, 'git-invoked'));
  const required = Array.isArray(fixture.requiredChecks) ? fixture.requiredChecks : [];
  for (const entry of required) {
    if (typeof entry !== 'object' || entry === null) continue;
    const command = (entry as { command?: unknown }).command;
    if (typeof command === 'string' && command.length > 0 && !command.includes('/')) {
      writeSentinel(sentinel, command, path.join(work, `cmd-${command}-invoked`));
    }
  }
  const bin = goalGenBin();
  const env = { ...process.env, PATH: `${sentinel}:${process.env.PATH ?? ''}` };
  try {
    const result = await new Promise<{ exit: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [bin, 'acceptance', 'record', fixturePath, '--json'], {
        env,
        cwd: work,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ exit: code ?? 1, stdout, stderr });
      });
    });
    let record: AcceptanceEvidenceRecord | undefined;
    if (result.exit === 0 && result.stdout.trim() !== '') {
      try {
        record = JSON.parse(result.stdout) as AcceptanceEvidenceRecord;
      } catch {
        record = undefined;
      }
    }
    return { ...result, record };
  } catch (err) {
    throw new ObservedFixtureError(
      'RECORDER_INVOKE_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function runObservedFixtureVerify(argv: string[]): Promise<CommandOutput<ObservedFixtureBundle>> {
  const json = argv.includes('--json');
  const positionals = argv.filter((value) => value !== '--json');
  if (positionals.length !== 2) {
    throw new CliUsageError(
      `acceptance verify-fixture requires <profile-id> <variant-id> (profiles: ${knownProfiles()})`,
    );
  }
  const [profileId, variantId] = positionals;
  if (profileId === undefined || variantId === undefined) {
    throw new CliUsageError('acceptance verify-fixture requires <profile-id> <variant-id>');
  }
  if (profileId.endsWith('.json') || variantId.endsWith('.json')) {
    throw new CliUsageError('imported JSON is not an authorization route for acceptance verify-fixture');
  }

  let profile: ObservedFixtureProfile;
  try {
    profile = getObservedFixtureProfile(profileId);
  } catch {
    throw new CliUsageError(`unknown observed fixture profile: ${profileId} (profiles: ${knownProfiles()})`);
  }
  let variant;
  try {
    variant = getObservedFixtureVariant(profile, variantId);
  } catch {
    throw new CliUsageError(`unknown variant ${variantId} for profile ${profile.id}`);
  }

  const observation = await observeFixture(profile, variant);
  try {
    let recorder: RecorderInvocation | undefined;
    if (observation.faults.length === 0 && observation.candidateTree !== '' && observation.checks.length > 0) {
      recorder = await invokeInstalledRecorder(buildRecorderFixture(profile, observation));
    }
    const decision = decideObservedFixture({ profile, observation, recorder });
    const candidateTree = observation.candidateTree;
    return {
      json,
      output: {
        schemaVersion: ObservedFixtureSchemaVersion,
        profile: { id: profile.id, version: profile.version },
        implementationRevision: `goal-gen@${packageVersion()}+${profile.id}@${profile.version}`,
        identities: {
          baseRevision: observation.baseRevision,
          candidateIdentity: { kind: 'tree', value: candidateTree },
          candidateTree,
        },
        bindings: profile.checks.map((check) => ({ id: check.id, command: check.command, cwd: check.cwd })),
        outcomes: observation.checks,
        diff: observation.diff,
        recorder: recorder ?? null,
        decision,
        reproduction: {
          argv: ['acceptance', 'verify-fixture', profile.id, variantId],
          profileId: profile.id,
          variantId,
        },
      },
    };
  } finally {
    await removeObservationRepo(observation.cleanupDir);
  }
}
