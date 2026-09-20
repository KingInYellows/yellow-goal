import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => {
  /* ignore termination so the observer must escalate to SIGKILL */
});
setInterval(() => {
  /* keep the event loop alive until killed */
}, 1000);
const ready = process.env.GOAL_GEN_OBSERVER_READY;
if (ready) writeFileSync(ready, 'ready\n');
