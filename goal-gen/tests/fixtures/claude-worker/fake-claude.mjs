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
// noise-only are hostile or edge scenarios that reuse the success envelope.
// Envelopes marked `_synthetic` were never observed from a real CLI (spike §3). budget-stop,
// max-turns and permission-denial are the envelopes the AGX-R34 permission probe recorded on
// 2.1.285 (tests/spikes/permission-probe-findings.md).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
};

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

  appendFileSync(
    recordPath,
    `${JSON.stringify({
      scenario: scenarioName,
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
  if (scenario.touchesNoise) writeFileSync('ruvector.db', 'changed by the worker\n');

  const envelopeName = scenario.envelope ?? scenarioName;
  process.stdout.write(scenario.stdout ?? readFileSync(path.join(here, 'envelopes', `${envelopeName}.json`), 'utf8'));
  // exitCode, not exit(): let Node flush stdout to the pipe first.
  process.exitCode = scenario.exitCode;
}
