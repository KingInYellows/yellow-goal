/**
 * Embedded WASM Postgres test fixture (PGlite) — no Docker daemon, no live `DATABASE_URL`, so
 * `tests/db/*.test.ts` run under plain `npm test` with no CI exclusion needed, unlike this repo's
 * existing `*.probe.ts` convention for tests that DO require a live external resource
 * (`tests/integration/runner.probe.ts`).
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { pushSchema } from 'drizzle-kit/api';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from '../../backend/src/db/schema';

export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  // `pushSchema`'s declared `PgDatabase<any>` type param defaults TFullSchema to
  // `Record<string, never>`, which our concrete schema never structurally matches (drizzle-kit's
  // own typing gap — flagged as under-documented in the deepen-plan external research); the
  // runtime call only needs a working PgDatabase instance.
  const { apply } = await pushSchema(schema, db as unknown as PgDatabase<any>);
  await apply();
  return { db, client };
}
