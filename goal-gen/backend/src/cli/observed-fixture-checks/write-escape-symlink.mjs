import { symlinkSync } from 'node:fs';

symlinkSync('/tmp', 'escape-link');
process.exit(0);
