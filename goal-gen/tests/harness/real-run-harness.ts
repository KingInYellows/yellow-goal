/**
 * TEST-ONLY process harness for the approval-gated real run (AGX-R15, AGX-R33). It lives under
 * `tests/`, so it is outside `package.json` `files` and never ships in the release tarball, and
 * the production bin never imports it (harness-isolation.test.ts). It constructs the real-run
 * executor with the fake worker injected through the constructor, seeds a `config-repair` v2
 * scratch worktree, runs the single action, and prints a JSON summary.
 *
 * Usage: node node_modules/tsx/dist/cli.mjs tests/harness/real-run-harness.ts \
 *          --manifest <manifest.json> --scenario <name> --record <invocations.jsonl>
 *
 * Exit codes: 0 = worker succeeded, 1 = worker failed, 2 = usage or setup error.
 * Shell 03 extends this entry point to the full real-run command.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getCandidateOfflineProfile } from '../../backend/src/cli/candidate-offline-profiles';
import type { RunManifest } from '../../backend/src/cli/run-manifest';
import { createRealRunExecutor } from '../../backend/src/executors/real-run-executor';
import { createWorktree } from '../../backend/src/executors/worktree';

const FAKE_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude-worker', 'fake-claude.mjs');

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { manifest: { type: 'string' }, scenario: { type: 'string' }, record: { type: 'string' } },
    strict: true,
  });
  if (!values.manifest || !values.scenario || !values.record) {
    process.stderr.write('usage: real-run-harness --manifest <file> --scenario <name> --record <file>\n');
    return 2;
  }
  const manifest = JSON.parse(readFileSync(values.manifest, 'utf8')) as RunManifest;
  const profile = getCandidateOfflineProfile(manifest.profile.id, manifest.profile.version);
  if (profile.milestoneText === undefined) {
    process.stderr.write(`profile ${profile.id}@${profile.version} has no milestone text\n`);
    return 2;
  }
  const executor = createRealRunExecutor(manifest, {
    workerCommand: {
      file: process.execPath,
      args: [FAKE_WORKER, '--scenario', values.scenario, '--record', path.resolve(values.record)],
    },
  });
  const worktree = await createWorktree({ seedFiles: profile.baseFiles, prefix: 'goal-gen-harness-' });
  try {
    const run = await executor.run(
      {
        id: 'milestone',
        name: `${profile.id}@${profile.version} milestone`,
        cost: 1,
        preconditions: {},
        effects: { done: true },
        executor: 'claude-code',
        payload: { prompt: profile.milestoneText },
        verify: { command: 'true' },
      },
      { runId: 'harness', worktreePath: worktree.worktreePath, signal: new AbortController().signal, budgetUsdRemaining: manifest.caps.totalUsd },
    );
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
