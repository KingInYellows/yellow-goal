import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const ready = process.env.GOAL_GEN_OBSERVER_READY;
const pidPath = ready === undefined ? undefined : `${ready}.descendant-pid`;
const child = spawn(
  process.execPath,
  [
    '-e',
    [
      "process.on('SIGHUP', () => {});",
      "process.on('SIGTERM', () => {});",
      "process.on('SIGINT', () => {});",
      "process.stdout.on('error', () => {});",
      "process.stderr.on('error', () => {});",
      "const fs = require('node:fs');",
      'const pidPath = process.env.GOAL_GEN_DESCENDANT_PID;',
      "if (pidPath) fs.writeFileSync(pidPath, String(process.pid) + '\\n');",
      'setInterval(() => {',
      "  try { process.stdout.write('d'.repeat(1024)); } catch (_) {}",
      '}, 20);',
    ].join('\n'),
  ],
  {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      GOAL_GEN_DESCENDANT_PID: pidPath ?? '',
    },
  },
);
if (child.pid === undefined) process.exit(1);

const started = Date.now();
const wait = () => {
  if (pidPath !== undefined && existsSync(pidPath)) {
    if (ready !== undefined) writeFileSync(ready, 'ready\n');
    process.exit(0);
  }
  if (Date.now() - started > 2_000) process.exit(1);
  setTimeout(wait, 5);
};
wait();
