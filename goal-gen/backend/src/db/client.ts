/**
 * Drizzle db instance + `pg.Pool` setup (R35, ADR-0011: secrets via environment only).
 * Production entry point — tests use the embedded PGlite driver instead (see `tests/db/`).
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set — copy .env.example to .env and configure it`);
  }
  return value;
}

export const pool = new Pool({ connectionString: requiredEnv('DATABASE_URL') });
export const db = drizzle(pool, { schema });
