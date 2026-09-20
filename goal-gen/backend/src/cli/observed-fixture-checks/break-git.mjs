import { rmSync } from 'node:fs';

rmSync('.git', { recursive: true, force: true });
process.exit(0);
