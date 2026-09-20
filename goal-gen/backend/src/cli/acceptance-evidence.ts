/**
 * Git-free JSON-only acceptance-evidence recorder (VS spec layer 3).
 *
 * Compares observer-supplied fixture fields. Does not spawn git, does not
 * execute check `command`/`cwd`, and does not decide candidate acceptance.
 */
import { z } from 'zod';
import { AcceptanceEvidenceError } from './errors';

export const AcceptanceEvidenceSchemaVersion = 'yellow-goal/acceptance-evidence/v1' as const;
export const MUTATED_CANDIDATE_REASON = 'candidate mutated by check' as const;

const GIT_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const CheckStatusSchema = z.enum(['passed', 'failed', 'blocked', 'not-run']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type AggregateStatus = CheckStatus;

const GitObjectNameSchema = z
  .string()
  .regex(GIT_OBJECT_NAME, 'expected lowercase 40-hex SHA-1 or 64-hex SHA-256 object name');

const CandidateIdentitySchema = z
  .object({
    kind: z.enum(['commit', 'tree']),
    value: GitObjectNameSchema,
  })
  .strict();

export type CandidateIdentity = z.infer<typeof CandidateIdentitySchema>;

const RequiredCheckTupleSchema = z
  .object({
    id: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1),
  })
  .strict();

export type RequiredCheckTuple = z.infer<typeof RequiredCheckTupleSchema>;

const CheckRowInputSchema = z
  .object({
    id: z.string().min(1),
    status: CheckStatusSchema,
    command: z.string().min(1),
    cwd: z.string().min(1),
    candidateIdentity: CandidateIdentitySchema,
    preCheckTree: GitObjectNameSchema.optional(),
    postCheckTree: GitObjectNameSchema.optional(),
    exitStatus: z.number().int().nullable().optional(),
    reason: z.string().min(1).optional(),
    signal: z.string().min(1).optional(),
  })
  .strict();

export type CheckRowInput = z.infer<typeof CheckRowInputSchema>;

const FixtureSchema = z
  .object({
    schemaVersion: z.literal(AcceptanceEvidenceSchemaVersion),
    baseRevision: GitObjectNameSchema,
    candidateIdentity: CandidateIdentitySchema,
    candidateTree: GitObjectNameSchema,
    requiredChecks: z.array(RequiredCheckTupleSchema),
    checks: z.array(CheckRowInputSchema),
    status: CheckStatusSchema.optional(),
  })
  .strict();

export type AcceptanceCheckRow = {
  id: string;
  status: CheckStatus;
  command: string;
  cwd: string;
  candidateIdentity: CandidateIdentity;
  preCheckTree?: string;
  postCheckTree?: string;
  exitStatus?: number;
  reason?: string;
  signal?: string;
};

export type AcceptanceEvidenceRecord = {
  schemaVersion: typeof AcceptanceEvidenceSchemaVersion;
  baseRevision: string;
  candidateIdentity: CandidateIdentity;
  candidateTree: string;
  requiredChecks: RequiredCheckTuple[];
  status: AggregateStatus;
  checks: AcceptanceCheckRow[];
};

function fail(code: string, message: string, details?: unknown): never {
  throw new AcceptanceEvidenceError(code, message, details);
}

function identitiesEqual(left: CandidateIdentity, right: CandidateIdentity): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function collectObjectNames(fixture: z.infer<typeof FixtureSchema>): string[] {
  const names = [fixture.baseRevision, fixture.candidateIdentity.value, fixture.candidateTree];
  for (const row of fixture.checks) {
    names.push(row.candidateIdentity.value);
    if (row.preCheckTree !== undefined) names.push(row.preCheckTree);
    if (row.postCheckTree !== undefined) names.push(row.postCheckTree);
  }
  return names;
}

