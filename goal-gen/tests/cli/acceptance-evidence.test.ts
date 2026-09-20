/**
 * Requirement-to-test matrix for `acceptance record` (VS spec outcome table).
 *
 * Fixtures are simulated observer JSON unless a case label says it independently
 * observed CLI/process behavior (stdout/stderr/exit, cwd, PATH traps).
 */
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcceptanceEvidenceSchemaVersion,
  MUTATED_CANDIDATE_REASON,
  aggregateCheckStatuses,
  recordAcceptanceEvidence,
  type AcceptanceEvidenceRecord,
  type CheckRowInput,
} from '../../backend/src/cli/acceptance-evidence';
import { AcceptanceEvidenceError } from '../../backend/src/cli/errors';
import { main } from '../../backend/src/cli/index';

const SENTINEL_COMMAND = '__ACCEPTANCE_RECORDER_MUST_NOT_EXECUTE__';
const SHA1 = {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  mutated: 'c'.repeat(40),
  other: 'd'.repeat(40),
};
const SHA256 = {
  commit: 'a'.repeat(64),
  tree: 'b'.repeat(64),
};

function tuple(id: string, command = SENTINEL_COMMAND, cwd = 'goal-gen') {
  return { id, command, cwd };
}

function identity(kind: 'commit' | 'tree', value: string) {
  return { kind, value };
}

function passedRow(id: string, trees = SHA1.tree) {
  return {
    id,
    status: 'passed' as const,
    command: SENTINEL_COMMAND,
    cwd: 'goal-gen',
    candidateIdentity: identity('tree', trees),
    preCheckTree: trees,
    postCheckTree: trees,
    exitStatus: 0,
  };
}

function failedRow(id: string, exitStatus = 1, trees = SHA1.tree) {
  return {
    id,
    status: 'failed' as const,
    command: SENTINEL_COMMAND,
    cwd: 'goal-gen',
    candidateIdentity: identity('tree', trees),
    preCheckTree: trees,
    postCheckTree: trees,
    exitStatus,
  };
}

function blockedSignalRow(id: string, trees = SHA1.tree) {
  return {
    id,
    status: 'blocked' as const,
    command: SENTINEL_COMMAND,
    cwd: 'goal-gen',
    candidateIdentity: identity('tree', trees),
    preCheckTree: trees,
    signal: 'SIGTERM',
    reason: 'killed by timeout',
  };
}

function notRunRow(id: string, trees = SHA1.tree) {
  return {
    id,
    status: 'not-run' as const,
    command: SENTINEL_COMMAND,
    cwd: 'goal-gen',
    candidateIdentity: identity('tree', trees),
    reason: 'never launched',
  };
}

function blockedMutationRow(id: string, pre = SHA1.tree, post = SHA1.mutated) {
  return {
    id,
    status: 'blocked' as const,
    command: SENTINEL_COMMAND,
    cwd: 'goal-gen',
    candidateIdentity: identity('tree', pre),
    preCheckTree: pre,
    postCheckTree: post,
    exitStatus: 0,
    reason: MUTATED_CANDIDATE_REASON,
  };
}

function baseFixture(checks: CheckRowInput[], extras: Record<string, unknown> = {}) {
  const requiredChecks = checks.map((row) => tuple(row.id, row.command, row.cwd));
  return {
    schemaVersion: AcceptanceEvidenceSchemaVersion,
    baseRevision: SHA1.commit,
    candidateIdentity: identity('tree', SHA1.tree),
    candidateTree: SHA1.tree,
    requiredChecks,
    checks,
    ...extras,
  };
}

