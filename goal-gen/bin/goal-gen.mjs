#!/usr/bin/env node
/**
 * Installed-package entry point (ADR-0016). The engine ships as TypeScript source (extensionless
 * imports under `moduleResolution: Bundler` — not loadable by Node's native type stripping), so
 * this shim loads the CLI through tsx's ESM API and calls its exported `main` directly. Same
 * contract as `npm run cli --` in a checkout: JSON stdout, single-line structured stderr errors,
 * exit 2 = USAGE_ERROR / 1 = other failures.
 */
import { tsImport } from 'tsx/esm/api';

// Load-time failures (packlist gap, ESM resolution, tsx incompatibility) happen before the
// CLI's own catch-all is reachable, so this boundary keeps the stderr contract structured
// even then. Reuses the documented UNEXPECTED_ERROR code rather than minting a shim-only one.
try {
  const cli = await tsImport('../backend/src/cli/index.ts', import.meta.url);
  if (typeof cli.main !== 'function') {
    throw new Error('CLI module loaded but did not export a main() function');
  }
  process.exitCode = await cli.main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${JSON.stringify({ error: { code: 'UNEXPECTED_ERROR', message } })}\n`);
  process.exitCode = 1;
}