function assertUniformObjectNameFormat(names: string[]): void {
  const lengths = new Set(names.map((name) => name.length));
  if (lengths.size > 1) {
    fail(
      'SCHEMA_INVALID',
      'fixture mixes 40-hex SHA-1 and 64-hex SHA-256 object names',
      { lengths: [...lengths] },
    );
  }
}

function assertRequiredCheckSet(fixture: z.infer<typeof FixtureSchema>): Map<string, RequiredCheckTuple> {
  if (fixture.requiredChecks.length === 0) {
    fail('EMPTY_REQUIRED_CHECKS', 'requiredChecks must contain at least one {id, command, cwd} tuple');
  }

  const requiredById = new Map<string, RequiredCheckTuple>();
  for (const tuple of fixture.requiredChecks) {
    if (requiredById.has(tuple.id)) {
      fail('DUPLICATE_CHECK_ID', `duplicate requiredChecks id: ${tuple.id}`);
    }
    requiredById.set(tuple.id, tuple);
  }

  const seenCheckIds = new Set<string>();
  for (const row of fixture.checks) {
    if (seenCheckIds.has(row.id)) {
      fail('DUPLICATE_CHECK_ID', `duplicate checks id: ${row.id}`);
    }
    seenCheckIds.add(row.id);
    if (!requiredById.has(row.id)) {
      fail('UNEXPECTED_CHECK_ID', `checks id is not in requiredChecks: ${row.id}`);
    }
  }

  for (const tuple of fixture.requiredChecks) {
    if (!seenCheckIds.has(tuple.id)) {
      fail('MISSING_REQUIRED_CHECK', `requiredChecks id missing from checks: ${tuple.id}`);
    }
  }

  for (const row of fixture.checks) {
    const tuple = requiredById.get(row.id)!;
    if (row.command !== tuple.command || row.cwd !== tuple.cwd) {
      fail(
        'CHECK_BINDING_MISMATCH',
        `checks row ${row.id} command/cwd does not match requiredChecks tuple`,
        {
          id: row.id,
          expected: { command: tuple.command, cwd: tuple.cwd },
          actual: { command: row.command, cwd: row.cwd },
        },
      );
    }
  }

  return requiredById;
}

function hasExitStatus(row: CheckRowInput): boolean {
  return typeof row.exitStatus === 'number';
}

function hasExitStatusField(row: CheckRowInput): boolean {
  return row.exitStatus !== undefined;
}

function assertTreeKindBinding(fixture: z.infer<typeof FixtureSchema>): void {
  if (fixture.candidateIdentity.kind === 'tree' && fixture.candidateTree !== fixture.candidateIdentity.value) {
    fail(
      'SCHEMA_INVALID',
      'kind tree requires candidateTree to equal candidateIdentity.value',
      {
        candidateIdentity: fixture.candidateIdentity,
        candidateTree: fixture.candidateTree,
      },
    );
  }
}

function assertRowCandidateBinding(
  row: CheckRowInput,
  recordIdentity: CandidateIdentity,
  mutatedTrees: ReadonlySet<string>,
): void {
  if (identitiesEqual(row.candidateIdentity, recordIdentity)) return;
  if (mutatedTrees.has(row.candidateIdentity.value) && row.candidateIdentity.value !== recordIdentity.value) {
    fail(
      'UNVERIFIED_CANDIDATE_CREDIT',
      `checks row ${row.id} credits mutated candidate content without an independent rerun`,
      {
        recordCandidate: recordIdentity,
        rowCandidate: row.candidateIdentity,
      },
    );
  }
  fail(
    'CANDIDATE_MISMATCH',
    `checks row ${row.id} candidateIdentity does not match the record candidateIdentity`,
    {
      recordCandidate: recordIdentity,
      rowCandidate: row.candidateIdentity,
    },
  );
}

function assertLaunchedPrecheck(row: CheckRowInput, candidateTree: string): void {
  if (row.preCheckTree === undefined) {
    fail('SCHEMA_INVALID', `launched check ${row.id} is missing preCheckTree`);
  }
  if (row.preCheckTree !== candidateTree) {
    fail(
      'PRECHECK_TREE_MISMATCH',
      `checks row ${row.id} preCheckTree does not equal candidateTree`,
      { id: row.id, preCheckTree: row.preCheckTree, candidateTree },
    );
  }
}

