process.on('SIGTERM', () => {
  setTimeout(() => process.exit(0), 50);
});
setInterval(() => {
  /* keep the event loop alive until killed */
}, 1000);
