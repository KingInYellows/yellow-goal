import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { RepositoryGoalRequest } from '../contracts/request';
import {
  normalizeRequest,
  validateCanonicalRequest,
  type FlatRepositoryGoalRequestInput,
} from '../intake';
import { CliUsageError, NotWiredError } from './errors';
import type {
  AnalyzeArgs,
  AnalyzeFn,
  AnalyzeResult,
  CompileArgs,
  CompileFn,
  CompileResult,
  InspectArgs,
  InspectFn,
  InspectResult,
  PacketVerifyArgs,
  PacketVerifyFn,
  PacketVerifyResult,
} from './types';

export interface CommandOutput<T> {
  json: boolean;
  output: T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Loads an optional peer module by a non-literal specifier (deliberately not a string literal at
 * the `import()` call site — literal specifiers get statically type-checked by tsc/bundler
 * resolution and would fail typecheck while worker B/C's modules don't exist yet). Returns null
 * if the module cannot be resolved at all; callers turn that into a NotWiredError.
 */
async function loadOptionalModule(modulePath: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(/* @vite-ignore */ modulePath)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// request create — fully wired
// ---------------------------------------------------------------------------

export interface RequestCreateOutput {
  requestId: string;
  path?: string;
  request: RepositoryGoalRequest;
}

export async function runRequestCreate(argv: string[]): Promise<CommandOutput<RequestCreateOutput>> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      goal: { type: 'string' },
      output: { type: 'string' },
      ref: { type: 'string' },
      mode: { type: 'string' },
      pack: { type: 'string' },
      'request-id': { type: 'string' },
      'permission-profile': { type: 'string' },
      'orchestration-profile': { type: 'string' },
      'why-now': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (!values.repo) throw new CliUsageError('request create requires --repo');
  if (!values.goal) throw new CliUsageError('request create requires --goal');

  const input: FlatRepositoryGoalRequestInput = {
    repository: values.repo,
    goal: values.goal,
    ...(values.ref !== undefined ? { ref: values.ref } : {}),
    ...(values.mode !== undefined ? { mode: values.mode as RepositoryGoalRequest['mode'] } : {}),
    ...(values.pack !== undefined ? { pack: values.pack } : {}),
    ...(values['request-id'] !== undefined ? { requestId: values['request-id'] } : {}),
    ...(values['permission-profile'] !== undefined
      ? { permissionProfile: values['permission-profile'] }
      : {}),
    ...(values['orchestration-profile'] !== undefined
      ? { orchestrationProfile: values['orchestration-profile'] }
      : {}),
    ...(values['why-now'] !== undefined ? { whyNow: values['why-now'] } : {}),
  };

  // Throws IntakeValidationFailure on invalid input — the CLI entry point (index.ts) converts
  // that into a structured stderr error + nonzero exit.
  const request = normalizeRequest(input);

  let writtenPath: string | undefined;
  if (values.output) {
    writtenPath = values.output;
    await writeJsonFile(writtenPath, request);
  }

  return {
    json: values.json === true,
    output: { requestId: request.requestId, ...(writtenPath ? { path: writtenPath } : {}), request },
  };
}

// ---------------------------------------------------------------------------
// request validate — fully wired
// ---------------------------------------------------------------------------

export interface RequestValidateOutput {
  path: string;
  valid: boolean;
  errors: { path: string; message: string }[];
}

export async function runRequestValidate(
  argv: string[],
): Promise<CommandOutput<RequestValidateOutput>> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });

  if (positionals.length !== 1) {
    throw new CliUsageError('request validate requires exactly one <file> positional argument');
  }
  const filePath = positionals[0]!;

  const raw = await readFile(filePath, 'utf8');
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch (err) {
    throw new CliUsageError(`${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = validateCanonicalRequest(candidate);

  return {
    json: values.json === true,
    output: { path: filePath, valid: result.valid, errors: result.errors },
  };
}

// ---------------------------------------------------------------------------
// inspect — delegates to worker B's inspection module (not wired until integration)
// ---------------------------------------------------------------------------

export async function runInspect(argv: string[]): Promise<CommandOutput<InspectResult>> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { output: { type: 'string' }, json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });

  const requestPath = positionals[0];
  if (!requestPath) throw new CliUsageError('inspect requires a <request> positional argument');
  if (!values.output) throw new CliUsageError('inspect requires --output');

  const modulePath = '../inspection/index';
  const mod = await loadOptionalModule(modulePath);
  const fn = mod?.inspectRepository as InspectFn | undefined;
  if (!mod || typeof fn !== 'function') {
    throw new NotWiredError('inspect', modulePath, 'inspectRepository');
  }

  // Production wiring: github-hosted targets need a live gh-backed client (tests always inject
  // RecordedGhClient through inspectRepository's deps parameter instead of coming through here).
  const ghMod = await loadOptionalModule('../providers/gh-client');
  const LiveGh = ghMod?.LiveGhClient as (new () => unknown) | undefined;
  const deps = LiveGh ? { ghClient: new LiveGh() } : undefined;

  const args: InspectArgs = { requestPath, outputDir: values.output };
  const result = await (fn as (a: InspectArgs, d?: unknown) => ReturnType<InspectFn>)(args, deps);
  return { json: values.json === true, output: result };
}

// ---------------------------------------------------------------------------
// analyze — delegates to worker C's analysis module (not wired until integration)
// ---------------------------------------------------------------------------

export async function runAnalyze(argv: string[]): Promise<CommandOutput<AnalyzeResult>> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      profile: { type: 'string' },
      output: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const requestPath = positionals[0];
  if (!requestPath) throw new CliUsageError('analyze requires a <request> positional argument');
  if (!values.profile) throw new CliUsageError('analyze requires --profile');
  if (!values.output) throw new CliUsageError('analyze requires --output');

  const modulePath = '../analysis/index';
  const mod = await loadOptionalModule(modulePath);
  const fn = mod?.analyzeRepository as AnalyzeFn | undefined;
  if (!mod || typeof fn !== 'function') {
    throw new NotWiredError('analyze', modulePath, 'analyzeRepository');
  }

  const args: AnalyzeArgs = {
    requestPath,
    repoProfilePath: values.profile,
    outputDir: values.output,
  };
  const result = await fn(args);
  return { json: values.json === true, output: result };
}

// ---------------------------------------------------------------------------
// compile — delegates to worker C's packet-compiler module (not wired until integration)
// ---------------------------------------------------------------------------

export async function runCompile(argv: string[]): Promise<CommandOutput<CompileResult>> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      assessment: { type: 'string' },
      pack: { type: 'string', default: 'repository-goal-packet@1' },
      output: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const requestPath = positionals[0];
  if (!requestPath) throw new CliUsageError('compile requires a <request> positional argument');
  if (!values.assessment) throw new CliUsageError('compile requires --assessment');
  if (!values.output) throw new CliUsageError('compile requires --output');

  const modulePath = '../packets/index';
  const mod = await loadOptionalModule(modulePath);
  const fn = mod?.compilePacket as CompileFn | undefined;
  if (!mod || typeof fn !== 'function') {
    throw new NotWiredError('compile', modulePath, 'compilePacket');
  }

  const args: CompileArgs = {
    requestPath,
    assessmentPath: values.assessment,
    pack: values.pack,
    outputDir: values.output,
  };
  const result = await fn(args);
  return { json: values.json === true, output: result };
}

// ---------------------------------------------------------------------------
// packet verify — delegates to worker C's packet-compiler module (not wired until integration)
// ---------------------------------------------------------------------------

export async function runPacketVerify(argv: string[]): Promise<CommandOutput<PacketVerifyResult>> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      // Staleness gate: with --target, the packet's manifest headSha is compared to the live
      // repository HEAD; a mismatch fails verification unless --allow-stale explicitly
      // acknowledges it (recorded in the check details — never a silent pass).
      target: { type: 'string' },
      'allow-stale': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const packetPath = positionals[0];
  if (!packetPath) throw new CliUsageError('packet verify requires a <path> positional argument');

  const modulePath = '../packets/index';
  const mod = await loadOptionalModule(modulePath);
  const create = mod?.createVerifyPacket as ((opts: { liveTargetPath?: string; allowStale?: boolean }) => PacketVerifyFn) | undefined;
  const fn = create
    ? create({ liveTargetPath: values.target, allowStale: values['allow-stale'] === true })
    : (mod?.verifyPacket as PacketVerifyFn | undefined);
  if (!mod || typeof fn !== 'function') {
    throw new NotWiredError('packet verify', modulePath, 'verifyPacket');
  }

  const args: PacketVerifyArgs = { packetPath };
  const result = await fn(args);
  return { json: values.json === true, output: result };
}

// ---------------------------------------------------------------------------
// version — engine artifact identity (RR17)
// ---------------------------------------------------------------------------

export interface VersionOutput {
  engineVersion: string;
}

/**
 * Identity probe ONLY — deliberately non-normative (RR17, plans/specs/
 * request-to-run-pipeline.md). `engineVersion` is the goal-gen package artifact version
 * (package.json — what a tarball install pins), which is exactly what an external process
 * consumer can hold constant. It is NOT `packets/compiler.ts`'s `ENGINE_VERSION` (that string
 * tracks pack/packet-format compatibility) and NOT a protocol version (none exists yet).
 * Compatibility semantics — what a consumer may infer from this value — are defined by
 * provider protocol v1, not here.
 */
export async function runVersion(argv: string[]): Promise<CommandOutput<VersionOutput>> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: false,
  });
  const raw = await readFile(new URL('../../../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json has no version — cannot report engine identity');
  }
  return { json: values.json === true, output: { engineVersion: pkg.version } };
}