function assertOutcomeFields(row: CheckRowInput, candidateTree: string): void {
  if (row.signal !== undefined && hasExitStatus(row)) {
    fail('SCHEMA_INVALID', `checks row ${row.id} cannot carry both signal and a numeric exitStatus`);
  }
  switch (row.status) {
    case 'not-run': {
      if (hasExitStatusField(row)) {
        fail('SCHEMA_INVALID', `not-run check ${row.id} must omit exitStatus`);
      }
      if (row.reason === undefined) {
        fail('SCHEMA_INVALID', `not-run check ${row.id} requires reason`);
      }
      if (row.reason === MUTATED_CANDIDATE_REASON) {
        fail(
          'SCHEMA_INVALID',
          `not-run check ${row.id} cannot use leftover-mutation reason "${MUTATED_CANDIDATE_REASON}"`,
        );
      }
      if (row.preCheckTree !== undefined || row.postCheckTree !== undefined) {
        fail('SCHEMA_INVALID', `not-run check ${row.id} must omit preCheckTree and postCheckTree`);
      }
      if (row.signal !== undefined) {
        fail('SCHEMA_INVALID', `not-run check ${row.id} must omit signal`);
      }
      return;
    }
    case 'passed': {
      assertLaunchedPrecheck(row, candidateTree);
      if (row.signal !== undefined) {
        fail('SCHEMA_INVALID', `passed check ${row.id} must omit signal`);
      }
      if (row.exitStatus !== 0) {
        fail('SCHEMA_INVALID', `passed check ${row.id} requires exitStatus 0`);
      }
      if (row.postCheckTree === undefined) {
        fail('SCHEMA_INVALID', `passed check ${row.id} requires postCheckTree`);
      }
      if (row.reason === MUTATED_CANDIDATE_REASON || row.postCheckTree !== row.preCheckTree) {
        fail(
          'INVALID_STATUS_FOR_MUTATED_CANDIDATE',
          `checks row ${row.id} reports passed after leftover candidate mutation`,
          { id: row.id, preCheckTree: row.preCheckTree, postCheckTree: row.postCheckTree, reason: row.reason },
        );
      }
      return;
    }
    case 'failed': {
      assertLaunchedPrecheck(row, candidateTree);
      if (row.signal !== undefined) {
        fail('SCHEMA_INVALID', `failed check ${row.id} must omit signal`);
      }
      if (!hasExitStatus(row) || row.exitStatus === 0) {
        fail('SCHEMA_INVALID', `failed check ${row.id} requires a normal nonzero exitStatus`);
      }
      if (row.postCheckTree === undefined) {
        fail('SCHEMA_INVALID', `failed check ${row.id} requires postCheckTree`);
      }
      if (row.reason === MUTATED_CANDIDATE_REASON || row.postCheckTree !== row.preCheckTree) {
        fail(
          'INVALID_STATUS_FOR_MUTATED_CANDIDATE',
          `checks row ${row.id} reports failed after leftover candidate mutation`,
          { id: row.id, preCheckTree: row.preCheckTree, postCheckTree: row.postCheckTree, reason: row.reason },
        );
      }
      return;
    }
    case 'blocked': {
      assertLaunchedPrecheck(row, candidateTree);
      if (row.reason === undefined && row.signal === undefined) {
        fail('SCHEMA_INVALID', `blocked check ${row.id} requires signal or reason`);
      }
      const mutated = row.postCheckTree !== undefined && row.postCheckTree !== row.preCheckTree;
      if (mutated && row.reason !== MUTATED_CANDIDATE_REASON) {
        fail(
          'INVALID_STATUS_FOR_MUTATED_CANDIDATE',
          `checks row ${row.id} leftover mutation must use reason "${MUTATED_CANDIDATE_REASON}"`,
          { id: row.id, preCheckTree: row.preCheckTree, postCheckTree: row.postCheckTree },
        );
      }
      if (!mutated && hasExitStatus(row) && row.reason !== MUTATED_CANDIDATE_REASON) {
        fail(
          'SCHEMA_INVALID',
          `blocked check ${row.id} with a Node exitStatus and no leftover mutation is contradictory`,
        );
      }
      return;
    }
    default: {
      const _exhaustive: never = row.status;
      fail('SCHEMA_INVALID', `unsupported check status: ${String(_exhaustive)}`);
    }
  }
}