function expectCode(input: unknown, code: string): void {
  try {
    recordAcceptanceEvidence(input);
    throw new Error(`expected ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(AcceptanceEvidenceError);
    expect((err as AcceptanceEvidenceError).code).toBe(code);
  }
}

let tempDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'goal-gen-acceptance-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  await rm(tempDir, { recursive: true, force: true });
});

function stdoutText(): string {
  return stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

async function writeFixture(name: string, value: unknown): Promise<string> {
  const filePath = path.join(tempDir, name);
  await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
  return filePath;
}

async function invoke(filePath: string, extra: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  stdoutSpy.mockClear();
  stderrSpy.mockClear();
  const code = await main(['acceptance', 'record', filePath, ...extra]);
  return { code, stdout: stdoutText(), stderr: stderrText() };
}

describe('acceptance evidence recorder — outcome table', () => {
  it('R1 simulated: normal zero exit, no leftover mutation → passed record, aggregate passed', () => {
    const record = recordAcceptanceEvidence(baseFixture([passedRow('typecheck')]));
    expect(record.status).toBe('passed');
    expect(record.schemaVersion).toBe(AcceptanceEvidenceSchemaVersion);
    expect(record.checks).toEqual([passedRow('typecheck')]);
  });

  it('R2 simulated: normal nonzero exit, no leftover mutation → failed record', () => {
    const record = recordAcceptanceEvidence(baseFixture([failedRow('test', 2)]));
    expect(record.status).toBe('failed');
    expect(record.checks[0]).toMatchObject({ status: 'failed', exitStatus: 2 });
  });

  it('R3 simulated: timeout/signal launched with no Node exit → blocked, never not-run/passed', () => {
    const record = recordAcceptanceEvidence(baseFixture([blockedSignalRow('lint')]));
    expect(record.status).toBe('blocked');
    expect(record.checks[0]?.status).toBe('blocked');
    expect(record.checks[0]?.exitStatus).toBeUndefined();
  });

  it('R4 simulated: never launched → not-run', () => {
    const record = recordAcceptanceEvidence(baseFixture([notRunRow('lint')]));
    expect(record.status).toBe('not-run');
    expect(record.checks[0]).toEqual(notRunRow('lint'));
  });

  it('R5 simulated: mixed aggregate uses blocked > failed > not-run', () => {
    const mixed = baseFixture([passedRow('typecheck'), failedRow('test'), blockedSignalRow('lint'), notRunRow('eval')]);
    expect(recordAcceptanceEvidence(mixed).status).toBe('blocked');
    expect(recordAcceptanceEvidence(baseFixture([passedRow('typecheck'), failedRow('test'), notRunRow('lint')])).status).toBe(
      'failed',
    );
    expect(recordAcceptanceEvidence(baseFixture([passedRow('typecheck'), notRunRow('lint')])).status).toBe('not-run');
    expect(aggregateCheckStatuses(['failed', 'not-run', 'blocked'])).toBe('blocked');
  });

  it('R6 simulated: empty requiredChecks → EMPTY_REQUIRED_CHECKS, no record', () => {
    expectCode({ ...baseFixture([passedRow('typecheck')]), requiredChecks: [], checks: [] }, 'EMPTY_REQUIRED_CHECKS');
  });

  it('R7 simulated: missing required check → MISSING_REQUIRED_CHECK', () => {
    const fixture = baseFixture([passedRow('typecheck'), passedRow('test')]);
    fixture.checks = [passedRow('typecheck')];
    expectCode(fixture, 'MISSING_REQUIRED_CHECK');
  });

  it('R8 simulated: duplicate check id → DUPLICATE_CHECK_ID', () => {
    const fixture = baseFixture([passedRow('typecheck')]);
    fixture.checks = [passedRow('typecheck'), { ...passedRow('typecheck'), command: SENTINEL_COMMAND }];
    expectCode(fixture, 'DUPLICATE_CHECK_ID');
    const requiredDup = baseFixture([passedRow('typecheck')]);
    requiredDup.requiredChecks = [tuple('typecheck'), tuple('typecheck')];
    expectCode(requiredDup, 'DUPLICATE_CHECK_ID');
  });

  it('R9 simulated: unexpected check id → UNEXPECTED_CHECK_ID', () => {
    const fixture = baseFixture([passedRow('typecheck')]);
    fixture.checks = [passedRow('typecheck'), passedRow('surprise')];
    expectCode(fixture, 'UNEXPECTED_CHECK_ID');
  });

  it('R10 simulated: command/cwd tuple mismatch → CHECK_BINDING_MISMATCH', () => {
    const fixture = baseFixture([passedRow('typecheck')]);
    fixture.checks = [{ ...passedRow('typecheck'), command: 'true' }];
    expectCode(fixture, 'CHECK_BINDING_MISMATCH');
    fixture.checks = [{ ...passedRow('typecheck'), cwd: '/tmp/other' }];
    expectCode(fixture, 'CHECK_BINDING_MISMATCH');
  });

  it('R11 simulated: row candidateIdentity ≠ record → CANDIDATE_MISMATCH', () => {
    const fixture = baseFixture([passedRow('typecheck')]);
    fixture.checks = [{ ...passedRow('typecheck'), candidateIdentity: identity('tree', SHA1.other) }];
    expectCode(fixture, 'CANDIDATE_MISMATCH');
  });

  it('R12 simulated: preCheckTree ≠ candidateTree → PRECHECK_TREE_MISMATCH', () => {
    const fixture = baseFixture([passedRow('typecheck')]);
    fixture.checks = [{ ...passedRow('typecheck'), preCheckTree: SHA1.other, postCheckTree: SHA1.other }];
    expectCode(fixture, 'PRECHECK_TREE_MISMATCH');
  });

  it('R13 simulated: leftover mutation honestly blocked → record, exit-path covered by CLI', () => {
    const record = recordAcceptanceEvidence(baseFixture([blockedMutationRow('lint')]));
    expect(record.status).toBe('blocked');
    expect(record.checks[0]).toMatchObject({ status: 'blocked', reason: MUTATED_CANDIDATE_REASON });
  });

  it('R14 simulated: leftover mutation labeled passed → INVALID_STATUS_FOR_MUTATED_CANDIDATE', () => {
    const fixture = baseFixture([passedRow('lint')]);
    fixture.checks = [{ ...passedRow('lint'), postCheckTree: SHA1.mutated }];
    expectCode(fixture, 'INVALID_STATUS_FOR_MUTATED_CANDIDATE');
  });

  it('R15 simulated: leftover mutation labeled failed → INVALID_STATUS_FOR_MUTATED_CANDIDATE', () => {
    const fixture = baseFixture([failedRow('lint')]);
    fixture.checks = [{ ...failedRow('lint'), postCheckTree: SHA1.mutated }];
    expectCode(fixture, 'INVALID_STATUS_FOR_MUTATED_CANDIDATE');
  });

  it('R16 simulated: later row credits mutated tree → UNVERIFIED_CANDIDATE_CREDIT', () => {
    const mutated = blockedMutationRow('lint');
    const credited = {
      ...passedRow('test'),
      candidateIdentity: identity('tree', SHA1.mutated),
      preCheckTree: SHA1.mutated,
      postCheckTree: SHA1.mutated,
    };
    const fixture = {
      ...baseFixture([mutated, credited]),
      candidateIdentity: identity('tree', SHA1.tree),
      candidateTree: SHA1.tree,
    };
    expectCode(fixture, 'UNVERIFIED_CANDIDATE_CREDIT');
  });

  it('R17 simulated: gitlink-invisible leftover mutation honestly blocked with equal trees', () => {
    const row = {
      ...blockedMutationRow('lint', SHA1.tree, SHA1.tree),
      postCheckTree: SHA1.tree,
      exitStatus: undefined,
    };
    delete (row as { exitStatus?: number }).exitStatus;
    const record = recordAcceptanceEvidence(baseFixture([row]));
    expect(record.status).toBe('blocked');
    expect(record.checks[0]?.reason).toBe(MUTATED_CANDIDATE_REASON);
  });

  it('R17b simulated: equal-tree reserved mutation reason cannot be passed or failed', () => {
    expectCode(
      baseFixture([{ ...passedRow('lint'), reason: MUTATED_CANDIDATE_REASON }]),
      'INVALID_STATUS_FOR_MUTATED_CANDIDATE',
    );
    expectCode(
      baseFixture([{ ...failedRow('lint'), reason: MUTATED_CANDIDATE_REASON }]),
      'INVALID_STATUS_FOR_MUTATED_CANDIDATE',
    );
  });

  it('R17c simulated: not-run cannot carry leftover-mutation reason; honest not-run and blocked remain valid', () => {
    expectCode(
      baseFixture([{ ...notRunRow('lint'), reason: MUTATED_CANDIDATE_REASON }]),
      'SCHEMA_INVALID',
    );
    expect(recordAcceptanceEvidence(baseFixture([notRunRow('lint')])).checks[0]).toMatchObject({
      status: 'not-run',
      reason: 'never launched',
    });
    expect(recordAcceptanceEvidence(baseFixture([blockedMutationRow('lint')])).checks[0]).toMatchObject({
      status: 'blocked',
      reason: MUTATED_CANDIDATE_REASON,
    });
  });

  it('R18 simulated: malformed schema, packet-compiler identity, unsupported kind, mixed/invalid object names', () => {
    expectCode({ ...baseFixture([passedRow('typecheck')]), schemaVersion: 'yellow-goal/evidence/v1' }, 'SCHEMA_INVALID');
    expectCode({ ...baseFixture([passedRow('typecheck')]), extra: true }, 'SCHEMA_INVALID');
    expectCode(
      { ...baseFixture([passedRow('typecheck')]), candidateIdentity: { kind: 'patch-bytes', value: SHA1.tree } },
      'SCHEMA_INVALID',
    );
    expectCode({ ...baseFixture([passedRow('typecheck')]), baseRevision: 'A'.repeat(40) }, 'SCHEMA_INVALID');
    expectCode({ ...baseFixture([passedRow('typecheck')]), baseRevision: 'a'.repeat(39) }, 'SCHEMA_INVALID');
    expectCode(
      {
        ...baseFixture([passedRow('typecheck')]),
        baseRevision: SHA256.commit,
        candidateIdentity: identity('tree', SHA1.tree),
        candidateTree: SHA1.tree,
      },
      'SCHEMA_INVALID',
    );
  });

  it('R19 simulated: tree-kind candidateTree must equal identity value', () => {
    expectCode({ ...baseFixture([passedRow('typecheck')]), candidateTree: SHA1.other }, 'SCHEMA_INVALID');
  });

  it('R20 simulated: SHA-256 object names are valid when uniform', () => {
    const row = {
      ...passedRow('typecheck', SHA256.tree),
      candidateIdentity: identity('tree', SHA256.tree),
    };
    const record = recordAcceptanceEvidence({
      schemaVersion: AcceptanceEvidenceSchemaVersion,
      baseRevision: SHA256.commit,
      candidateIdentity: identity('tree', SHA256.tree),
      candidateTree: SHA256.tree,
      requiredChecks: [tuple('typecheck')],
      checks: [row],
    });
    expect(record.candidateTree).toBe(SHA256.tree);
    expect(record.status).toBe('passed');
  });

  it('R21 simulated: commit-kind allows distinct candidateTree of the same length', () => {
    const row = {
      ...passedRow('typecheck'),
      candidateIdentity: identity('commit', SHA1.commit),
    };
    const record = recordAcceptanceEvidence({
      schemaVersion: AcceptanceEvidenceSchemaVersion,
      baseRevision: SHA1.commit,
      candidateIdentity: identity('commit', SHA1.commit),
      candidateTree: SHA1.tree,
      requiredChecks: [tuple('typecheck')],
      checks: [row],
    });
    expect(record.candidateIdentity).toEqual(identity('commit', SHA1.commit));
    expect(record.candidateTree).toBe(SHA1.tree);
  });

  it('R22 simulated: contradictory/missing outcome fields are SCHEMA_INVALID', () => {
    expectCode(baseFixture([{ ...passedRow('typecheck'), exitStatus: 1 }]), 'SCHEMA_INVALID');
    expectCode(baseFixture([{ ...failedRow('test'), exitStatus: 0 }]), 'SCHEMA_INVALID');
    const missingExit = { ...passedRow('typecheck') } as { exitStatus?: number };
    delete missingExit.exitStatus;
    expectCode(baseFixture([missingExit as ReturnType<typeof passedRow>]), 'SCHEMA_INVALID');
    expectCode(baseFixture([{ ...notRunRow('lint'), exitStatus: 0 }]), 'SCHEMA_INVALID');
    expectCode(baseFixture([{ ...blockedSignalRow('lint'), reason: undefined, signal: undefined }]), 'SCHEMA_INVALID');
  });

  it('R23 simulated: signal and numeric exitStatus are mutually exclusive; not-run rejects present-null exitStatus', () => {
    expectCode(baseFixture([{ ...passedRow('typecheck'), signal: 'SIGTERM' }]), 'SCHEMA_INVALID');
    expectCode(baseFixture([{ ...failedRow('test'), signal: 'SIGKILL' }]), 'SCHEMA_INVALID');
    expectCode(baseFixture([{ ...blockedSignalRow('lint'), exitStatus: 0 }]), 'SCHEMA_INVALID');
    expectCode(baseFixture([{ ...notRunRow('lint'), exitStatus: null }]), 'SCHEMA_INVALID');
    const signalOnly = recordAcceptanceEvidence(baseFixture([blockedSignalRow('lint')])).checks[0];
    expect(signalOnly).toMatchObject({ status: 'blocked', signal: 'SIGTERM' });
    expect(signalOnly?.exitStatus).toBeUndefined();
    const leftover = recordAcceptanceEvidence(baseFixture([blockedMutationRow('lint')])).checks[0];
    expect(leftover).toMatchObject({
      status: 'blocked',
      exitStatus: 0,
      reason: MUTATED_CANDIDATE_REASON,
    });
    expect(leftover?.signal).toBeUndefined();
  });
});

describe('acceptance record CLI process contract', () => {
  it('independently observed: valid pass fixture exits 0 with JSON stdout and empty stderr', async () => {
    const filePath = await writeFixture('pass.json', baseFixture([passedRow('typecheck')]));
    const result = await invoke(filePath, ['--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as AcceptanceEvidenceRecord;
    expect(parsed.status).toBe('passed');
    expect(parsed.schemaVersion).toBe(AcceptanceEvidenceSchemaVersion);
  });

  it('independently observed: valid negative mixed fixture still exits 0', async () => {
    const filePath = await writeFixture(
      'negative.json',
      baseFixture([failedRow('test'), blockedSignalRow('lint'), notRunRow('eval')]),
    );
    const result = await invoke(filePath, ['--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'blocked' });
  });

  it('independently observed: honest leftover mutation exits 0; mislabeled mutation exits 1', async () => {
    const honest = await writeFixture('honest-mutation.json', baseFixture([blockedMutationRow('lint')]));
    const honestResult = await invoke(honest, ['--json']);
    expect(honestResult.code).toBe(0);
    expect(JSON.parse(honestResult.stdout)).toMatchObject({ status: 'blocked' });

    const mislabeled = await writeFixture('mislabeled.json', {
      ...baseFixture([passedRow('lint')]),
      checks: [{ ...passedRow('lint'), postCheckTree: SHA1.mutated }],
    });
    const bad = await invoke(mislabeled, ['--json']);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe('');
    expect(JSON.parse(bad.stderr)).toMatchObject({ error: { code: 'INVALID_STATUS_FOR_MUTATED_CANDIDATE' } });
  });

  it('independently observed: passed row with signal writes no record (exit 1 SCHEMA_INVALID)', async () => {
    const filePath = await writeFixture('passed-with-signal.json', baseFixture([{ ...passedRow('typecheck'), signal: 'SIGTERM' }]));
    const result = await invoke(filePath, ['--json']);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'SCHEMA_INVALID' } });
  });

  it('independently observed: malformed JSON exits 1 SCHEMA_INVALID with empty stdout', async () => {
    const filePath = path.join(tempDir, 'bad.json');
    await writeFile(filePath, '{not json', 'utf8');
    const result = await invoke(filePath, ['--json']);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'SCHEMA_INVALID' } });
  });

  it('independently observed: unreadable input exits 1 IO_ERROR', async () => {
    const result = await invoke(path.join(tempDir, 'missing.json'), ['--json']);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'IO_ERROR' } });
  });

  it('independently observed: usage errors exit 2 USAGE_ERROR', async () => {
    stdoutSpy.mockClear();
    stderrSpy.mockClear();
    expect(await main(['acceptance', 'record'])).toBe(2);
    expect(stdoutText()).toBe('');
    expect(JSON.parse(stderrText())).toMatchObject({ error: { code: 'USAGE_ERROR' } });

    stdoutSpy.mockClear();
    stderrSpy.mockClear();
    expect(await main(['acceptance'])).toBe(2);
    expect(JSON.parse(stderrText())).toMatchObject({ error: { code: 'USAGE_ERROR' } });

    stdoutSpy.mockClear();
    stderrSpy.mockClear();
    expect(await main(['acceptance', 'record', 'a.json', 'b.json'])).toBe(2);
    expect(JSON.parse(stderrText())).toMatchObject({ error: { code: 'USAGE_ERROR' } });
  });

  it('independently observed: input fixture is not modified', async () => {
    const fixture = baseFixture([passedRow('typecheck')]);
    const filePath = await writeFixture('immutable.json', fixture);
    const before = await readFile(filePath, 'utf8');
    const result = await invoke(filePath, ['--json']);
    expect(result.code).toBe(0);
    expect(await readFile(filePath, 'utf8')).toBe(before);
  });

  it('independently observed: unreadable directory path is IO_ERROR', async () => {
    const result = await invoke(tempDir, ['--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'IO_ERROR' } });
  });
});

describe('acceptance record git-free process spawn', () => {
  it('independently observed: works from a non-git cwd and never invokes git or fixture commands', async () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const cwd = await mkdtemp(path.join(tmpdir(), 'acceptance-nongit-'));
    const binDir = path.join(cwd, 'bin');
    const fixturePath = path.join(cwd, 'fixture.json');
    const gitStamp = path.join(cwd, 'git-invoked');
    const cmdStamp = path.join(cwd, 'cmd-invoked');
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(binDir);
      await writeFile(
        path.join(binDir, 'git'),
        `#!/bin/sh\nprintf 'invoked\\n' > '${gitStamp}'\nexit 97\n`,
        { encoding: 'utf8', mode: 0o755 },
      );
      await writeFile(
        path.join(binDir, SENTINEL_COMMAND),
        `#!/bin/sh\nprintf 'invoked\\n' > '${cmdStamp}'\nexit 97\n`,
        { encoding: 'utf8', mode: 0o755 },
      );
      await chmod(path.join(binDir, 'git'), 0o755);
      await chmod(path.join(binDir, SENTINEL_COMMAND), 0o755);
      await writeFile(fixturePath, `${JSON.stringify(baseFixture([passedRow('typecheck')]))}\n`, 'utf8');
      const cli = path.join(packageRoot, 'backend/src/cli/index.ts');
      const tsx = path.join(packageRoot, 'node_modules/tsx/dist/cli.mjs');
      const result = spawnSync(process.execPath, [tsx, cli, 'acceptance', 'record', fixturePath, '--json'], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
        timeout: 20_000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'passed', schemaVersion: AcceptanceEvidenceSchemaVersion });
      await expect(readFile(gitStamp, 'utf8')).rejects.toThrow();
      await expect(readFile(cmdStamp, 'utf8')).rejects.toThrow();
      expect(cwd.includes('.git')).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
