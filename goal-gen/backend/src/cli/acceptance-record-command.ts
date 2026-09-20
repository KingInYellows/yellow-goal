/**
 * `acceptance record <fixture.json>` — fixture-only JSON recorder.
 *
 * Dynamically imported by the dispatcher so compiler/protocol cold paths never
 * load this module. Never imports run-command, executors, or subprocess APIs.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { CommandOutput } from './commands';
import { recordAcceptanceEvidence, type AcceptanceEvidenceRecord } from './acceptance-evidence';
import { AcceptanceEvidenceError, CliUsageError } from './errors';

export async function runAcceptanceRecord(argv: string[]): Promise<CommandOutput<AcceptanceEvidenceRecord>> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });

  if (positionals.length !== 1) {
    throw new CliUsageError('acceptance record requires exactly one <fixture.json> positional argument');
  }
  const filePath = positionals[0]!;

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : 'UNKNOWN';
    throw new AcceptanceEvidenceError(
      'IO_ERROR',
      `cannot read acceptance fixture ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { path: filePath, code },
    );
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new AcceptanceEvidenceError(
      'SCHEMA_INVALID',
      `${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    json: values.json === true,
    output: recordAcceptanceEvidence(candidate),
  };
}
