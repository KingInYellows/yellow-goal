import { readFileSync } from 'node:fs';

try {
  const pkg = JSON.parse(readFileSync('goal-gen/package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('goal-gen/package-lock.json', 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) process.exit(1);
  if (typeof lock !== 'object' || lock === null || Array.isArray(lock)) process.exit(1);
  if (typeof pkg.name !== 'string' || pkg.name === '' || typeof pkg.version !== 'string' || pkg.version === '') {
    process.exit(1);
  }
  if (lock.lockfileVersion !== 3) process.exit(1);
  if (lock.name !== pkg.name || lock.version !== pkg.version) process.exit(1);
  const root = lock.packages?.[''];
  if (typeof root !== 'object' || root === null || Array.isArray(root)) process.exit(1);
  if (root.name !== pkg.name || root.version !== pkg.version) process.exit(1);
  process.exit(0);
} catch {
  process.exit(1);
}
