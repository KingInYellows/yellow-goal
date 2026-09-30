/**
 * ADR-0020 / AGX-R1: the real-run manifest is deterministic, offline, and bounded by the ADR-0010
 * defaults. `run manifest` is intercepted before `run <request>` parsing.
 */
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunApprovalError } from '../../backend/src/cli/errors';
import { main } from '../../backend/src/cli/index';
import {
  RealRunProtocolId,
  RUN_MANIFEST_DEFAULTS,
  RunManifestSchema,
  RunManifestSchemaVersion,
  approvalChallenge,
  buildRunManifest,
  computeManifestHash,
  type RunManifest,
  type RunManifestInputs,
} from '../../backend/src/cli/run-manifest';
import {
  candidateProfileDigest,
  getCandidateOfflineProfile,
} from '../../backend/src/cli/candidate-offline-profiles';
import { REAL_RUN_ACTION_TIMEOUT_MS, REAL_RUN_WALL_CLOCK_MS } from '../../backend/src/orchestrator/guardrails';
import { canonicalJson } from '../../backend/src/packs/canonical-json';
import { RepositoryGoalRequestSchema } from '../../backend/src/contracts/request';
import { requestExecutionSample as rawRequestExecutionSample } from '../contracts/support/samples';

const requestExecutionSample = RepositoryGoalRequestSchema.parse(rawRequestExecutionSample);
/** Evidence destinations need only an existing parent; the tmpdir is canonicalized up front. */
const EVIDENCE_PARENT = realpathSync(tmpdir());

function inputs(overrides: Partial<RunManifestInputs> = {}): RunManifestInputs {
  return {
    engineVersion: '0.2.0',
    request: requestExecutionSample,
    profileId: 'config-repair',
    model: 'sonnet',
    allowedTools: ['Read', 'Edit'],
    disallowedTools: ['Bash'],
    maxTurns: 8,
    perActionUsd: 1,
    totalUsd: 5,
    actionTimeoutMs: 300_000,
    runWallClockMs: 1_800_000,
    authMode: 'subscription',
    expiresInMinutes: 60,
    bundleDir: path.join(EVIDENCE_PARENT, 'goal-gen-manifest-bundle'),
    spendLedgerPath: path.join(EVIDENCE_PARENT, 'goal-gen-manifest-spend.jsonl'),
    ...overrides,
  };
}

function manifestInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RunApprovalError);
    expect((err as RunApprovalError).code).toBe('MANIFEST_INVALID');
    return;
  }
  throw new Error('expected MANIFEST_INVALID');
}

