import { readFileSync } from 'node:fs';

try {
  const site = readFileSync('SITE', 'utf8');
  if (!site.endsWith('\n') || site.slice(0, -1).includes('\n')) process.exit(1);
  const host = site.slice(0, -1);
  const data = JSON.parse(readFileSync('site.json', 'utf8'));
  process.exit(data.host === host ? 0 : 1);
} catch {
  process.exit(1);
}
