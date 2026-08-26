#!/usr/bin/env node
/**
 * Installed-package entry point (ADR-0016). The engine ships as TypeScript source (extensionless
 * imports under `moduleResolution: Bundler` — not loadable by Node's native type stripping), so
 * this shim loads the CLI through tsx's ESM API and calls its exported `main` directly. Same
 * contract as `npm run cli --` in a checkout: JSON stdout, single-line structured stderr errors,
 * exit 2 = USAGE_ERROR / 1 = other failures.
 */
import { tsImport } from 'tsx/esm/api';

const cli = await tsImport('../backend/src/cli/index.ts', import.meta.url);
process.exitCode = await cli.main();
