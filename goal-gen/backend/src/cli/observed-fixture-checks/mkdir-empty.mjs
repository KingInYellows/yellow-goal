import { mkdirSync } from 'node:fs';

mkdirSync('empty-leftover', { recursive: true });
process.exit(0);
