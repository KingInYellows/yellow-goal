/**
 * TEST-ONLY process harness for the approval-gated real run (AGX-R15, AGX-R33). It lives under
 * `tests/`, so it is outside `package.json` `files` and never ships in the release tarball, and
 * the production bin never imports it (harness-isolation.test.ts). The fake worker is injected
 * through the executor constructor, never PATH or an environment variable.
 *
 * Engine mode drives the real-run engine end to end (verify → consume → seed → one fake-worker
 * attempt → ledger → extract → verify) and prints its `RealRunOutcome`:
 *
 *   node node_modules/tsx/dist/cli.mjs tests/harness/real-run-harness.ts \
 *     --request <request.json> --approval <approval.json> --state-dir <dir> \
 *     --scenario <name> --record <invocations.jsonl> <run manifest flags…>
 *
 *   Exit codes: 0 = verified, 1 = worker-failed or verification-rejected, 3 = refused, 2 = usage.
 *
 * Two more modes exist for the operator-recipe rehearsal (AGX-R33; docs/operator-real-run.md):
 *
 *   --mode mint-approval <request.json> <run manifest flags…> --out <approval.json>
 *     Mints an approval through the same injected-TTY seam `tests/real-run/support.ts` uses (CI has
 *     no human and never runs `run approve`). Prints `{approvalId,path}`; exit 0, usage 2.
 *   --mode protocol-v2 <request.json> --protocol v2 --executor agx-claude-code --approval <path> \
 *     <run manifest flags…> --scenario <name> --record <file> --state-dir <dir>
 *     The production argv through `parseRunInvocation` and `runProviderV2Real`, with the fake worker
 *     injected; stdout is the production JSONL stream and the exit code is the production contract
 *     (0 verified, 1 any failure, 2 usage) — not the engine-mode codes above.
 *
 * Executor mode (`--manifest <manifest.json> --scenario <name> --record <file>`) runs only the
 * executor against a seeded `config-repair` v2 worktree and prints a JSON summary. Exit codes:
 * 0 = worker succeeded, 1 = worker failed, 2 = usage or setup error.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CliUsageError } from '../../backend/src/cli/errors';
import { parseRunInvocation } from '../../backend/src/cli/protocol-run-options';
import { runProviderV2Real } from '../../backend/src/cli/provider-run-v2-real';
import { runRunApprove } from '../../backend/src/cli/run-approval-command';
import { getCandidateOfflineProfile } from '../../backend/src/cli/candidate-offline-profiles';
import type { RunManifest } from '../../backend/src/cli/run-manifest';
import { RUN_MANIFEST_OPTIONS } from '../../backend/src/cli/run-manifest-command';
import { createRealRunExecutor } from '../../backend/src/executors/real-run-executor';
import { createWorktree } from '../../backend/src/executors/worktree';
import { buildFixedAction } from '../../backend/src/real-run/fixed-goal';
import { runRealRun } from '../../backend/src/real-run/real-run-engine';
import type { RealRunOutcome } from '../../backend/src/real-run/outcome';
import { answeringTerminal } from '../real-run/answering-terminal';

const FAKE_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude-worker', 'fake-claude.mjs');

const USAGE =
  'usage: real-run-harness --request <file> --approval <file> --state-dir <dir> --scenario <name> --record <file> <manifest flags…>\n' +
  '   or: real-run-harness --manifest <file> --scenario <name> --record <file>\n';

const HARNESS_OPTIONS = {
  ...RUN_MANIFEST_OPTIONS,
  manifest: { type: 'string' },
  request: { type: 'string' },
  approval: { type: 'string' },
  'state-dir': { type: 'string' },
  scenario: { type: 'string' },
  record: { type: 'string' },
  mode: { type: 'string' },
  out: { type: 'string' },
} as const;

/** Options only the harness understands; everything else in `protocol-v2` mode is production argv. */
const HARNESS_ONLY = new Set(['mode', 'scenario', 'record', 'state-dir']);

function fakeWorker(scenario: string, record: string) {
  return { file: process.execPath, args: [FAKE_WORKER, '--scenario', scenario, '--record', path.resolve(record)] };
}

const OUTCOME_EXIT: Record<RealRunOutcome['kind'], number> = {
  verified: 0,
  'worker-failed': 1,
  'verification-rejected': 1,
  refused: 3,
};

