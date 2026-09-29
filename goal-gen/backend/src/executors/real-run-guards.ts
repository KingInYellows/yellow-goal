/**
 * Pre-spawn guards for the approval-gated real run (ADR-0020, AGX-R11/R13). Every function here
 * refuses before any worker process exists. This module must never import the approval modules
 * (`cli/run-approval*.ts`, `cli/run-manifest.ts`) — they are isolated from `executors/` — and
 * must never name the one permission mode the real run can never reach (static test).
 */
import { RunApprovalError } from '../cli/errors';

export type RealRunAuthMode = 'subscription' | 'api-key';

/**
 * AGX-R13: the environment's credential must match the manifest's auth mode in both directions.
 * An API key present under `subscription` silently overrides the subscription (spike §7); an
 * absent key under `api-key` silently falls back to the subscription. Never echoes the key.
 */
export function assertAuthModeMatchesEnv(authMode: RealRunAuthMode, env: NodeJS.ProcessEnv): void {
  const rerouting = CREDENTIAL_OVERRIDE_VARS.filter((name) => isSet(env[name]));
  if (rerouting.length > 0) {
    throw new RunApprovalError(
      'AUTH_MODE_MISMATCH',
      `${rerouting.join(', ')} would override the approved '${authMode}' credential or route the worker elsewhere`,
      { authMode, overridingVariables: rerouting },
    );
  }
  const keyPresent = isSet(env.ANTHROPIC_API_KEY);
  if (keyPresent && authMode !== 'api-key') {
    throw new RunApprovalError(
      'AUTH_MODE_MISMATCH',
      `ANTHROPIC_API_KEY is set but the approved auth mode is '${authMode}'; the key would override the subscription`,
      { authMode, apiKeyPresent: true },
    );
  }
  if (!keyPresent && authMode === 'api-key') {
    throw new RunApprovalError(
      'AUTH_MODE_MISMATCH',
      "the approved auth mode is 'api-key' but ANTHROPIC_API_KEY is not set; the CLI would fall back to the subscription",
      { authMode, apiKeyPresent: false },
    );
  }
}

/**
 * Environment variables that substitute a different credential or provider for the one the
 * manifest approved, in either auth mode. Only names are ever reported, never values.
 */
const CREDENTIAL_OVERRIDE_VARS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

function isSet(value: string | undefined): boolean {
  return typeof value === 'string' && value !== '';
}

/** Claude Code filesystem tools whose rules take a path specifier. Anything else is unconfinable. */
const FILESYSTEM_TOOLS: ReadonlySet<string> = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep']);
export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit'];
const WRITE_TOOL_SET: ReadonlySet<string> = new Set(WRITE_TOOLS);

/**
 * The one list of worker control paths — Claude Code config the worker would load, and git
 * metadata the engine's git calls read. The engine's deny rules, the pre-spawn worktree check and
 * the allow-rule check are all derived from it, so they cannot drift apart.
 */
export const REAL_RUN_CONTROL_NAMES: readonly string[] = ['.git', '.claude', '.mcp.json', 'CLAUDE.local.md'];
/** Lower-cased: on a case-insensitive filesystem `.Claude` names the same entry as `.claude`. */
const CONTROL_SEGMENTS: ReadonlySet<string> = new Set(REAL_RUN_CONTROL_NAMES.map((name) => name.toLowerCase()));
const TOOL_WITH_SPECIFIER = /^(?<tool>[A-Za-z][A-Za-z0-9_]*)\((?<specifier>.*)\)$/;
/**
 * The only specifier shape accepted: an optional `./`, then `/`-separated segments of letters,
 * digits, `.`, `_`, `-` and `*`. No whitespace, commas, quotes, brackets or braces, so one rule
 * can never be split or trimmed by the CLI into a different or second rule.
 */
const SCOPED_SPECIFIER = /^(\.\/)?[A-Za-z0-9._*-]+(\/[A-Za-z0-9._*-]+)*$/;

/**
 * Why a rule specifier escapes the worktree, or `null` when it is a relative in-worktree pattern
 * (`site.json`, `./SITE`, `./**`). In Claude Code rule syntax a leading `/` is relative to the
 * settings file, `//` is absolute and `~` is the home directory — none of them is the worktree.
 */
