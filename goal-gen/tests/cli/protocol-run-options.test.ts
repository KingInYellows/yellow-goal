import { describe, expect, it } from 'vitest';
import { CliUsageError } from '../../backend/src/cli/errors';
import { parseRunInvocation } from '../../backend/src/cli/protocol-run-options';
import { RUN_WALL_CLOCK_MS } from '../../backend/src/orchestrator/guardrails';

describe('protocol v1 run admission', () => {
  it('keeps legacy invocation tagged legacy', () => {
    expect(parseRunInvocation(['request.json', '--executor', 'stub'])).toMatchObject({ mode: 'legacy', requestPath: 'request.json' });
  });
  it('accepts only the selected stub protocol invocation', () => {
    expect(parseRunInvocation(['request.json', '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', 'failed'])).toMatchObject({ mode: 'provider-stub', protocol: 'v1', scenario: 'failed' });
  });
  it('rejects absent, empty, and extra request paths before request I/O', () => {
    for (const argv of [
      [],
      ['--executor', 'stub'],
      ['', '--executor', 'stub'],
      ['request.json', 'extra.json', '--executor', 'stub'],
      ['', '--executor', 'stub', '--protocol', 'v1'],
      ['request.json', 'extra.json', '--executor', 'stub', '--protocol', 'v1'],
    ]) expect(() => parseRunInvocation(argv)).toThrow(CliUsageError);
  });
  it('keeps real executor names confined to pure parser inputs', () => {
    expect(parseRunInvocation(['request.json', '--executor', 'claude-code'])).toMatchObject({ mode: 'legacy', executor: 'claude-code' });
    expect(() => parseRunInvocation(['request.json', '--executor', 'claude-code', '--protocol', 'v1'])).toThrow(CliUsageError);
  });
  it('rejects missing values, unknown flags, and invalid v1 combinations', () => {
    for (const argv of [
      ['request.json'],
      ['request.json', '--executor'],
      ['request.json', '--executor', 'unknown'],
      ['request.json', '--unknown', '--executor', 'stub'],
      ['request.json', '--protocol'],
      ['request.json', '--executor', 'stub', '--protocol', 'v3'],
      ['request.json', '--executor', 'claude-code', '--protocol', 'v1'],
      ['request.json', '--executor', 'stub', '--timeout-ms', '1'],
      ['request.json', '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', 'unknown'],
      ['request.json', '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', 'await-cancel'],
      ['request.json', '--executor', 'stub', '--protocol', 'v1', '--timeout-ms'],
    ]) expect(() => parseRunInvocation(argv)).toThrow(CliUsageError);
  });
  it('accepts protocol v2 stub runs with the v1 flags and identical rules (AGX-R23)', () => {
    expect(parseRunInvocation(['request.json', '--executor', 'stub', '--protocol', 'v2'])).toMatchObject({ mode: 'provider-stub', protocol: 'v2', scenario: 'success', yes: false });
    expect(parseRunInvocation(['request.json', '--executor', 'stub', '--protocol', 'v2', '--stub-scenario', 'await-cancel', '--timeout-ms', '5', '--yes', '--allow-guardrail-override']))
      .toMatchObject({ mode: 'provider-stub', protocol: 'v2', scenario: 'await-cancel', timeoutMs: 5, yes: true, allowGuardrailOverride: true });
    for (const argv of [
      ['request.json', '--executor', 'stub', '--protocol', 'v2', '--stub-scenario', 'await-cancel'],
      ['request.json', '--executor', 'stub', '--protocol', 'v2', '--stub-scenario', 'unknown'],
      ['request.json', '--executor', 'stub', '--protocol', 'v2', '--timeout-ms', '0'],
    ]) expect(() => parseRunInvocation(argv)).toThrow(CliUsageError);
  });
  it('keeps the v1 executor message verbatim and rejects the legacy executor under v2 (AGX-R26)', () => {
    expect(() => parseRunInvocation(['request.json', '--executor', 'claude-code', '--protocol', 'v1'])).toThrow('provider protocol v1 requires --executor stub');
    expect(() => parseRunInvocation(['request.json', '--executor', 'claude-code', '--protocol', 'v2']))
      .toThrow('provider protocol v2 does not support --executor claude-code; use agx-claude-code with an approval');
  });
  it('rejects non-integral, unsafe, and out-of-range protocol timeouts', () => {
    for (const timeout of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', String(RUN_WALL_CLOCK_MS + 1)]) {
      expect(() => parseRunInvocation(['request.json', '--executor', 'stub', '--protocol', 'v1', '--timeout-ms', timeout])).toThrow(CliUsageError);
    }
  });

  describe('approval-gated real run (AGX-R24/R25/R26)', () => {
    const real = ['request.json', '--protocol', 'v2', '--executor', 'agx-claude-code'];
    const manifest = ['--profile', 'config-repair@2', '--max-turns', '8', '--per-action-usd', '0.5', '--total-usd', '5', '--auth-mode', 'subscription', '--allowed-tool', 'Edit(./SITE)', '--allowed-tool', 'Read(./**)', '--bundle-dir', '/tmp/b', '--spend-ledger', '/tmp/l.jsonl'];
    it('selects provider-v2-real only for --protocol v2 --executor agx-claude-code with --approval', () => {
      const parsed = parseRunInvocation([...real, ...manifest, '--approval', '/tmp/a.json']);
      expect(parsed).toMatchObject({ mode: 'provider-v2-real', requestPath: 'request.json', executor: 'agx-claude-code', approvalPath: '/tmp/a.json' });
      if (parsed.mode !== 'provider-v2-real') throw new Error('unreachable');
      expect(parsed.manifestFlags).toMatchObject({ profile: 'config-repair@2', 'allowed-tool': ['Edit(./SITE)', 'Read(./**)'], 'bundle-dir': '/tmp/b' });
      expect(parsed.manifestFlags).not.toHaveProperty('approval');
      expect(parsed.manifestFlags).not.toHaveProperty('yes');
    });
    it.each([
      ['--yes on a real run', [...real, ...manifest, '--approval', 'a', '--yes']],
      ['-y on a real run', [...real, ...manifest, '--approval', 'a', '-y']],
      ['--stub-scenario', [...real, ...manifest, '--approval', 'a', '--stub-scenario', 'success']],
      ['--timeout-ms', [...real, ...manifest, '--approval', 'a', '--timeout-ms', '5']],
      ['--allow-guardrail-override', [...real, ...manifest, '--approval', 'a', '--allow-guardrail-override']],
      ['missing --approval', [...real, ...manifest]],
      ['empty --approval', [...real, ...manifest, '--approval', '']],
      ['agx-claude-code without --protocol', ['request.json', '--executor', 'agx-claude-code', ...manifest, '--approval', 'a']],
      ['agx-claude-code under v1', ['request.json', '--protocol', 'v1', '--executor', 'agx-claude-code']],
      ['manifest flag on a stub run', ['request.json', '--protocol', 'v2', '--executor', 'stub', '--profile', 'config-repair@2']],
      ['manifest flag on a legacy run', ['request.json', '--executor', 'stub', '--max-turns', '3']],
      ['--approval on a stub run', ['request.json', '--protocol', 'v1', '--executor', 'stub', '--approval', 'a']],
      ['--approval on a legacy run', ['request.json', '--executor', 'claude-code', '--approval', 'a']],
    ])('usage error: %s', (_name, argv) => {
      expect(() => parseRunInvocation(argv)).toThrow(CliUsageError);
    });
  });
});
