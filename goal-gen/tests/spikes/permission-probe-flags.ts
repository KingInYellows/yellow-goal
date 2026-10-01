/**
 * Every flag the real-run executor emits, checked against `claude --help` by the permission
 * probe's `flags` mode. Its own module so a vitest suite can pin it to the executor's actual argv
 * (importing the probe itself would run it).
 */
export const EXECUTOR_FLAGS: readonly string[] = [
  '--output-format',
  '--permission-mode',
  '--model',
  '--max-turns',
  '--allowedTools',
  '--disallowedTools',
  '--max-budget-usd',
  '--tools',
  '--setting-sources',
  '--strict-mcp-config',
];
