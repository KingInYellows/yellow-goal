import { parseArgs } from 'node:util';
import { RepositoryGoalRequestSchemaVersion } from '../contracts/request';
import { RunEventSchemaVersion } from '../contracts/run-event';
import {
  PROTOCOL_STDOUT_FINALIZE_MS,
  PROTOCOL_STDOUT_MAX_EVENT_BYTES,
  PROTOCOL_STDOUT_MAX_QUEUED_BYTES,
} from '../events/protocol-stdout-writer';
import { readArtifactVersion } from './artifact-version';
import { CliUsageError } from './errors';
import type { CommandOutput } from './commands';

export const ProviderProtocolVersion = 'yellow-goal/provider-protocol/v1' as const;
/** v2 is a superset of v1: stub runs are identical, and a real run is a distinct selected capability. */
export const ProviderProtocolV2 = 'yellow-goal/provider-protocol/v2' as const;
export const SupportedProtocols = [ProviderProtocolVersion, ProviderProtocolV2] as const;
/** Capability id for the approval-gated real run; the legacy `run.executor.claude-code` is never advertised. */
export const RealRunExecutorCapability = 'run.executor.agx-claude-code' as const;
export const ProviderCapabilitiesSchemaVersion = 'yellow-goal/provider-capabilities/v1' as const;
export const ProviderStubScenarios = ['await-cancel', 'budget-exhausted', 'failed', 'success'] as const;
export type StubScenario = (typeof ProviderStubScenarios)[number];

export interface ProviderCapabilities {
  schemaVersion: typeof ProviderCapabilitiesSchemaVersion;
  protocolVersion: typeof ProviderProtocolVersion;
  engineVersion: string;
  requestSchemaVersion: typeof RepositoryGoalRequestSchemaVersion;
  runEventSchemaVersion: typeof RunEventSchemaVersion;
  operations: ['capabilities', 'request.create', 'request.validate', 'run', 'version'];
  capabilities: ['run.cancel.os-signal', 'run.executor.stub', 'run.gate.noninteractive', 'run.stdout.jsonl', 'run.timeout'];
  stubScenarios: typeof ProviderStubScenarios;
  limits: { maxEventBytes: number; maxQueuedBytes: number; writerFinalizationTimeoutMs: number };
}

export interface ProviderCapabilitiesV2
  extends Omit<ProviderCapabilities, 'protocolVersion' | 'capabilities'> {
  protocolVersion: typeof ProviderProtocolV2;
  supportedProtocols: typeof SupportedProtocols;
  capabilities: [
    'run.cancel.os-signal', typeof RealRunExecutorCapability, 'run.executor.stub',
    'run.gate.noninteractive', 'run.stdout.jsonl', 'run.timeout',
  ];
}

/** Static discovery only: no run/executor imports, child processes, targets, or credentials. */
export async function runCapabilities(argv: string[]): Promise<CommandOutput<ProviderCapabilities | ProviderCapabilitiesV2>> {
  let values: { json?: boolean; protocol?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: { json: { type: 'boolean', default: false }, protocol: { type: 'string' } }, allowPositionals: true }));
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
  if (positionals.length > 0) throw new CliUsageError('capabilities accepts no positional arguments');
  if (values.protocol !== undefined && values.protocol !== 'v1' && values.protocol !== 'v2') {
    throw new CliUsageError(`unsupported protocol ${values.protocol}; expected v1 or v2`);
  }
  const v1: ProviderCapabilities = {
    schemaVersion: ProviderCapabilitiesSchemaVersion,
    protocolVersion: ProviderProtocolVersion,
    engineVersion: await readArtifactVersion(),
    requestSchemaVersion: RepositoryGoalRequestSchemaVersion,
    runEventSchemaVersion: RunEventSchemaVersion,
    operations: ['capabilities', 'request.create', 'request.validate', 'run', 'version'],
    capabilities: ['run.cancel.os-signal', 'run.executor.stub', 'run.gate.noninteractive', 'run.stdout.jsonl', 'run.timeout'],
    stubScenarios: ProviderStubScenarios,
    limits: {
      maxEventBytes: PROTOCOL_STDOUT_MAX_EVENT_BYTES,
      maxQueuedBytes: PROTOCOL_STDOUT_MAX_QUEUED_BYTES,
      writerFinalizationTimeoutMs: PROTOCOL_STDOUT_FINALIZE_MS,
    },
  };
  // PP-01 always uses compact JSON, with or without --json.
  if (values.protocol !== 'v2') return { json: true, output: v1 };
  const { protocolVersion: _v1, capabilities: _caps, ...shared } = v1;
  return {
    json: true,
    output: {
      ...shared,
      protocolVersion: ProviderProtocolV2,
      supportedProtocols: SupportedProtocols,
      capabilities: ['run.cancel.os-signal', RealRunExecutorCapability, 'run.executor.stub', 'run.gate.noninteractive', 'run.stdout.jsonl', 'run.timeout'],
    },
  };
}
