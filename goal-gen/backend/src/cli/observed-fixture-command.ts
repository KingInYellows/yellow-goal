/**
 * `acceptance verify-fixture <profile-id> <variant-id>` — observe a disposable
 * fixture, record through the installed `acceptance record` binary, decide.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { implementationRevision, runtimeLabel } from './implementation-revision';
import { RECORDER_OUTPUT_LIMIT, runBoundedArgv } from './observed-fixture-child';
import { decideObservedFixture, type RecorderInvocation } from './observed-fixture-decider';
import { observeFixture, removeObservationRepo, type ObservedCheckOutcome } from './observed-fixture-observer';
import {
  ObservedFixtureSchemaVersion,
  getObservedFixtureProfile,
  getObservedFixtureVariant,
  listObservedFixtureProfiles,
  observedProfileDigest,
  type ObservedFixtureProfile,
} from './observed-fixture-profiles';

export type ObservedFixtureBundle = {
  schemaVersion: typeof ObservedFixtureSchemaVersion;
  profile: { id: string; version: string };
  implementationRevision: string;
  runtime: { node: string };
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

export function buildRecorderFixture(
  profile: { checks: Array<{ id: string; command: string; cwd: string }> },
  observation: {
    baseRevision: string;
    candidateTree: string;
    checks: ObservedCheckOutcome[];
  },
): Record<string, unknown> {
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

export function recorderRepresentable(checks: ObservedCheckOutcome[]): boolean {
  return checks.every((row) => {
    if (row.deadlineExceeded === true && row.rawExitStatus !== undefined && row.signal === undefined) {
      return false;
    }
    if (row.outputTruncated === true && typeof row.rawExitStatus === 'number' && row.signal === undefined) {
      return false;
    }
    if (row.reason === 'readiness-failed' && row.rawExitStatus !== undefined && row.signal === undefined) {
      return false;
    }
    return true;
  });
}

function writeSentinel(dir: string, name: string, marker: string): void {
  writeFileSync(path.join(dir, name), `#!/bin/sh\nprintf invoked > '${marker}'\nexit 97\n`, {
    encoding: 'utf8',
    mode: 0o755,
  });
  chmodSync(path.join(dir, name), 0o755);
}

export async function invokeInstalledRecorder(
  fixture: Record<string, unknown>,
): Promise<RecorderInvocation> {
  const work = await mkdtemp(path.join(tmpdir(), 'observed-recorder-'));
  try {
    const fixturePath = path.join(work, 'fixture.json');
    const sentinel = path.join(work, 'sentinel-bin');
    mkdirSync(sentinel);
    writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`, 'utf8');
    const gitMarker = path.join(work, 'git-invoked');
    writeSentinel(sentinel, 'git', gitMarker);
    const commandMarkers: string[] = [];
    const required = Array.isArray(fixture.requiredChecks) ? fixture.requiredChecks : [];
    for (const entry of required) {
      if (typeof entry !== 'object' || entry === null) continue;
      const command = (entry as { command?: unknown }).command;
      if (typeof command === 'string' && command.length > 0 && !command.includes('/')) {
        const marker = path.join(work, `cmd-${command}-invoked`);
        commandMarkers.push(marker);
        writeSentinel(sentinel, command, marker);
      }
    }
    const bin = goalGenBin();
    const env = {
      PATH: `${sentinel}${path.delimiter}${path.dirname(process.execPath)}`,
      HOME: work,
      TMPDIR: work,
      LANG: 'C',
      GOAL_GEN_DISPOSABLE_OBSERVER: '1',
    };
    const run = await runBoundedArgv({
      argv: [process.execPath, bin, 'acceptance', 'record', fixturePath, '--json'],
      cwd: work,
      env,
      timeoutMs: 20_000,
      outputLimit: RECORDER_OUTPUT_LIMIT,
    });
    if (run.spawnError !== undefined) {
      throw new ObservedFixtureError('RECORDER_INVOKE_FAILED', run.spawnError);
    }
    if (run.timedOut || run.stdoutTruncated || run.stderrTruncated) {
      throw new ObservedFixtureError(
        'RECORDER_INVOKE_FAILED',
        run.timedOut ? 'recorder subprocess exceeded deadline' : 'recorder subprocess output exceeded bound',
      );
    }
    if (existsSync(gitMarker) || commandMarkers.some((marker) => existsSync(marker))) {
      throw new ObservedFixtureError('RECORDER_INVOKE_FAILED', 'recorder invoked git or fixture command sentinel');
    }
    if (run.signal !== undefined || typeof run.exitStatus !== 'number') {
      throw new ObservedFixtureError(
        'RECORDER_INVOKE_FAILED',
        run.signal !== undefined
          ? `recorder subprocess killed by ${run.signal}`
          : 'recorder subprocess exited without a numeric status',
      );
    }
    let record: AcceptanceEvidenceRecord | undefined;
    if (run.exitStatus === 0 && run.stdout.trim() !== '') {
      try {
        record = JSON.parse(run.stdout) as AcceptanceEvidenceRecord;
      } catch {
        record = undefined;
      }
    }
    return { exit: run.exitStatus, stdout: run.stdout, stderr: run.stderr, record };
  } catch (err) {
    if (err instanceof ObservedFixtureError) throw err;
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
    if (
      observation.faults.length === 0 &&
      observation.candidateTree !== '' &&
      observation.checks.length > 0 &&
      recorderRepresentable(observation.checks)
    ) {
      recorder = await invokeInstalledRecorder(buildRecorderFixture(profile, observation));
    }
    const decision = decideObservedFixture({ profile, observation, recorder });
    const candidateTree = observation.candidateTree;
    return {
      json,
      output: {
        schemaVersion: ObservedFixtureSchemaVersion,
        profile: { id: profile.id, version: profile.version },
        implementationRevision: implementationRevision(observedProfileDigest(profile)),
        runtime: runtimeLabel(),
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
