import { lstatSync, readFileSync } from 'node:fs';

try {
  const pkg = JSON.parse(readFileSync('goal-gen/package.json', 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) process.exit(1);
  if (pkg.bin?.['goal-gen'] !== 'bin/goal-gen.mjs') process.exit(1);
  const st = lstatSync('goal-gen/bin/goal-gen.mjs');
  if (!st.isFile() || st.isSymbolicLink()) process.exit(1);
  const body = readFileSync('goal-gen/bin/goal-gen.mjs', 'utf8');
  if (!body.startsWith('#!/usr/bin/env node')) process.exit(1);
  process.exit(0);
} catch {
  process.exit(1);
}
