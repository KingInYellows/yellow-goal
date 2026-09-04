import { parseArgs } from 'node:util';
import { RUN_WALL_CLOCK_MS } from '../orchestrator/guardrails';
import { CliUsageError } from './errors';
import { ProviderStubScenarios, type StubScenario } from './provider-capabilities';

export type ParsedRunInvocation =
  | { mode: 'legacy'; requestPath: string; executor: 'claude-code' | 'stub'; yes: boolean; allowGuardrailOverride: boolean }
  | {
      mode: 'provider-v1';
      requestPath: string;
      executor: 'stub';
      yes: boolean;
      allowGuardrailOverride: boolean;
      timeoutMs: number;
      timeoutExplicit: boolean;
      scenario: StubScenario;
    };

function usage(message: string): never {
  throw new CliUsageError(message);
}

/** Pure admission parser. It neither reads the request nor constructs an engine. */
export function parseRunInvocation(argv: string[]): ParsedRunInvocation {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        executor: { type: 'string' },
        yes: { type: 'boolean', short: 'y', default: false },
        'allow-guardrail-override': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
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
  if (executor !== 'stub' && executor !== 'claude-code') {
    usage(`run requires --executor claude-code|stub (got ${executor ?? '(none)'}) — real spend is never a default`);
  }
  const protocol = values.protocol;
  const timeoutRaw = values['timeout-ms'];
  const scenarioRaw = values['stub-scenario'];
  if (protocol === undefined) {
    if (timeoutRaw !== undefined || scenarioRaw !== undefined) usage('--timeout-ms and --stub-scenario require --protocol v1');
    return { mode: 'legacy', requestPath, executor, yes: values.yes === true, allowGuardrailOverride: values['allow-guardrail-override'] === true };
  }
  if (protocol !== 'v1') usage(`unsupported protocol ${protocol}; expected v1`);
  if (executor !== 'stub') usage('provider protocol v1 requires --executor stub');
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
    mode: 'provider-v1', requestPath, executor: 'stub', yes: values.yes === true,
    allowGuardrailOverride: values['allow-guardrail-override'] === true,
    timeoutMs, timeoutExplicit: timeoutRaw !== undefined, scenario: scenario as StubScenario,
  };
}
