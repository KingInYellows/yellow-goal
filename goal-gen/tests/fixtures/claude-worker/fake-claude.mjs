// Fake `claude` worker for the approval-gated real run (AGX-R32). CI never spawns a real
// `claude`: engine tests inject this script through the executor's `workerCommand` constructor
// option (AGX-R15), never through PATH or an environment variable.
//
// Invocation: node fake-claude.mjs --scenario <name> --record <file> <claude argv...>
//
// It appends one JSON line per invocation to --record (the claude argv, the prompt read from
// stdin, cwd, and only the *presence* of ANTHROPIC_API_KEY), then prints the scenario's envelope
// (inline stdout for malformed-output) and exits with the scenario's code. Scenarios with
// writesCandidate also write a repaired config-repair candidate into cwd; gitfile-rewrite and
// noise-only are hostile or edge scenarios that reuse the success envelope, as do the shell 03
// scenarios below: unsafe allowed paths (symlink, FIFO, oversize), an out-of-scope write and a
// wrong repair. hang never exits; descendant-ignores-sigterm also leaves a grandchild that traps
// SIGTERM and records its pid, to prove the engine kills the whole process group (AGX-R14).
// Envelopes marked `_synthetic` were never observed from a real CLI (spike §3). budget-stop,
// max-turns and permission-denial are the envelopes the AGX-R34 permission probe recorded on
// 2.1.285 (tests/spikes/permission-probe-findings.md).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const SCENARIOS = {
  success: { exitCode: 0, writesCandidate: true },
  'error-result': { exitCode: 1 },
  'budget-stop': { exitCode: 1 },
  'max-turns': { exitCode: 1 },
  'permission-denial': { exitCode: 0 },
  'malformed-output': { exitCode: 0, stdout: 'Error: this is not a result envelope\n' },
  'missing-cost': { exitCode: 0, writesCandidate: true },
  // Hostile worker: points the worktree's .git gitfile at a planted repo whose config sets
  // core.fsmonitor, so an unpinned engine `git status` would run the command.
  'gitfile-rewrite': { exitCode: 0, writesCandidate: true, envelope: 'success', rewritesGitfile: true },
  // Touches only a tracked activity-oracle noise file (ruvector.db), nothing meaningful.
  'noise-only': { exitCode: 0, envelope: 'success', touchesNoise: true },
  // Never exits: only the engine's timeout, cancel or wall-clock ends it.
  hang: { hangs: true },
  'descendant-ignores-sigterm': { hangs: true, spawnsDescendant: true },
  // Allowed path replaced by a symlink to `operator-secret.txt` beside the --record file, i.e.
  // outside the worktree; the engine must never read it.
  'symlink-allowed-path': { exitCode: 0, writesCandidate: true, envelope: 'success', unsafeAllowedPath: 'symlink' },
  'fifo-allowed-path': { exitCode: 0, writesCandidate: true, envelope: 'success', unsafeAllowedPath: 'fifo' },
  'oversize-allowed-path': { exitCode: 0, writesCandidate: true, envelope: 'success', unsafeAllowedPath: 'oversize' },
  // A correct repair plus a file outside the allowed paths (evidence only, never a failure).
  'out-of-scope-write': { exitCode: 0, writesCandidate: true, envelope: 'success', writesOutOfScope: true },
  // A correct repair plus an out-of-scope file hidden behind a self-ignoring .gitignore.
  'gitignore-hide': { exitCode: 0, writesCandidate: true, envelope: 'success', writesOutOfScope: true, hidesWithGitignore: true },
  // More stdout than the engine keeps (8 MiB) before an otherwise valid success envelope.
  'stdout-flood': { exitCode: 0, writesCandidate: true, envelope: 'success', floodsStdout: true },
  // Exits normally after starting a grandchild in a new session (outside the worker's process
  // group) that ignores SIGTERM and keeps the worker's stdout/stderr open.
  'descendant-escapes-group': { exitCode: 0, writesCandidate: true, envelope: 'success', spawnsEscapedDescendant: true },
  // Valid JSON that fails the schema-host and site-bind checks.
  'wrong-repair': { exitCode: 0, envelope: 'success', writesWrongRepair: true },
};

