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
 * Executor mode (`--manifest <manifest.json> --scenario <name> --record <file>`) runs only the
 * executor against a seeded `config-repair` v2 worktree and prints a JSON summary. Exit codes:
 * 0 = worker succeeded, 1 = worker failed, 2 = usage or setup error.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getCandidateOfflineProfile } from '../../backend/src/cli/candidate-offline-profiles';
import type { RunManifest } from '../../backend/src/cli/run-manifest';
import { RUN_MANIFEST_OPTIONS } from '../../backend/src/cli/run-manifest-command';
import { createRealRunExecutor } from '../../backend/src/executors/real-run-executor';
import { createWorktree } from '../../backend/src/executors/worktree';
import { buildFixedAction } from '../../backend/src/real-run/fixed-goal';
import { runRealRun } from '../../backend/src/real-run/real-run-engine';
import type { RealRunOutcome } from '../../backend/src/real-run/outcome';

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
} as const;

function fakeWorker(scenario: string, record: string) {
  return { file: process.execPath, args: [FAKE_WORKER, '--scenario', scenario, '--record', path.resolve(record)] };
}

const OUTCOME_EXIT: Record<RealRunOutcome['kind'], number> = {
  verified: 0,
  'worker-failed': 1,
  'verification-rejected': 1,
  refused: 3,
};

async function main(): Promise<number> {
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
      ...(worktree.gitDir === undefined ? {} : { gitDir: worktree.gitDir }),
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
