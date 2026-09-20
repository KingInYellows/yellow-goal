import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'STATUS';
try {
  const text = readFileSync(file, 'utf8');
  process.exit(text === 'ok\n' ? 0 : 1);
} catch {
  process.exit(1);
}
