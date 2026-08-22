/**
 * Tests for evidence/store.ts: sequential stable ids, schema-validated records, canonicalized
 * (sorted-key, undefined-dropped) content hashing so hash equality doesn't depend on JS key
 * insertion order, and a JSONL write/read round trip.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceStore, readEvidenceJsonl, writeEvidenceJsonl } from '../../backend/src/evidence/store';

const FIXED_CLOCK = () => new Date('2024-06-01T00:00:00.000Z');

describe('evidence/store', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('assigns sequential stable ids and a schema-valid retrievedAt from the injected clock', () => {
    const store = new EvidenceStore(FIXED_CLOCK);
    const a = store.add({ sourceType: 'repository-file', sensitivity: 'public', facts: ['a'] });
    const b = store.add({ sourceType: 'repository-file', sensitivity: 'public', facts: ['b'] });
    expect(a.id).toBe('ev-0001');
    expect(b.id).toBe('ev-0002');
    expect(a.retrievedAt).toBe('2024-06-01T00:00:00.000Z');
  });

  it('two records with identical fact payloads get identical contentHash; different payloads differ', () => {
    const store = new EvidenceStore(FIXED_CLOCK);
    const a = store.add({ sourceType: 'repository-file', path: 'README.md', sensitivity: 'public', facts: ['x'] });
    const b = store.add({ sourceType: 'repository-file', path: 'README.md', sensitivity: 'public', facts: ['x'] });
    const c = store.add({ sourceType: 'repository-file', path: 'README.md', sensitivity: 'public', facts: ['y'] });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
    expect(a.contentHash.length).toBeGreaterThanOrEqual(16);
  });

  it('a protected-metadata record carries facts but no excerpt', () => {
    const store = new EvidenceStore(FIXED_CLOCK);
    const record = store.add({
      sourceType: 'git-metadata',
      path: '.env',
      sensitivity: 'protected-metadata',
      facts: ['path=.env', 'size=123', 'hash=abc123'],
    });
    expect(record.sensitivity).toBe('protected-metadata');
    expect(record.excerpt).toBeUndefined();
  });

  it('list() returns records in insertion order and never mutates', () => {
    const store = new EvidenceStore(FIXED_CLOCK);
    store.add({ sourceType: 'repository-file', sensitivity: 'public', facts: ['1'] });
    store.add({ sourceType: 'repository-file', sensitivity: 'public', facts: ['2'] });
    const snapshot = store.list();
    expect(snapshot.map((r) => r.id)).toEqual(['ev-0001', 'ev-0002']);
  });

  it('writeEvidenceJsonl + readEvidenceJsonl round-trips validated records, and overwrites on rerun', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'goal-gen-evidence-store-'));
    const filePath = join(tmpDir, 'nested', 'evidence.jsonl');

    const first = new EvidenceStore(FIXED_CLOCK);
    first.add({ sourceType: 'repository-file', sensitivity: 'public', facts: ['first-run'] });
    await writeEvidenceJsonl(filePath, first);

    const second = new EvidenceStore(FIXED_CLOCK);
    second.add({ sourceType: 'repository-file', sensitivity: 'public', facts: ['second-run'] });
    await writeEvidenceJsonl(filePath, second);

    const readBack = await readEvidenceJsonl(filePath);
    // Overwritten, not appended: only the second run's record survives.
    expect(readBack).toHaveLength(1);
    expect(readBack[0]!.facts).toEqual(['second-run']);
    expect(readBack[0]!.id).toBe('ev-0001');
  });
});
