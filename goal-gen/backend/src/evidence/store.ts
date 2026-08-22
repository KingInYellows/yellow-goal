/**
 * Append-only evidence ledger. An `EvidenceStore` instance accumulates `EvidenceRecord`s
 * (contracts/evidence-record.ts) during a single inspection run — stable sequential ids
 * (`ev-0001`, `ev-0002`, ...), a `contentHash` computed over a canonicalized (sorted-key, no
 * `undefined`) view of the fact payload so the hash doesn't depend on JS object key insertion
 * order, and a `retrievedAt` timestamp taken from an injected clock (never `Date.now()` inline —
 * ADR-0011 / 06_SECURITY "Timestamps must be injectable").
 *
 * `add()` always validates through `EvidenceRecordSchema` before accepting a record — a
 * malformed record fails the run rather than silently landing in the ledger.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EvidenceRecordSchema } from '../contracts';
import type { EvidenceRecord } from '../contracts';

export interface EvidenceInput {
  sourceType: EvidenceRecord['sourceType'];
  repository?: string;
  ref?: string;
  targetSha?: string;
  path?: string;
  url?: string;
  sensitivity: EvidenceRecord['sensitivity'];
  facts: string[];
  /** Omit for protected-path metadata records — never carry blob content in an excerpt. */
  excerpt?: string;
  citationLabel?: string;
}

/** Deterministic, sorted-key JSON view of the fields that determine a record's content identity.
 *  `undefined` fields are dropped so an omitted optional field never perturbs the hash. */
function canonicalPayload(input: EvidenceInput): string {
  const fields: Record<string, unknown> = {
    sourceType: input.sourceType,
    repository: input.repository,
    ref: input.ref,
    targetSha: input.targetSha,
    path: input.path,
    url: input.url,
    sensitivity: input.sensitivity,
    facts: input.facts,
    excerpt: input.excerpt,
  };
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort()) {
    if (fields[key] !== undefined) sorted[key] = fields[key];
  }
  return JSON.stringify(sorted);
}

export class EvidenceStore {
  private readonly records: EvidenceRecord[] = [];
  private counter = 0;

  constructor(private readonly clock: () => Date) {}

  /** Assigns the next sequential id, computes contentHash, validates, and appends. Returns the
   *  stored (validated) record so callers can reference `record.id` from CommandRecord/finding. */
  add(input: EvidenceInput): EvidenceRecord {
    this.counter += 1;
    const id = `ev-${String(this.counter).padStart(4, '0')}`;
    const contentHash = `sha256:${createHash('sha256').update(canonicalPayload(input)).digest('hex')}`;
    const candidate = {
      schemaVersion: 'yellow-goal/evidence/v1' as const,
      id,
      sourceType: input.sourceType,
      ...(input.repository !== undefined ? { repository: input.repository } : {}),
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
      ...(input.targetSha !== undefined ? { targetSha: input.targetSha } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      retrievedAt: this.clock().toISOString(),
      contentHash,
      sensitivity: input.sensitivity,
      facts: input.facts,
      ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
      ...(input.citationLabel !== undefined ? { citationLabel: input.citationLabel } : {}),
    };
    const record = EvidenceRecordSchema.parse(candidate);
    this.records.push(record);
    return record;
  }

  list(): readonly EvidenceRecord[] {
    return this.records;
  }

  /** Newline-delimited JSON, one record per line, trailing newline when non-empty. */
  toJsonl(): string {
    if (this.records.length === 0) return '';
    return `${this.records.map((r) => JSON.stringify(r)).join('\n')}\n`;
  }
}

/** Writes (overwrites) a run's evidence ledger to `filePath` as JSONL, creating parent dirs. Each
 *  inspection run owns its own evidence.jsonl under its own output directory — overwriting (not
 *  appending across process invocations) is what keeps re-running inspect against the same
 *  outputDir deterministic instead of accumulating duplicate lines. */
export async function writeEvidenceJsonl(filePath: string, store: EvidenceStore): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, store.toJsonl(), 'utf8');
}

/** Reads a JSONL evidence ledger back, validating every line against EvidenceRecordSchema. */
export async function readEvidenceJsonl(filePath: string): Promise<EvidenceRecord[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => EvidenceRecordSchema.parse(JSON.parse(line)));
}
