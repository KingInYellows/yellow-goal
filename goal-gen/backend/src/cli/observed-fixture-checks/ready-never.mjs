process.on('SIGTERM', () => {
  /* ignore termination so the observer must escalate to SIGKILL */
});
setInterval(() => {
  /* keep the event loop alive; never write GOAL_GEN_OBSERVER_READY */
}, 1000);
