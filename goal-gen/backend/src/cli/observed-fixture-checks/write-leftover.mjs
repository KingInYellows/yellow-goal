import { writeFileSync } from 'node:fs';

writeFileSync('LEFTOVER.txt', 'mutated\n');
process.exit(0);
