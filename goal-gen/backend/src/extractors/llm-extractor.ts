/**
 * `LlmExtractor` implementation (goal-extractor.md): plain-English goal → schema-valid `GoalSpec`
 * via headless `claude -p`, behind a thin `LlmClient` so the transport is swappable later
 * (CLAUDE.md invariant #4). The LLM only AUTHORS the action graph here; everything downstream is
 * deterministic (invariant #1).
 *
 * The repair round is load-bearing: `claude -p` has no forced-tool-use, so the model's JSON is
 * prompt-enforced, pre-processed (fences/BOM/trailing commas), parsed, and zod-validated; on failure
 * we re-prompt ONCE with the formatted issues, then give up with a structured `ExtractionError`
 * rather than ever passing junk to `plan()`.
 */
import { spawn } from 'node:child_process';
import { DEFAULT_MODEL } from '../orchestrator/guardrails';
import type { Action, GoalSpec, WorldState } from '../planner/types';
import type { ExtractRequest, FailureEvidence, LlmExtractor } from '../types';
import { expandPrompt, extractionPrompt, repairPrompt } from './prompts';
import { ActionArraySchema, formatZodIssues, GoalSpecSchema } from './schema';

/** Structured extractor failure — never thrown as a bare string, never silently swallowed. */
export class ExtractionError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ExtractionError';
    this.detail = detail;
  }
}

export interface LlmCompletion {
  text: string;
  costUsd: number;
}

/** The thin LLM transport the extractor authors through. Swappable (claude -p now; API later). */
export interface LlmClient {
  complete(prompt: string): Promise<LlmCompletion>;
}

const EXTRACT_TIMEOUT_MS = 120_000;
const SIGKILL_GRACE_MS = 5_000;
/** Max chars of a failed LLM response fed back into the repair prompt to avoid blowing context. */
const REPAIR_CONTEXT_MAX_CHARS = 8_000;

interface RawSpawn {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
  spawnError: string | undefined;
}

function spawnClaudeText(argv: readonly string[], timeoutMs: number): Promise<RawSpawn> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('claude', [...argv], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ stdout: '', stderr: '', code: null, killed: false, spawnError: (e as Error).message });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    let killed = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      sigkillTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
    }, timeoutMs);
    const finish = (res: RawSpawn): void => {
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve(res);
    };
    child.on('error', (e) =>
      finish({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code: null, killed, spawnError: e.message }),
    );
    child.on('close', (code) =>
      finish({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code, killed, spawnError: undefined }),
    );
  });
}

interface MinimalEnvelope {
  result: string;
  costUsd: number;
  isError: boolean;
}

/** Read just the fields the extractor needs from the `--output-format json` envelope. */
function readEnvelope(stdout: string): MinimalEnvelope | null {
  const tryParse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  const toEnvelope = (obj: unknown): MinimalEnvelope | null => {
    if (typeof obj !== 'object' || obj === null) return null;
    const o = obj as Record<string, unknown>;
    return {
      result: typeof o['result'] === 'string' ? o['result'] : '',
      costUsd: typeof o['total_cost_usd'] === 'number' ? o['total_cost_usd'] : 0,
      isError: o['is_error'] === true,
    };
  };

  // Fast path: try the whole stdout as a single JSON object.
  const direct = tryParse(stdout.trim());
  if (direct !== undefined) return toEnvelope(direct);

  // NDJSON / mixed-output: try each non-empty line; prefer the first line that parses to an object
  // with a 'result' key (the Claude SDK envelope), fall back to the last object-shaped line.
  let lastObj: unknown;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = tryParse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      if ('result' in (parsed as Record<string, unknown>)) return toEnvelope(parsed);
      lastObj = parsed;
    }
  }
  if (lastObj !== undefined) return toEnvelope(lastObj);

  // Last resort: scan for the first balanced top-level {...} block.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start >= 0 && end > start) return toEnvelope(tryParse(stdout.slice(start, end + 1)));

  return null;
}

export interface ClaudeLlmClientOptions {
  model?: string;
  timeoutMs?: number;
}

/** Production `LlmClient`: one structured `claude -p --output-format json --max-turns 1` call. */
export class ClaudeLlmClient implements LlmClient {
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: ClaudeLlmClientOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  }

  async complete(prompt: string): Promise<LlmCompletion> {
    const argv = ['-p', prompt, '--output-format', 'json', '--max-turns', '1', '--model', this.model];
    const res = await spawnClaudeText(argv, this.timeoutMs);
    if (res.spawnError) {
      throw new ExtractionError(`claude failed to spawn: ${res.spawnError} (is the CLI installed and logged in?)`);
    }
    if (res.killed) throw new ExtractionError(`claude extraction timed out after ${this.timeoutMs}ms`);
    const env = readEnvelope(res.stdout);
    if (!env) throw new ExtractionError(`claude returned an unparseable envelope (exit ${res.code})`, { raw: res.stdout.slice(0, 2000) });
    if (env.isError) throw new ExtractionError(`claude reported is_error (exit ${res.code})`, { raw: res.stdout.slice(0, 2000) });
    return { text: env.result, costUsd: env.costUsd };
  }
}

/** Normalize a model "JSON" string: strip BOM, code fences, and surrounding prose. NO comma repair —
 *  that is a fallback in `parseJson` so it never corrupts a valid command containing a literal `,}`. */
export function preprocessJson(text: string): string {
  let t = text;
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // UTF-8 BOM
  t = t.trim();
  const fenceInner = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)?.[1];
  if (fenceInner !== undefined) t = fenceInner.trim();
  // Keep only the outermost JSON value (object or array), dropping any prose around it.
  const candidates = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0);
  const start = candidates.length ? Math.min(...candidates) : -1;
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return t;
}

