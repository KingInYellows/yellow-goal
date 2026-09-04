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

/** Static discovery only: no run/executor imports, child processes, targets, or credentials. */
export async function runCapabilities(argv: string[]): Promise<CommandOutput<ProviderCapabilities>> {
  let values: { json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: { json: { type: 'boolean', default: false } }, allowPositionals: true }));
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
  if (positionals.length > 0) throw new CliUsageError('capabilities accepts no positional arguments');
  return {
    // PP-01 always uses compact JSON, with or without --json.
    json: true,
    output: {
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
    },
  };
}
