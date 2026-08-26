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
 */
async function publicSchemaFingerprint(client: PGlite) {
  const columns = await client.query(
    `select table_name, column_name, data_type, is_nullable, column_default,
            character_maximum_length, numeric_precision, numeric_scale, udt_name
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
    `select tc.table_name, tc.constraint_name, tc.constraint_type,
            ccu.table_name as foreign_table, ccu.column_name as foreign_column
     from information_schema.table_constraints tc
     left join information_schema.constraint_column_usage ccu
       on ccu.constraint_name = tc.constraint_name and tc.constraint_type = 'FOREIGN KEY'
     where tc.table_schema = 'public'
     order by tc.table_name, tc.constraint_name, foreign_table, foreign_column`,
  );
  return { columns: columns.rows, enums: enums.rows, constraints: constraints.rows };
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
