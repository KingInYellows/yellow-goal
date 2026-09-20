import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('keep/.git', { recursive: true });
writeFileSync('keep/.git/HEAD', 'ref: refs/heads/main\n');
process.exit(0);
