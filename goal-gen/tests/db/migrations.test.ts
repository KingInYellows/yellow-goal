/**
 * Migration gate: the journal-driven SQL migrations (`backend/src/db/migrations/`, applied in
 * production via `drizzle-kit migrate`, R35) must apply cleanly against a fresh Postgres. The
 * rest of `tests/db/` provisions its schema with `pushSchema` — which never reads the SQL
 * files — so without this test a broken or missing migration only surfaces on a live deploy.
 *
 * Runs against embedded PGlite like the other db tests: no Docker, no `DATABASE_URL`, safe
 * under plain `npm test` and CI.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../../backend/src/db/schema';
import { createTestDb } from './pglite-setup';

const migrationsFolder = fileURLToPath(new URL('../../backend/src/db/migrations', import.meta.url));

/**
 * Structural snapshot of the public schema, taken from Postgres's own catalogs so both
 * provisioning paths (SQL migrations vs `pushSchema`) are normalized identically. Deliberately
 * NOT drizzle-kit's diff: its snapshot-vs-introspection comparison reports false drift (e.g.
 * numeric default `0` vs `'0'`), while `column_default` text from two live instances compares
 * cleanly.
 *
 * `constraints` and `indexes` compare `pg_get_constraintdef`/`indexdef` TEXT rather than raw
 * catalog rows, sorted independent of any OID or creation order, so an ordinary index, a check
 * constraint, or an FK's `onDelete`/`onUpdate` behavior added to `schema.ts` without a migration
 * shows up as drift here too — the prior version only recorded `information_schema
 * .table_constraints`, which excludes plain indexes and check/referential-action detail.
 * `contype` is filtered to `c`/`f`/`p`/`u` (check, foreign key, primary key, unique); Postgres 18's
 * auto-generated NOT NULL constraints (`contype = 'n'`) are deliberately excluded — their
 * synthetic per-column names are redundant with `is_nullable` above, already captured in
 * `columns`, and not worth a second, riskier representation.
 */
async function publicSchemaFingerprint(client: PGlite) {
  const columns = await client.query(
    `select table_name, column_name, data_type, is_nullable, column_default,
            character_maximum_length, numeric_precision, numeric_scale, udt_name,
            datetime_precision
     from information_schema.columns
     where table_schema = 'public'
     order by table_name, column_name`,
  );
  const enums = await client.query(
    `select typname, enumlabel
     from pg_enum join pg_type on pg_type.oid = enumtypid
     order by typname, enumsortorder`,
  );
  const constraints = await client.query(
    // `conname` is selected explicitly: pg_get_constraintdef() renders the definition WITHOUT the
    // constraint's name, so a migration that only renames a constraint would otherwise fingerprint
    // identically to schema.ts and slip through this gate. (Index names need no such column —
    // pg_indexes.indexdef embeds them.)
    `select conrelid::regclass::text as table_name, conname, contype,
            pg_get_constraintdef(pg_constraint.oid) as definition
     from pg_constraint
     join pg_class on pg_class.oid = conrelid
     join pg_namespace on pg_namespace.oid = pg_class.relnamespace
     where pg_namespace.nspname = 'public'
       and contype in ('c', 'f', 'p', 'u')
     order by table_name, conname, contype, definition`,
  );
  const indexes = await client.query(
    `select tablename as table_name, indexdef as definition
     from pg_indexes
     where schemaname = 'public'
     order by table_name, definition`,
  );
  return { columns: columns.rows, enums: enums.rows, constraints: constraints.rows, indexes: indexes.rows };
}

describe('journal-driven SQL migrations against PGlite', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
  });

  it('records every journal entry as applied', async () => {
    const journal = JSON.parse(await readFile(`${migrationsFolder}/meta/_journal.json`, 'utf8')) as {
      entries: { tag: string }[];
    };
    expect(journal.entries.length).toBeGreaterThan(0);
    const applied = await client.query<{ count: number }>(
      'select count(*)::int as count from drizzle.__drizzle_migrations',
    );
    expect(applied.rows[0]?.count).toBe(journal.entries.length);
  });

  it('creates every table the app schema declares', async () => {
    const result = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    const tables = result.rows.map((r) => r.table_name);
    expect(tables).toEqual(['agent_runs', 'goal_specs', 'plan_steps', 'plans', 'run_events', 'runs']);
  });

  it("includes 'awaiting-acceptance' in run_status (migration 0001)", async () => {
    const result = await client.query<{ label: string }>(
      "select enumlabel as label from pg_enum join pg_type on pg_type.oid = enumtypid where typname = 'run_status' order by enumsortorder",
    );
    expect(result.rows.map((r) => r.label)).toContain('awaiting-acceptance');
  });

  it('is idempotent — re-running the migrator applies nothing new', async () => {
    const before = await client.query<{ count: number }>(
      'select count(*)::int as count from drizzle.__drizzle_migrations',
    );
    await migrate(db, { migrationsFolder });
    const after = await client.query<{ count: number }>(
      'select count(*)::int as count from drizzle.__drizzle_migrations',
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('fully covers schema.ts — no drift between migrations and the drizzle schema', async () => {
    // If schema.ts changed without a `drizzle-kit generate`, the migration-provisioned database
    // diverges structurally from a pushSchema-provisioned one (the truth the rest of tests/db/
    // runs against) and this comparison names the exact column/enum/constraint.
    const pushed = await createTestDb();
    const migrated = await publicSchemaFingerprint(client);
    const fromSchemaTs = await publicSchemaFingerprint(pushed.client);
    expect(migrated).toEqual(fromSchemaTs);
  });
});
