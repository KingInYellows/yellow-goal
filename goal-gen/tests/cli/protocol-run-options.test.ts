import { describe, expect, it } from 'vitest';
import { CliUsageError } from '../../backend/src/cli/errors';
import { parseRunInvocation } from '../../backend/src/cli/protocol-run-options';
import { RUN_WALL_CLOCK_MS } from '../../backend/src/orchestrator/guardrails';

describe('protocol v1 run admission', () => {
  it('keeps legacy invocation tagged legacy', () => {
    expect(parseRunInvocation(['request.json', '--executor', 'stub'])).toMatchObject({ mode: 'legacy', requestPath: 'request.json' });
  });
  it('accepts only the selected stub protocol invocation', () => {
    expect(parseRunInvocation(['request.json', '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', 'failed'])).toMatchObject({ mode: 'provider-v1', scenario: 'failed' });
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
      ['request.json', '--executor', 'stub', '--protocol', 'v2'],
      ['request.json', '--executor', 'claude-code', '--protocol', 'v1'],
      ['request.json', '--executor', 'stub', '--timeout-ms', '1'],
      ['request.json', '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', 'unknown'],
      ['request.json', '--executor', 'stub', '--protocol', 'v1', '--stub-scenario', 'await-cancel'],
      ['request.json', '--executor', 'stub', '--protocol', 'v1', '--timeout-ms'],
    ]) expect(() => parseRunInvocation(argv)).toThrow(CliUsageError);
  });
  it('rejects non-integral, unsafe, and out-of-range protocol timeouts', () => {
    for (const timeout of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', String(RUN_WALL_CLOCK_MS + 1)]) {
      expect(() => parseRunInvocation(['request.json', '--executor', 'stub', '--protocol', 'v1', '--timeout-ms', timeout])).toThrow(CliUsageError);
    }
  });
});
