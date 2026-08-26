#!/usr/bin/env node
/**
 * Non-interactive CLI dispatcher for the repository goal packet compiler AND the M1 run verb.
 *
 * Commands: `request create`, `request validate <file>`, `inspect <request>`, `analyze
 * <request>`, `compile <request>`, `packet verify <path>`, `run <request>` (RR11). `--json`
 * selects machine-readable stdout for successful command output; failures are always a
 * single-line structured JSON object on stderr with a nonzero exit code, `--json` or not, so
 * scripts can rely on it either way. `run` streams run-event/v1 JSON Lines on stdout instead of
 * one object (RR12) and exits 0 only when the run succeeded.
 */
import {
  runAnalyze,
  runCompile,
  runInspect,
  runPacketVerify,
  runRequestCreate,
  runRequestValidate,
  type CommandOutput,
} from './commands';
import { CliUsageError, NotWiredError } from './errors';
import { IntakeValidationFailure } from '../intake';
import { isDirectInvocation } from './direct-invocation';

interface CliErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

function writeError(code: string, message: string, details?: unknown): void {
  const payload: CliErrorPayload = {
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

function writeSuccess<T>(result: CommandOutput<T>): void {
  if (result.json) {
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'request': {
      const [sub, ...subRest] = rest;
      if (sub === 'create') {
        writeSuccess(await runRequestCreate(subRest));
        return 0;
      }
      if (sub === 'validate') {
        const result = await runRequestValidate(subRest);
        writeSuccess(result);
        return result.output.valid ? 0 : 1;
      }
      throw new CliUsageError(`unknown 'request' subcommand: ${sub ?? '(none)'} (expected create|validate)`);
    }
    case 'packet': {
      const [sub, ...subRest] = rest;
      if (sub === 'verify') {
        const result = await runPacketVerify(subRest);
        writeSuccess(result);
        return result.output.valid ? 0 : 1;
      }
      throw new CliUsageError(`unknown 'packet' subcommand: ${sub ?? '(none)'} (expected verify)`);
    }
    case 'run': {
      // M1 subsystem verb — dynamically imported so the compiler verbs' process never loads
      // executor/orchestrator mutation code (packet-compiler.md isolation rule). The command
      // streams its own stdout (run-event/v1 JSON Lines) and returns the exit code directly.
      const { runRunCommand } = await import('./run-command');
      return runRunCommand(rest);
    }
    case 'inspect':
      writeSuccess(await runInspect(rest));
      return 0;
    case 'analyze':
      writeSuccess(await runAnalyze(rest));
      return 0;
    case 'compile':
      writeSuccess(await runCompile(rest));
      return 0;
    default:
      throw new CliUsageError(
        `unknown command: ${command ?? '(none)'} (expected request|inspect|analyze|compile|packet|run)`,
      );
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      writeError('USAGE_ERROR', err.message);
      return 2;
    }
    if (err instanceof NotWiredError) {
      writeError('NOT_WIRED', err.message);
      return 1;
    }
    if (err instanceof IntakeValidationFailure) {
      writeError('VALIDATION_FAILED', err.message, err.errors);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    // Domain errors that carry structured diagnostics in a `details` field (e.g.
    // PacketCompilationError's ValidationResult) get them surfaced so automation sees WHICH
    // check failed, not just that one did; errors without the field fall through harmlessly.
    const details = err instanceof Error && 'details' in err ? (err as Error & { details?: unknown }).details : undefined;
    writeError('UNEXPECTED_ERROR', message, details);
    return 1;
  }
}

/* c8 ignore start -- entry-point wiring, exercised via the compiled CLI in tests, not directly */
if (isDirectInvocation(import.meta.url, process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  });
}
/* c8 ignore stop */
