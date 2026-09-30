import { defineConfig } from 'vitest/config';

/**
 * The real-run engine suites spawn many node/tsx subprocesses (the fake worker, the packed
 * recorder, the test-only harness). Run concurrently with the committed-source race tests on a
 * 2-core CI runner, they starve those tests' tamper threads, which then act too late to exercise
 * the race. They run as a later group, after every other file has finished.
 */
const PROCESS_HEAVY_REAL_RUN = ['tests/real-run/**/*.test.ts', 'tests/harness/real-run-harness.process.test.ts'];

export default defineConfig({
  test: {
    // `include` is set per project: with `extends: true` a project's list would add to a root one.
    environment: 'node',
    // Embedded PGlite (WASM Postgres) instances in tests/db/ can take well over vitest's 5s
    // default to boot + push/migrate a schema when several run in parallel workers (worse on
    // 2-core CI runners). These bound genuine hangs, not pace the suite — a fast run stays fast.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'default',
          include: ['tests/**/*.test.ts'],
          exclude: PROCESS_HEAVY_REAL_RUN,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: { name: 'real-run', include: PROCESS_HEAVY_REAL_RUN, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