/** Splits `--mode <m>`, `--scenario`, `--record`, `--state-dir` off the argv, leaving production argv. */
function splitProductionArgv(argv: string[]): { harness: Record<string, string>; rest: string[] } {
  const { tokens } = parseArgs({
    args: argv, strict: false, allowPositionals: true, tokens: true,
    options: { mode: { type: 'string' }, scenario: { type: 'string' }, record: { type: 'string' }, 'state-dir': { type: 'string' } },
  });
  const drop = new Set<number>();
  const harness: Record<string, string> = {};
  for (const token of tokens) {
    if (token.kind !== 'option' || !HARNESS_ONLY.has(token.name)) continue;
    drop.add(token.index);
    if (token.inlineValue === false) drop.add(token.index + 1);
    if (typeof token.value === 'string') harness[token.name] = token.value;
  }
  return { harness, rest: argv.filter((_arg, index) => !drop.has(index)) };
}

async function mintApprovalMode(argv: string[]): Promise<number> {
  const { rest } = splitProductionArgv(argv);
  const minted = await runRunApprove(rest, { terminal: answeringTerminal() });
  process.stdout.write(`${JSON.stringify({ approvalId: minted.output.approvalId, path: minted.output.path })}\n`);
  return 0;
}

async function protocolV2Mode(argv: string[]): Promise<number> {
  const { harness, rest } = splitProductionArgv(argv);
  if (!harness.scenario || !harness.record) {
    process.stderr.write(USAGE);
    return 2;
  }
  const { scenario, record } = harness;
  try {
    const invocation = parseRunInvocation(rest);
    if (invocation.mode !== 'provider-v2-real') throw new CliUsageError('protocol-v2 mode requires --protocol v2 --executor agx-claude-code');
    return await runProviderV2Real(invocation, {
      executorFactory: (manifest) => createRealRunExecutor(manifest, { workerCommand: fakeWorker(scenario, record) }),
      ...(harness['state-dir'] === undefined ? {} : { stateDir: harness['state-dir'] }),
    });
  } catch (err) {
    const usage = err instanceof CliUsageError || (err instanceof Error && 'code' in err && String((err as { code: unknown }).code).startsWith('ERR_PARSE_ARGS'));
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ error: { code: usage ? 'USAGE_ERROR' : 'UNEXPECTED_ERROR', message } })}\n`);
    return usage ? 2 : 1;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const modeAt = argv.indexOf('--mode');
  if (modeAt !== -1) {
    const mode = argv[modeAt + 1];
    if (mode === 'mint-approval') return mintApprovalMode(argv);
    if (mode === 'protocol-v2') return protocolV2Mode(argv);
    process.stderr.write(`unknown --mode ${mode ?? '(none)'}\n${USAGE}`);
    return 2;
  }
  let values: ReturnType<typeof parseArgs<{ options: typeof HARNESS_OPTIONS }>>['values'];
  try {
    ({ values } = parseArgs({ options: HARNESS_OPTIONS, strict: true }));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  if (!values.scenario || !values.record) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (values.request !== undefined) {
    if (!values.approval || !values['state-dir']) {
      process.stderr.write(USAGE);
      return 2;
    }
    const { scenario, record } = values;
    // The engine itself maps SIGHUP/SIGINT/SIGTERM onto the attempt's abort signal.
    const outcome = await runRealRun({
      requestPath: values.request,
      manifestFlags: values,
      approvalPath: values.approval,
      stateDir: values['state-dir'],
      executorFactory: (manifest) => createRealRunExecutor(manifest, { workerCommand: fakeWorker(scenario, record) }),
    });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return OUTCOME_EXIT[outcome.kind];
  }
  if (!values.manifest) {
    process.stderr.write(USAGE);
    return 2;
  }
  const manifest = JSON.parse(readFileSync(values.manifest, 'utf8')) as RunManifest;
  const profile = getCandidateOfflineProfile(manifest.profile.id, manifest.profile.version);
  if (profile.milestoneText === undefined) {
    process.stderr.write(`profile ${profile.id}@${profile.version} has no milestone text\n`);
    return 2;
  }
  const executor = createRealRunExecutor(manifest, { workerCommand: fakeWorker(values.scenario, values.record) });
  const worktree = await createWorktree({ seedFiles: profile.baseFiles, prefix: 'goal-gen-harness-' });
  try {
    const run = await executor.run(buildFixedAction(profile), {
      runId: 'harness',
      worktreePath: worktree.worktreePath,
      signal: new AbortController().signal,
      budgetUsdRemaining: manifest.caps.totalUsd,
      gitDir: worktree.gitDir,
    });
    process.stdout.write(
      `${JSON.stringify({
        status: run.status,
        failureClass: run.failureClass ?? null,
        costUsd: run.costUsd ?? null,
        exitCode: run.exitCode ?? null,
        diffRef: run.diffRef ?? null,
      })}\n`,
    );
    return run.status === 'succeeded' ? 0 : 1;
  } finally {
    await worktree.cleanup();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  },
);