function emitCheckRow(row: CheckRowInput): AcceptanceCheckRow {
  const emitted: AcceptanceCheckRow = {
    id: row.id,
    status: row.status,
    command: row.command,
    cwd: row.cwd,
    candidateIdentity: row.candidateIdentity,
  };
  if (row.preCheckTree !== undefined) emitted.preCheckTree = row.preCheckTree;
  if (row.postCheckTree !== undefined) emitted.postCheckTree = row.postCheckTree;
  if (hasExitStatus(row)) emitted.exitStatus = row.exitStatus as number;
  if (row.reason !== undefined) emitted.reason = row.reason;
  if (row.signal !== undefined) emitted.signal = row.signal;
  return emitted;
}

export function aggregateCheckStatuses(statuses: readonly CheckStatus[]): AggregateStatus {
  if (statuses.length === 0) {
    fail('EMPTY_REQUIRED_CHECKS', 'cannot aggregate an empty required-check set');
  }
  if (statuses.every((status) => status === 'passed')) return 'passed';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('failed')) return 'failed';
  return 'not-run';
}

export function recordAcceptanceEvidence(input: unknown): AcceptanceEvidenceRecord {
  const parsed = FixtureSchema.safeParse(input);
  if (!parsed.success) {
    fail('SCHEMA_INVALID', 'fixture is not a valid yellow-goal/acceptance-evidence/v1 document', parsed.error.flatten());
  }
  const fixture = parsed.data;
  assertUniformObjectNameFormat(collectObjectNames(fixture));
  assertTreeKindBinding(fixture);
  const requiredById = assertRequiredCheckSet(fixture);

  const mutatedTrees = new Set<string>();
  const orderedRows: CheckRowInput[] = fixture.requiredChecks.map((tuple) => {
    const row = fixture.checks.find((candidate) => candidate.id === tuple.id);
    if (row === undefined) {
      fail('MISSING_REQUIRED_CHECK', `requiredChecks id missing from checks: ${tuple.id}`);
    }
    return row;
  });

  const emittedRows: AcceptanceCheckRow[] = [];
  for (const row of orderedRows) {
    assertRowCandidateBinding(row, fixture.candidateIdentity, mutatedTrees);
    assertOutcomeFields(row, fixture.candidateTree);
    if (
      row.status !== 'not-run' &&
      row.postCheckTree !== undefined &&
      row.preCheckTree !== undefined &&
      row.postCheckTree !== row.preCheckTree
    ) {
      mutatedTrees.add(row.postCheckTree);
    }
    emittedRows.push(emitCheckRow(row));
  }

  const status = aggregateCheckStatuses(emittedRows.map((row) => row.status));
  if (fixture.status !== undefined && fixture.status !== status) {
    fail(
      'SCHEMA_INVALID',
      'fixture status does not match aggregate derived from check rows',
      { supplied: fixture.status, derived: status },
    );
  }

  return {
    schemaVersion: AcceptanceEvidenceSchemaVersion,
    baseRevision: fixture.baseRevision,
    candidateIdentity: fixture.candidateIdentity,
    candidateTree: fixture.candidateTree,
    requiredChecks: fixture.requiredChecks.map((tuple) => requiredById.get(tuple.id)!),
    status,
    checks: emittedRows,
  };
}