/** Larger than config-repair's maxFileBytes (16384). */
const OVERSIZE_BYTES = 20_000;

function makeUnsafeAllowedPath(kind, recordPath) {
  rmSync('site.json', { force: true });
  if (kind === 'symlink') {
    symlinkSync(path.join(path.dirname(path.resolve(recordPath)), 'operator-secret.txt'), 'site.json');
  } else if (kind === 'fifo') {
    const made = spawnSync('mkfifo', ['site.json']);
    if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
  } else {
    writeFileSync('site.json', 'x'.repeat(OVERSIZE_BYTES));
  }
}

/**
 * A grandchild that ignores SIGTERM and inherits stdout/stderr. By default it stays in the
 * worker's process group; `escape` starts it in a new session, out of the group's reach.
 */
function spawnSigtermIgnoringDescendant(escape = false) {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);"],
    { stdio: ['ignore', 'inherit', 'inherit'], detached: escape },
  );
  if (escape) child.unref();
  return child.pid;
}

const FLOOD_BYTES = 9 * 1024 * 1024;

function plantGitfileRedirect() {
  mkdirSync('planted/objects', { recursive: true });
  mkdirSync('planted/refs/heads', { recursive: true });
  writeFileSync('planted/HEAD', 'ref: refs/heads/main\n');
  writeFileSync(
    'planted/config',
    '[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "touch fsmonitor-ran; false"\n',
  );
  writeFileSync('.git', 'gitdir: ./planted\n');
}

const args = process.argv.slice(2);
if (args[0] !== '--scenario' || args[2] !== '--record' || args[1] === undefined || args[3] === undefined) {
  process.stderr.write('fake-claude: usage: --scenario <name> --record <file> <claude argv...>\n');
  process.exitCode = 64;
} else if (!Object.hasOwn(SCENARIOS, args[1])) {
  process.stderr.write(`fake-claude: unknown scenario ${args[1]}\n`);
  process.exitCode = 64;
} else {
  run(args[1], args[3], args.slice(4));
}

function run(scenarioName, recordPath, claudeArgv) {
  const scenario = SCENARIOS[scenarioName];
  const descendantPid = scenario.spawnsDescendant || scenario.spawnsEscapedDescendant
    ? spawnSigtermIgnoringDescendant(Boolean(scenario.spawnsEscapedDescendant))
    : undefined;

  appendFileSync(
    recordPath,
    `${JSON.stringify({
      scenario: scenarioName,
      ...(descendantPid === undefined ? {} : { descendantPid }),
      argv: claudeArgv,
      // Real runs pipe the prompt on stdin; the legacy path leaves stdin empty.
      prompt: readFileSync(0, 'utf8'),
      cwd: process.cwd(),
      apiKeyPresent: typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY !== '',
    })}\n`,
  );

  if (scenario.writesCandidate) {
    writeFileSync('site.json', '{"host":"alpha.test","retries":2,"mode":"offline"}\n');
    writeFileSync('SITE', 'alpha.test\n');
  }
  if (scenario.rewritesGitfile) plantGitfileRedirect();
  if (scenario.unsafeAllowedPath) makeUnsafeAllowedPath(scenario.unsafeAllowedPath, recordPath);
  if (scenario.writesOutOfScope) writeFileSync('other.txt', 'outside the allowed paths\n');
  if (scenario.hidesWithGitignore) writeFileSync('.gitignore', '*\n');
  if (scenario.writesWrongRepair) {
    writeFileSync('site.json', '{"host":"alpha.test","retries":2,"mode":"live"}\n');
    writeFileSync('SITE', 'beta.test\n');
  }
  if (scenario.hangs) {
    setInterval(() => {}, 1 << 30);
    return;
  }
  if (scenario.touchesNoise) writeFileSync('ruvector.db', 'changed by the worker\n');

  if (scenario.floodsStdout) process.stdout.write('x'.repeat(FLOOD_BYTES));
  const envelopeName = scenario.envelope ?? scenarioName;
  process.stdout.write(scenario.stdout ?? readFileSync(path.join(here, 'envelopes', `${envelopeName}.json`), 'utf8'));
  // exitCode, not exit(): let Node flush stdout to the pipe first.
  process.exitCode = scenario.exitCode;
}