/**
 * Parse model output to JSON: try the preprocessed text as-is FIRST (so valid JSON — including a
 * verify command containing the literal sequence `,}` or `,]` — is never altered); only if that
 * fails do we strip trailing commas and retry. The unconditional regex used to corrupt valid
 * commands silently.
 */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const pre = preprocessJson(text);
  try {
    return { ok: true, value: JSON.parse(pre) };
  } catch {
    try {
      return { ok: true, value: JSON.parse(pre.replace(/,(\s*[}\]])/g, '$1')) };
    } catch (e) {
      return { ok: false, error: `response was not valid JSON: ${(e as Error).message}` };
    }
  }
}

/** Truncate oversized LLM output before feeding it into the repair prompt (prevents context blowout). */
function capForRepair(text: string): string {
  if (text.length <= REPAIR_CONTEXT_MAX_CHARS) return text;
  return text.slice(0, REPAIR_CONTEXT_MAX_CHARS) + `\n… [truncated ${text.length - REPAIR_CONTEXT_MAX_CHARS} chars]`;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function tryParseGoalSpec(text: string): ParseResult<GoalSpec> {
  const json = parseJson(text);
  if (!json.ok) return json;
  const parsed = GoalSpecSchema.safeParse(json.value);
  if (!parsed.success) return { ok: false, error: formatZodIssues(parsed.error) };
  // `as` bridges one zod quirk: z.unknown() infers `mcpTool.args?` (optional) while the planner type
  // requires it — a benign optionality gap on an M2-only field, not real drift.
  return { ok: true, value: parsed.data as GoalSpec };
}

function tryParseActions(text: string): ParseResult<Action[]> {
  const json = parseJson(text);
  if (!json.ok) return json;
  const parsed = ActionArraySchema.safeParse(json.value);
  if (!parsed.success) return { ok: false, error: formatZodIssues(parsed.error) };
  return { ok: true, value: parsed.data as Action[] }; // see tryParseGoalSpec for the zod-`unknown` cast note
}

/**
 * Dedup guard (plan task 3.4): rename any new action whose id collides with the existing pool (or an
 * earlier new action) so `plan()` never throws on a duplicate id. Action ids are not referenced by
 * other actions (pre/effects are over WorldState keys), so renaming is safe.
 */
export function dedupeIds(newActions: Action[], existingPool: Action[]): Action[] {
  const taken = new Set(existingPool.map((a) => a.id));
  return newActions.map((a) => {
    if (!taken.has(a.id)) {
      taken.add(a.id);
      return a;
    }
    let n = 2;
    while (taken.has(`${a.id}-ext${n}`)) n++;
    const id = `${a.id}-ext${n}`;
    taken.add(id);
    return { ...a, id };
  });
}

export interface LlmExtractorOptions {
  /** Structured measurement/diagnostic sink. Defaults to JSON-lines on stderr (keeps stdout clean). */
  onEvent?: (event: Record<string, unknown>) => void;
}

export class LlmExtractorImpl implements LlmExtractor {
  private readonly client: LlmClient;
  private readonly emit: (event: Record<string, unknown>) => void;

  constructor(client: LlmClient, opts: LlmExtractorOptions = {}) {
    this.client = client;
    this.emit = opts.onEvent ?? ((e) => process.stderr.write(`${JSON.stringify(e)}\n`));
  }

  async extract(req: ExtractRequest): Promise<GoalSpec> {
    const prompt = extractionPrompt(req);
    const first = await this.client.complete(prompt);
    const firstParse = tryParseGoalSpec(first.text);
    if (firstParse.ok) {
      this.emit({ ev: 'extract.measure', firstTry: true, repairNeeded: false, success: true });
      return firstParse.value;
    }
    // one bounded repair round (cap previous output so an oversized response doesn't blow repair
    // context; pass the original prompt so the repair has the goal + schema even if `first` was junk)
    const repaired = await this.client.complete(repairPrompt(prompt, capForRepair(first.text), firstParse.error));
    const repairParse = tryParseGoalSpec(repaired.text);
    this.emit({ ev: 'extract.measure', firstTry: false, repairNeeded: true, success: repairParse.ok });
    if (repairParse.ok) return repairParse.value;
    throw new ExtractionError('extractor produced no schema-valid GoalSpec after one repair round', {
      issues: repairParse.error,
      rawFirst: first.text.slice(0, 2000),
      rawRepair: repaired.text.slice(0, 2000),
    });
  }

  async expand(
    goalText: string,
    currentState: WorldState,
    failureEvidence: FailureEvidence,
    existingPool: Action[],
  ): Promise<Action[]> {
    const prompt = expandPrompt(goalText, currentState, failureEvidence, existingPool);
    const first = await this.client.complete(prompt);
    let parse = tryParseActions(first.text);
    if (!parse.ok) {
      const repaired = await this.client.complete(repairPrompt(prompt, capForRepair(first.text), parse.error));
      parse = tryParseActions(repaired.text);
    }
    if (!parse.ok) {
      this.emit({ ev: 'expand.measure', success: false });
      throw new ExtractionError('expand produced no schema-valid actions after one repair round', {
        issues: parse.error,
      });
    }
    const deduped = dedupeIds(parse.value, existingPool);
    if (deduped.length === 0) {
      this.emit({ ev: 'expand.measure', success: false, added: 0 });
      throw new ExtractionError('expand returned zero new actions — cannot extend the action pool', {
        rawFirst: first.text.slice(0, 2000),
      });
    }
    this.emit({ ev: 'expand.measure', success: true, added: deduped.length });
    return deduped;
  }
}