describe('buildRunManifest', () => {
  it('renders the same inputs to byte-identical manifests and an identical hash', () => {
    const first = buildRunManifest(inputs());
    const second = buildRunManifest(inputs());
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(computeManifestHash(first)).toBe(computeManifestHash(second));
    expect(first).toMatchObject({
      schemaVersion: RunManifestSchemaVersion,
      protocolId: RealRunProtocolId,
      profile: { id: 'config-repair', version: '1' },
      permissionMode: 'acceptEdits',
      attemptCount: 1,
    });
    expect(first.profile.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of tool-list order and duplicates', () => {
    const a = buildRunManifest(inputs({ allowedTools: ['Read', 'Edit'] }));
    const b = buildRunManifest(inputs({ allowedTools: ['Edit', ' Read', 'Edit'] }));
    expect(b.allowedTools).toEqual(['Edit', 'Read']);
    expect(computeManifestHash(a)).toBe(computeManifestHash(b));
  });

  it.each<[string, Partial<RunManifestInputs>]>([
    ['engine version', { engineVersion: '0.2.1' }],
    ['request', { request: { ...requestExecutionSample, requestId: 'other-request' } }],
    ['model', { model: 'haiku' }],
    ['allowed tools', { allowedTools: ['Read'] }],
    ['disallowed tools', { disallowedTools: [] }],
    ['max turns', { maxTurns: 9 }],
    ['per-action cap', { perActionUsd: 0.5 }],
    ['total cap', { totalUsd: 4 }],
    ['action timeout', { actionTimeoutMs: 200_000 }],
    ['run wall-clock', { runWallClockMs: 1_700_000 }],
    ['auth mode', { authMode: 'api-key' }],
    ['expiry', { expiresInMinutes: 30 }],
    ['bundle directory', { bundleDir: path.join(EVIDENCE_PARENT, 'other-bundle') }],
    ['spend ledger', { spendLedgerPath: path.join(EVIDENCE_PARENT, 'other-spend.jsonl') }],
    ['profile version', { profileId: 'config-repair@2' }],
  ])('changes the hash when the %s changes', (_label, override) => {
    expect(computeManifestHash(buildRunManifest(inputs(override)))).not.toBe(computeManifestHash(buildRunManifest(inputs())));
  });

  it.each<[string, Partial<RunManifestInputs>]>([
    ['total cap above the ADR-0010 default', { totalUsd: 20.01 }],
    ['per-action cap above the total cap', { perActionUsd: 6 }],
    ['zero cap', { perActionUsd: 0 }],
    ['expiry above 60 minutes', { expiresInMinutes: 61 }],
    ['zero expiry', { expiresInMinutes: 0 }],
    ['action timeout above the default', { actionTimeoutMs: 600_001 }],
    ['wall-clock above the default', { runWallClockMs: 3_600_001 }],
    ['no allowed tools', { allowedTools: [] }],
    ['a tool both allowed and disallowed', { disallowedTools: ['Edit'] }],
    ['unknown auth mode', { authMode: 'oauth' }],
    ['unknown profile', { profileId: 'nope' }],
    ['zero max turns', { maxTurns: 0 }],
    ['a tool entry that reads as a CLI flag', { allowedTools: ['Edit', '--dangerously-skip-permissions'] }],
    ['a tool entry smuggling a permission mode', { allowedTools: ['--permission-mode=bypassPermissions'] }],
    ['a comma-joined tool list', { allowedTools: ['Edit,Write'] }],
    ['a second rule smuggled after a specifier', { allowedTools: ['Bash(x),Write(y)'] }],
    ['nested parentheses in a specifier', { allowedTools: ['Bash(a(b))'] }],
    ['a control character inside a specifier', { allowedTools: ['Bash(a\nb)'] }],
    ['a disallowed tool that reads as a CLI flag', { disallowedTools: ['--x'] }],
    ['a model that reads as a CLI flag', { model: '--permission-mode=bypassPermissions' }],
    ['a model with whitespace', { model: 'a b' }],
    ['an empty model', { model: '' }],
    ['a tool name with a bidi override', { allowedTools: ['Edit\u202e'] }],
    ['a zero-width tool name', { allowedTools: ['Ed\u200bit'] }],
    ['an unknown profile version', { profileId: 'config-repair@9' }],
    ['an empty profile version', { profileId: 'config-repair@' }],
    ['no bundle directory', { bundleDir: undefined }],
    ['no spend ledger', { spendLedgerPath: undefined }],
    ['a bundle directory whose parent does not exist', { bundleDir: path.join(EVIDENCE_PARENT, 'goal-gen-missing-parent', 'bundle') }],
    ['a filesystem-root bundle directory', { bundleDir: '/' }],
    ['one path for both destinations', { spendLedgerPath: path.join(EVIDENCE_PARENT, 'goal-gen-manifest-bundle') }],
  ])('refuses %s with MANIFEST_INVALID', (_label, override) => {
    manifestInvalid(() => buildRunManifest(inputs(override)));
  });

  it('applies RUN_MANIFEST_DEFAULTS when optional settings are omitted — the one default source', () => {
    const { model: _m, disallowedTools: _d, actionTimeoutMs: _a, runWallClockMs: _r, expiresInMinutes: _e, ...required } = inputs();
    const manifest = buildRunManifest(required);
    expect(manifest).toMatchObject({
      model: RUN_MANIFEST_DEFAULTS.model,
      disallowedTools: [],
      actionTimeoutMs: RUN_MANIFEST_DEFAULTS.actionTimeoutMs,
      runWallClockMs: RUN_MANIFEST_DEFAULTS.runWallClockMs,
      expiresInMinutes: RUN_MANIFEST_DEFAULTS.expiresInMinutes,
    });
    expect(computeManifestHash(manifest)).toBe(
      computeManifestHash(buildRunManifest({ ...required, ...RUN_MANIFEST_DEFAULTS })),
    );
  });

  it('selects a profile version with <id>@<version>; a bare id stays version 1', () => {
    const v2 = buildRunManifest(inputs({ profileId: 'config-repair@2' }));
    expect(v2.profile).toEqual({ id: 'config-repair', version: '2', digest: candidateProfileDigest(getCandidateOfflineProfile('config-repair', '2')) });
    expect(buildRunManifest(inputs()).profile.version).toBe('1');
    expect(computeManifestHash(buildRunManifest(inputs({ profileId: 'config-repair@1' })))).toBe(computeManifestHash(buildRunManifest(inputs())));
  });

  it('binds the evidence destinations as canonical absolute paths (AGX-R8a)', async () => {
    const dir = await mkdtemp(path.join(EVIDENCE_PARENT, 'goal-gen-manifest-canon-'));
    try {
      await mkdir(path.join(dir, 'real'));
      await symlink(path.join(dir, 'real'), path.join(dir, 'link'));
      const manifest = buildRunManifest(
        inputs({ bundleDir: path.join(dir, 'link', 'bundle'), spendLedgerPath: path.join(dir, 'link', '..', 'spend.jsonl') }),
      );
      expect(manifest.evidence).toEqual({ bundleDir: path.join(dir, 'real', 'bundle'), spendLedgerPath: path.join(dir, 'spend.jsonl') });
      expect(RunManifestSchema.safeParse({ ...manifest, evidence: { ...manifest.evidence, bundleDir: 'relative/bundle' } }).success).toBe(false);
      expect(RunManifestSchema.safeParse({ ...manifest, evidence: { ...manifest.evidence, extra: 1 } }).success).toBe(false);
      const { evidence: _evidence, ...withoutEvidence } = manifest;
      expect(RunManifestSchema.safeParse(withoutEvidence).success).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts Claude Code tool rules with a parenthesised specifier', () => {
    const manifest = buildRunManifest(inputs({ allowedTools: ['Bash(git status:*)', 'mcp__srv__tool', 'Read(./src/**)'] }));
    expect(manifest.allowedTools).toEqual(['Bash(git status:*)', 'Read(./src/**)', 'mcp__srv__tool']);
  });

  it('cannot express any permission mode but acceptEdits', () => {
    const manifest = buildRunManifest(inputs());
    expect(manifest.permissionMode).toBe('acceptEdits');
    for (const mode of ['bypassPermissions', 'plan', 'default']) {
      expect(RunManifestSchema.safeParse({ ...manifest, permissionMode: mode }).success).toBe(false);
    }
    expect(RunManifestSchema.safeParse({ ...manifest, attemptCount: 2 }).success).toBe(false);
  });

  it('pins the hash input form: sha256 over canonicalJson (sorted keys, 2-space, trailing newline)', () => {
    const fixed: RunManifest = {
      schemaVersion: RunManifestSchemaVersion,
      engineVersion: '0.2.0',
      protocolId: RealRunProtocolId,
      profile: { id: 'config-repair', version: '1', digest: 'a'.repeat(64) },
      requestHash: 'b'.repeat(64),
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      allowedTools: ['Edit', 'Read'],
      disallowedTools: ['Bash'],
      maxTurns: 8,
      caps: { perActionUsd: 1, totalUsd: 5 },
      actionTimeoutMs: 300_000,
      runWallClockMs: 1_800_000,
      authMode: 'subscription',
      attemptCount: 1,
      expiresInMinutes: 60,
      evidence: { bundleDir: '/var/goal-gen/bundle', spendLedgerPath: '/var/goal-gen/spend.jsonl' },
    };
    expect(computeManifestHash(fixed)).toBe('f5adc396dd15776fd5503da3b159dba709a04c33138b1b3d84bee7bc80e6726e');
    expect(approvalChallenge(computeManifestHash(fixed))).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
  });
});

describe('run manifest verb', () => {
  let tempDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'goal-gen-run-manifest-'));
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  const stdoutText = () => stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
  const stderrText = () => stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');

  async function requestFile(): Promise<string> {
    const filePath = path.join(tempDir, 'request.json');
    await writeFile(filePath, `${JSON.stringify(requestExecutionSample)}\n`, 'utf8');
    return filePath;
  }

  const flags = [
    '--profile', 'config-repair',
    '--model', 'sonnet',
    '--max-turns', '8',
    '--per-action-usd', '1',
    '--total-usd', '5',
    '--auth-mode', 'subscription',
    '--allowed-tool', 'Read',
    '--allowed-tool', 'Edit',
  ];
  /** Evidence flags live in the per-test temp dir, so they are appended per call. */
  const evidenceFlags = () => ['--bundle-dir', path.join(tempDir, 'bundle'), '--spend-ledger', path.join(tempDir, 'spend.jsonl')];

  it('prints one JSON line with manifest, hash and challenge; identical across renders', async () => {
    const req = await requestFile();
    expect(await main(['run', 'manifest', req, ...flags, ...evidenceFlags(), '--json'])).toBe(0);
    const first = stdoutText();
    stdoutSpy.mockClear();
    expect(await main(['run', 'manifest', req, ...flags, ...evidenceFlags(), '--json'])).toBe(0);
    expect(stdoutText()).toBe(first);
    expect(stderrText()).toBe('');
    expect(first.trim().split('\n')).toHaveLength(1);
    const output = JSON.parse(first) as { manifest: RunManifest; manifestHash: string; challenge: string };
    expect(output.manifestHash).toBe(computeManifestHash(output.manifest));
    expect(output.challenge).toBe(approvalChallenge(output.manifestHash));
    expect(output.manifest.actionTimeoutMs).toBe(REAL_RUN_ACTION_TIMEOUT_MS);
    expect(output.manifest.runWallClockMs).toBe(REAL_RUN_WALL_CLOCK_MS);
    expect(output.manifest.evidence).toEqual({
      bundleDir: path.join(realpathSync(tempDir), 'bundle'),
      spendLedgerPath: path.join(realpathSync(tempDir), 'spend.jsonl'),
    });
    expect(output.manifest.expiresInMinutes).toBe(60);
  });

  it('missing a required flag is USAGE_ERROR (exit 2)', async () => {
    const req = await requestFile();
    expect(await main(['run', 'manifest', req, ...flags.slice(2), ...evidenceFlags(), '--json'])).toBe(2);
    expect(JSON.parse(stderrText())).toMatchObject({ error: { code: 'USAGE_ERROR' } });
  });

  it.each(['--bundle-dir', '--spend-ledger'])('missing %s is USAGE_ERROR (exit 2)', async (flag) => {
    const req = await requestFile();
    const evidence = evidenceFlags();
    const at = evidence.indexOf(flag);
    evidence.splice(at, 2);
    expect(await main(['run', 'manifest', req, ...flags, ...evidence, '--json'])).toBe(2);
    expect(JSON.parse(stderrText())).toMatchObject({ error: { code: 'USAGE_ERROR', message: `${flag} is required` } });
  });

  it('a malformed number is USAGE_ERROR; an out-of-range one is MANIFEST_INVALID', async () => {
    const req = await requestFile();
    expect(await main(['run', 'manifest', req, ...flags, ...evidenceFlags(), '--total-usd', 'five'])).toBe(2);
    expect(JSON.parse(stderrText())).toMatchObject({ error: { code: 'USAGE_ERROR' } });
    stderrSpy.mockClear();
    expect(await main(['run', 'manifest', req, ...flags, ...evidenceFlags(), '--total-usd', '25'])).toBe(1);
    expect(JSON.parse(stderrText())).toMatchObject({ error: { code: 'MANIFEST_INVALID' } });
  });

  it.each([
    ['two positionals', (req: string) => ['run', 'manifest', req, req, ...flags, ...evidenceFlags()]],
    ['a negative integer', (req: string) => ['run', 'manifest', req, ...flags, ...evidenceFlags(), '--max-turns=-1']],
    ['an exponent USD amount', (req: string) => ['run', 'manifest', req, ...flags, ...evidenceFlags(), '--total-usd', '1e3']],
    ['a fractional timeout', (req: string) => ['run', 'manifest', req, ...flags, ...evidenceFlags(), '--action-timeout-ms', '1.5']],
  ])('%s is USAGE_ERROR', async (_label, argv) => {
    const req = await requestFile();
    expect(await main(argv(req))).toBe(2);
    expect(JSON.parse(stderrText())).toMatchObject({ error: { code: 'USAGE_ERROR' } });
  });

  it('optional flags land in the manifest', async () => {
    const req = await requestFile();
    const extra = ['--action-timeout-ms', '1000', '--run-wall-clock-ms', '2000', '--disallowed-tool', 'Bash', '--expires-in-minutes', '15', '--json'];
    expect(await main(['run', 'manifest', req, ...flags, ...evidenceFlags(), ...extra])).toBe(0);
    expect(JSON.parse(stdoutText()).manifest).toMatchObject({
      actionTimeoutMs: 1000,
      runWallClockMs: 2000,
      disallowedTools: ['Bash'],
      expiresInMinutes: 15,
      model: 'sonnet',
    });
  });

  it('a request file named ./manifest still reaches the plain run parser', async () => {
    expect(await main(['run', './manifest'])).toBe(2);
    expect(JSON.parse(stderrText()).error.message).not.toMatch(/--profile/);
  });

  it('an integer beyond the safe range is USAGE_ERROR', async () => {
    const req = await requestFile();
    expect(await main(['run', 'manifest', req, ...flags, ...evidenceFlags(), '--max-turns', '99999999999999999999'])).toBe(2);
    expect(JSON.parse(stderrText())).toMatchObject({ error: { code: 'USAGE_ERROR' } });
  });

  it('an invalid request file is VALIDATION_FAILED', async () => {
    const bad = path.join(tempDir, 'bad.json');
    await writeFile(bad, '{"not":"a request"}', 'utf8');
    expect(await main(['run', 'manifest', bad, ...flags, ...evidenceFlags()])).toBe(1);
    expect(JSON.parse(stderrText())).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('plain `run <request>` parsing is unchanged (still demands --executor)', async () => {
    const req = await requestFile();
    expect(await main(['run', req])).toBe(2);
    expect(JSON.parse(stderrText())).toMatchObject({ error: { code: 'USAGE_ERROR' } });
  });
});
