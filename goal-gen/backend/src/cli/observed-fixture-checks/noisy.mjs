const chunk = 'n'.repeat(1024);
for (let i = 0; i < 2000; i += 1) {
  process.stdout.write(chunk);
}
