import { parseArgs } from 'node:util';
import { RUN_WALL_CLOCK_MS } from '../orchestrator/guardrails';
import { CliUsageError } from './errors';
import { ProviderStubScenarios, type StubScenario } from './provider-capabilities';
import { RUN_MANIFEST_OPTIONS, type ManifestFlagValues } from './run-manifest-command';

export type ParsedRunInvocation =
  | { mode: 'legacy'; requestPath: string; executor: 'claude-code' | 'stub'; yes: boolean; allowGuardrailOverride: boolean }
  | {
      mode: 'provider-stub';
      /** Protocol the run speaks; v2 stub runs are identical to v1 apart from this id (AGX-R23). */
      protocol: 'v1' | 'v2';
      requestPath: string;
      executor: 'stub';
      yes: boolean;
      allowGuardrailOverride: boolean;
      timeoutMs: number;
      timeoutExplicit: boolean;
      scenario: StubScenario;
    }
  | {
      /** Approval-gated real run (AGX-R24): only `--protocol v2 --executor agx-claude-code`. */
      mode: 'provider-v2-real';
      requestPath: string;
      executor: 'agx-claude-code';
      approvalPath: string;
      /** The `run manifest` flags of this invocation; the engine recomputes the manifest from them. */
      manifestFlags: ManifestFlagValues;
    };

function usage(message: string): never {
  throw new CliUsageError(message);
}

/** Real-run admission: every stub-only flag and the DoD `--yes` are usage errors (AGX-R25). */
function parseRealRun(
  requestPath: string,
  values: Record<string, string | string[] | boolean | undefined>,
): Extract<ParsedRunInvocation, { mode: 'provider-v2-real' }> {
  if (values.yes === true) usage('--yes is not accepted for a real run: the approval replaces the DoD confirmation');
  for (const flag of ['stub-scenario', 'timeout-ms'] as const) {
    if (values[flag] !== undefined) usage(`--${flag} is only valid for stub runs`);
  }
  if (values['allow-guardrail-override'] === true) usage('--allow-guardrail-override is not accepted for a real run');
  const approvalPath = values.approval;
  if (typeof approvalPath !== 'string' || approvalPath === '') usage('a real run requires --approval <path>');
  const { yes: _yes, 'allow-guardrail-override': _allow, protocol: _protocol, executor: _executor, 'stub-scenario': _scenario, 'timeout-ms': _timeout, approval: _approval, ...manifestFlags } = values;
  return { mode: 'provider-v2-real', requestPath, executor: 'agx-claude-code', approvalPath, manifestFlags: manifestFlags as ManifestFlagValues };
}

/** Pure admission parser. It neither reads the request nor constructs an engine. */
export function parseRunInvocation(argv: string[]): ParsedRunInvocation {
  let values: Record<string, string | string[] | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        executor: { type: 'string' },
        yes: { type: 'boolean', short: 'y', default: false },
        'allow-guardrail-override': { type: 'boolean', default: false },
        ...RUN_MANIFEST_OPTIONS,
        approval: { type: 'string' },
        protocol: { type: 'string' },
        'timeout-ms': { type: 'string' },
        'stub-scenario': { type: 'string' },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  if (positionals.length !== 1) usage('run accepts exactly one <request-file> positional argument');
  const requestPath = positionals[0]!;
  if (requestPath === '') usage('run requires a non-empty <request-file> positional argument');
  const executor = values.executor;
  if (executor !== 'stub' && executor !== 'claude-code' && executor !== 'agx-claude-code') {
    usage(`run requires --executor claude-code|stub (got ${executor ?? '(none)'}) — real spend is never a default`);
  }
  const protocol = values.protocol;
  const manifestFlagsGiven = Object.keys(RUN_MANIFEST_OPTIONS).filter((flag) => flag !== 'json' && values[flag] !== undefined);
  if (executor === 'agx-claude-code' && protocol !== 'v1') {
    if (protocol !== 'v2') usage('--executor agx-claude-code requires --protocol v2');
    return parseRealRun(requestPath, values);
  }
  if (manifestFlagsGiven.length > 0 || values.approval !== undefined) {
    usage(`--${values.approval !== undefined ? 'approval' : manifestFlagsGiven[0]} is only valid with --protocol v2 --executor agx-claude-code`);
  }
  const timeoutRaw = values['timeout-ms'];
  const scenarioRaw = values['stub-scenario'];
  if (protocol === undefined) {
    if (executor === 'agx-claude-code') usage('--executor agx-claude-code requires --protocol v2');
    if (timeoutRaw !== undefined || scenarioRaw !== undefined) usage('--timeout-ms and --stub-scenario require --protocol v1 or v2');
    return { mode: 'legacy', requestPath, executor, yes: values.yes === true, allowGuardrailOverride: values['allow-guardrail-override'] === true };
  }
  if (protocol !== 'v1' && protocol !== 'v2') usage(`unsupported protocol ${protocol}; expected v1`);
  if (executor !== 'stub') {
    if (protocol === 'v1') usage('provider protocol v1 requires --executor stub');
    usage('provider protocol v2 does not support --executor claude-code; use agx-claude-code with an approval');
  }
  const scenario = scenarioRaw === undefined ? 'success' : scenarioRaw;
  if (!ProviderStubScenarios.includes(scenario as StubScenario)) usage(`unknown stub scenario ${scenario}`);
  let timeoutMs = RUN_WALL_CLOCK_MS;
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw !== 'string' || !/^[1-9][0-9]*$/.test(timeoutRaw)) usage('--timeout-ms must be a decimal integer');
    timeoutMs = Number(timeoutRaw);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUN_WALL_CLOCK_MS) {
      usage(`--timeout-ms must be between 1 and ${RUN_WALL_CLOCK_MS}`);
    }
  }
  if (scenario === 'await-cancel' && timeoutRaw === undefined) usage('await-cancel requires an explicit --timeout-ms');
  return {
    mode: 'provider-stub', protocol, requestPath, executor: 'stub', yes: values.yes === true,
    allowGuardrailOverride: values['allow-guardrail-override'] === true,
    timeoutMs, timeoutExplicit: timeoutRaw !== undefined, scenario: scenario as StubScenario,
  };
}
