import { readFileSync } from 'node:fs';

const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;

try {
  const data = JSON.parse(readFileSync('site.json', 'utf8'));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) process.exit(1);
  if (typeof data.host !== 'string' || !HOST.test(data.host) || data.host.includes('..')) process.exit(1);
  if (data.mode !== 'offline') process.exit(1);
  if (typeof data.retries !== 'number' || !Number.isInteger(data.retries) || data.retries < 1 || data.retries > 5) {
    process.exit(1);
  }
  process.exit(0);
} catch {
  process.exit(1);
}
