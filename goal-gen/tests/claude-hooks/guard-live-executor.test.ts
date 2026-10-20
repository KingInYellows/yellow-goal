import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The repo-root PreToolUse guard (.claude/hooks/guard-live-executor.mjs) that blocks real-spend
// commands in Claude Code sessions. Exit 2 blocks the Bash call; exit 0 lets it through.
const GUARD = fileURLToPath(new URL('../../../.claude/hooks/guard-live-executor.mjs', import.meta.url));
const GOAL_GEN = fileURLToPath(new URL('../..', import.meta.url));

const BLOCKED_STDERR =
  'Blocked: the M1 runner (npm run runner) can invoke real claude -p. Real-spend commands are human-only (goal-gen/CLAUDE.md). Use --executor stub for tests.\n';

function guard(command: string, cwd?: string): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_input: { command }, ...(cwd ? { cwd } : {}) }),
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr };
}

const BLOCKED = [
  'npm run runner',
  'npm run-script runner',
  'pnpm runner',
  'yarn runner',
  'npm -- run runner',
  'npx -- npm run runner',
  'npm run -- runner',
  'npm run runner -- --yes goal',
  'npm run --prefix goal-gen runner -- goal',
  'pnpm --filter goal-gen runner -- goal',
  'cd goal-gen && npm run runner -- goal',
  '/usr/bin/npm run runner',
  'npm run --prefix goal-gen runner',
  "git commit -m \"$(cat <<'EOF'\nfix: don't crash\nEOF\n)\" && npm run runner",
  'npm run -w goal-gen runner',
  'pnpm --filter goal-gen runner',
  'yarn --cwd goal-gen runner',
  'npm run cli -- run --id 3 approve',
  'npm run test -- approve',
  'npm run cli -- run r.json --executor claude-code',
  'npm run cli -- run r.json --executor=agx-claude-code',
  'npx tsx backend/src/runner.ts',
  'npm run runner>run.log',
  'npm run runner>&1',
  'true && npm run runner',
  'true; npm run runner',
  'true | npm run runner',
  'sleep 1 & npm run runner',
  '(npm run runner)',
  'FOO=1 npm run runner',
  'env FOO=1 npm run runner',
  'timeout 600 npm run runner',
  'sudo -u me npm run runner',
  'nohup npm run runner &',
  'bash -c "npm run runner"',
  'eval "npm run runner"',
  'echo "$(npm run runner)"',
  'echo `npm run runner`',
  'cd goal-gen\nnpm run runner',
  '>/dev/null npm run runner',
  'npm run runner 2>&1',
  'if true; then npm run runner; fi',
  'time -p npm run runner',
  'A=1 B=2 npm run runner',
  'timeout -s TERM 30 npm run runner',
  'env -u FOO npm run runner',
  "sh -lc 'npm run cli -- run approve'",
  "bash -c -- 'npm run runner'",
  'eval npm run runner',
  'npm rum runner',
  'npm run \\\nrunner',
  'cat <<EOF\n$(npm run runner)\nEOF',
  'cat <<EOF\n`npm run runner`\nEOF',
  '>|run.log npm run runner',
  'echo $(printf ")"; npm run runner)',
  'echo "$(printf "(" ; npm run runner)"',
  "cat <<EOF\ndon't\n$(npm run runner)\nEOF",
  'cat <<EOF\nsay "hi\n$(npm run runner)\nEOF',
  'cat <<\\EOF\nhello\nEOF\nnpm run runner',
  'cat <<E\\OF\nhello\nEOF\nnpm run runner',
  'cat <<<"x"\nnpm run runner',
  'cat <<<\nnpm run runner',
  'echo "$(echo "$(npm run runner)")"',
  'env -C goal-gen npm run runner',
  'env --chdir goal-gen npm run runner',
  'sudo -D /repo npm run runner',
  'sudo -g staff npm run runner',
  'sudo -h localhost npm run runner',
  'sudo -Eu me npm run runner',
  'sudo -uroot npm run runner',
  'sudo -Euroot npm run runner',
  'bash -c "npm run \\\nrunner"',
  'npm run "run\\\nner"',
  'bash -o pipefail -c "npm run runner"',
  'bash -euo pipefail -c "npm run runner"',
  "bash +O extglob -c 'npm run runner'",
];

const ALLOWED = [
  'npm test',
  'npm run typecheck',
  'npm run eval',
  'npm run cli -- run r.json --executor stub',
  'echo "npm run runner"',
  'grep "npm run runner" CLAUDE.md',
  'git commit -m "block npm run runner in the guard"',
  '# npm run runner',
  'npm run cli -- run runner.json --executor stub',
  'npm run test -- runner',
  'npm run -w runner test',
  "git commit -m \"$(cat <<'EOF'\nfix: don't crash\nEOF\n)\"",
  'npm run cli -- run r.json --executor stub\necho approve',
  'npm run runner2>&1',
  'npm run runner2>file',
  'command -v npm',
  'command -V npm',
  'setsid npm run runner',
  'npm run- runner',
  'cat <<EOF\nnpm run runner\nEOF',
  'cat <<EOF\n\\$(npm run runner)\nEOF',
  "cat <<'EOF'\n$(npm run runner)\nEOF",
  'cat <<\\EOF\n$(npm run runner)\nEOF',
  'npm run "run\\ner"',
  'bash -o pipefail scripts/install-smoke.sh',
];

const ZERO_SPEND = [
  'node scripts/installed-protocol-smoke.mjs',
  'bash scripts/install-smoke.sh',
  'bash scripts/operator-real-run-recipe.sh',
  'bash scripts/operator-committed-source-paths.sh',
];

describe('guard-live-executor', () => {
  it.each(BLOCKED)('blocks %j', (command) => {
    expect(guard(command).status).toBe(2);
  });

  it.each(ALLOWED)('allows %j', (command) => {
    expect(guard(command).status).toBe(0);
  });

  it.each(ZERO_SPEND)('allows the zero-spend script %j', (command) => {
    expect(guard(command, GOAL_GEN).status).toBe(0);
  });

  it('writes the real-spend sentence when it blocks', () => {
    const r = guard('npm run runner');
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(BLOCKED_STDERR);
  });

  it('lets malformed hook input through', () => {
    const r = spawnSync(process.execPath, [GUARD], { input: '{', encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});
