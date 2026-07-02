import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'backend/src/db/schema.ts',
  out: 'backend/src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://goal:goal@localhost:5432/goal_gen',
  },
});