function unconfinedSpecifierReason(specifier: string): string | null {
  if (specifier.trim() === '') return 'empty specifier';
  if (specifier.startsWith('/')) return 'absolute or settings-relative path';
  if (specifier.startsWith('~')) return 'home-relative path';
  if (/^[A-Za-z]:/.test(specifier)) return 'drive-letter path';
  if (specifier.includes('\\')) return 'backslash in path';
  if (specifier.includes('$')) return 'variable expansion in path';
  if (specifier.split('/').includes('..')) return "'..' segment";
  if (!SCOPED_SPECIFIER.test(specifier)) return 'characters outside the scoped-path set';
  return null;
}

/**
 * Why a write rule's specifier names worker config or git metadata, or `null`. Wildcard write
 * rules that could still match them (`./**`) are covered by the executor's engine-constant deny
 * rules, which beat any allow rule.
 */
function controlPathReason(specifier: string): string | null {
  for (const segment of specifier.split('/')) {
    if (CONTROL_SEGMENTS.has(segment.toLowerCase())) return `names worker config or git metadata ('${segment}')`;
    if (segment.startsWith('.') && segment.includes('*')) return `dotfile wildcard '${segment}'`;
  }
  return null;
}

/**
 * AGX-R11 filesystem confinement: every allowed tool must be a filesystem tool whose rule is
 * path-scoped to the scratch worktree. `Bash` and every other non-filesystem tool can never be
 * path-scoped, so they are refused outright. That Claude Code *enforces* the scoped rules headless
 * is proven by the human-run permission probe (AGX-R34), not here.
 */
export function assertFilesystemToolsConfined(allowedTools: readonly string[]): void {
  const offending: Array<{ rule: string; reason: string }> = [];
  if (allowedTools.length === 0) {
    offending.push({ rule: '(none)', reason: 'the allowlist is empty' });
  }
  for (const rule of allowedTools) {
    const groups = TOOL_WITH_SPECIFIER.exec(rule)?.groups;
    const tool = groups?.tool;
    const specifier = groups?.specifier;
    if (tool === undefined || specifier === undefined) {
      offending.push({ rule, reason: 'not path-scoped' });
      continue;
    }
    if (!FILESYSTEM_TOOLS.has(tool)) {
      offending.push({ rule, reason: `'${tool}' is not a filesystem tool and cannot be path-scoped` });
      continue;
    }
    const reason = unconfinedSpecifierReason(specifier) ?? (WRITE_TOOL_SET.has(tool) ? controlPathReason(specifier) : null);
    if (reason !== null) offending.push({ rule, reason });
  }
  if (offending.length > 0) {
    throw new RunApprovalError(
      'TOOLS_UNCONFINED',
      `allowed tools must be filesystem tools path-scoped to the worktree: ${offending.map((o) => `${o.rule} (${o.reason})`).join(', ')}`,
      { offending },
    );
  }
}

/**
 * The distinct built-in tool names an approved allowlist uses, for `--tools`: every other built-in
 * tool (Bash included) is then unavailable to the worker, not merely unapproved. Call only after
 * `assertFilesystemToolsConfined`, which guarantees every rule has the `Tool(specifier)` shape.
 */
export function allowedToolNames(allowedTools: readonly string[]): string[] {
  // Non-null: the precondition guarantees the shape, and a violation should fail loudly.
  const names = allowedTools.map((rule) => TOOL_WITH_SPECIFIER.exec(rule)!.groups!.tool!);
  return [...new Set(names)].sort();
}

/** The only permission mode a real run can resolve to (AGX-R11). */
export type RealRunPermissionMode = 'acceptEdits';

/**
 * AGX-R11: resolves a requested permission mode for the real run. The return type admits exactly
 * one mode; any other input — including every mode the CLI accepts — throws, never coerces.
 */
export function resolveRealRunPermissionMode(requested: unknown): RealRunPermissionMode {
  if (requested === 'acceptEdits') return 'acceptEdits';
  throw new RunApprovalError(
    'MANIFEST_INVALID',
    `real runs only use permission mode 'acceptEdits' (got ${describeValue(requested)})`,
    { permissionMode: requested === undefined ? null : String(requested) },
  );
}

function describeValue(value: unknown): string {
  // JSON.stringify returns undefined (despite its declared type) for undefined and functions.
  return value === undefined ? 'undefined' : (JSON.stringify(value) ?? String(value));
}
