/**
 * Shared fixtures for the real-run engine suites: a temp dir with a request, evidence destinations
 * and an approval state dir; approvals minted through the `run approve` TTY seam; and an executor
 * factory that injects the fake worker (never PATH or an environment variable, AGX-R15).
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { vi } from 'vitest';
import { runRunApprove } from '../../backend/src/cli/run-approval-command';
import { approvalMarkerPath } from '../../backend/src/cli/run-approval-verifier';
import { RUN_MANIFEST_OPTIONS, type ManifestFlagValues } from '../../backend/src/cli/run-manifest-command';
import { createRealRunExecutor } from '../../backend/src/executors/real-run-executor';
import { runRealRun, type RealRunInput } from '../../backend/src/real-run/real-run-engine';
import type { RealRunOutcome } from '../../backend/src/real-run/outcome';
import { requestExecutionSample } from '../contracts/support/samples';
import { answeringTerminal } from './answering-terminal';

export const FAKE_WORKER = path.join(__dirname, '..', 'fixtures', 'claude-worker', 'fake-claude.mjs');
export const ALLOWED_TOOLS = ['Edit(./SITE)', 'Edit(./site.json)', 'Read(./**)'];

/** Credential and provider variables the auth guard refuses; blanked so a developer's host env cannot interfere. */
const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

export function stubCleanCredentials(): void {
  for (const name of CREDENTIAL_VARS) vi.stubEnv(name, '');
}

export type Fixture = {
  dir: string;
  requestPath: string;
  stateDir: string;
  recordPath: string;
  bundleDir: string;
  ledgerPath: string;
  approvalPath: string;
};

export async function createFixture(request: Record<string, unknown> = requestExecutionSample): Promise<Fixture> {
  // Canonical from the start, so evidence paths equal what the manifest stores.
  const dir = await mkdtemp(path.join(realpathSync(tmpdir()), 'goal-gen-rr-test-'));
  const requestPath = path.join(dir, 'request.json');
  await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8');
  return {
    dir,
    requestPath,
    stateDir: path.join(dir, 'state'),
    recordPath: path.join(dir, 'invocations.jsonl'),
    bundleDir: path.join(dir, 'bundle'),
    ledgerPath: path.join(dir, 'spend.jsonl'),
    approvalPath: path.join(dir, 'approval.json'),
  };
}

export async function removeFixture(fx: Fixture): Promise<void> {
  await rm(fx.dir, { recursive: true, force: true });
}

export type FlagOptions = {
  authMode?: 'subscription' | 'api-key';
  allowedTools?: readonly string[];
  bundleDir?: string;
  ledgerPath?: string;
  profile?: string;
  extra?: readonly string[];
};

/** `run manifest` flags for a `config-repair@2` real run. */
export function manifestArgs(fx: Fixture, options: FlagOptions = {}): string[] {
  return [
    '--profile', options.profile ?? 'config-repair@2',
    '--model', 'sonnet',
    '--max-turns', '8',
    '--per-action-usd', '0.5',
    '--total-usd', '5',
    '--auth-mode', options.authMode ?? 'subscription',
    ...(options.allowedTools ?? ALLOWED_TOOLS).flatMap((tool) => ['--allowed-tool', tool]),
    '--bundle-dir', options.bundleDir ?? fx.bundleDir,
    '--spend-ledger', options.ledgerPath ?? fx.ledgerPath,
    ...(options.extra ?? []),
  ];
}

export function flagValues(args: readonly string[]): ManifestFlagValues {
  return parseArgs({ args: [...args], options: RUN_MANIFEST_OPTIONS, allowPositionals: false }).values;
}

/** Mints an approval for `args` through the `run approve` ceremony (injected TTY seam). */
export async function mintApproval(fx: Fixture, args: readonly string[], out: string = fx.approvalPath): Promise<string> {
  const minted = await runRunApprove([fx.requestPath, ...args, '--out', out], { terminal: answeringTerminal() });
  return minted.output.approvalId;
}

export function fakeWorkerFactory(fx: Fixture, scenario: string): RealRunInput['executorFactory'] {
  return (manifest) =>
    createRealRunExecutor(manifest, {
      workerCommand: { file: process.execPath, args: [FAKE_WORKER, '--scenario', scenario, '--record', fx.recordPath] },
    });
}

export function runEngine(
  fx: Fixture,
  scenario: string,
  args: readonly string[],
  overrides: Partial<RealRunInput> = {},
): Promise<RealRunOutcome> {
  return runRealRun({
    requestPath: fx.requestPath,
    manifestFlags: flagValues(args),
    approvalPath: fx.approvalPath,
    executorFactory: fakeWorkerFactory(fx, scenario),
    env: {},
    stateDir: fx.stateDir,
    ...overrides,
  });
}

export type Invocation = { scenario: string; cwd: string; prompt: string; argv: string[]; descendantPid?: number };

export function invocations(fx: Fixture): Invocation[] {
  if (!existsSync(fx.recordPath)) return [];
  return readFileSync(fx.recordPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Invocation);
}

export function markerExists(fx: Fixture, approvalId: string): boolean {
  return existsSync(approvalMarkerPath(approvalId, { stateDir: fx.stateDir }));
}

export function ledgerEntries(fx: Fixture): Array<Record<string, unknown>> {
  if (!existsSync(fx.ledgerPath)) return [];
  return readFileSync(fx.ledgerPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The scratch repo root the worker ran in (the parent of its `wt` worktree). */
export function scratchRoot(invocation: Invocation): string {
  return path.dirname(invocation.cwd);
}
