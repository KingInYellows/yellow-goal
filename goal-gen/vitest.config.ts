import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Embedded PGlite (WASM Postgres) instances in tests/db/ can take well over vitest's 5s
    // default to boot + push/migrate a schema when several run in parallel workers (worse on
    // 2-core CI runners). These bound genuine hangs, not pace the suite — a fast run stays fast.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
