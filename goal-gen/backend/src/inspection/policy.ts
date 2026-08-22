/**
 * Protected-path policy matcher, consuming the vendored `goal-gen/policies/protected-paths.json`
 * (NOT the guidance-dir copy — main's Phase 2 instruction #4). The policy's pattern language is
 * intentionally tiny: an optional `**/` any-depth prefix, an optional `/**` any-depth suffix, and
 * `*` within a path segment. This module implements exactly that (no general glob library, no new
 * dependency) — nothing else appears in `protected-paths.json` and nothing else should be needed.
 *
 * Semantics:
 * - A path is protected if it matches any `defaultPatterns` entry AND does not match any
 *   `allowedSanitizedPatterns` entry (sanitized overrides protected — e.g. `.env.example` matches
 *   both `**\/.env.*` and `**\/.env.example`; the sanitized match wins).
 * - Matching is implemented as written, with a deliberate bias toward over-matching: a false
 *   positive here just means a legitimate file gets metadata-only treatment (mildly annoying); a
 *   false negative could mean reading a real secret's content (unacceptable). So `**\/*token*`
 *   matching `tokenizer.ts` is correct behavior, not a bug to special-case away.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProtectedPathPolicy {
  schemaVersion: string;
  defaultPatterns: string[];
  allowedSanitizedPatterns: string[];
  rule: string;
}

/** goal-gen/policies/protected-paths.json — three levels up from backend/src/inspection/. */
const DEFAULT_POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'policies', 'protected-paths.json');

export async function loadProtectedPathPolicy(policyPath: string = DEFAULT_POLICY_PATH): Promise<ProtectedPathPolicy> {
  const raw = await readFile(policyPath, 'utf8');
  return JSON.parse(raw) as ProtectedPathPolicy;
}

function escapeRegExpLiteral(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles one policy pattern into a RegExp anchored against a git-relative path (no leading
 *  `/`, forward slashes only — the same shape `git ls-files`/`ls-tree` produce). */
function compilePattern(pattern: string): RegExp {
  let p = pattern;
  const anyDepthPrefix = p.startsWith('**/');
  if (anyDepthPrefix) p = p.slice(3);
  const anyDepthSuffix = p.endsWith('/**');
  if (anyDepthSuffix) p = p.slice(0, -3);

  const body = p.split('*').map(escapeRegExpLiteral).join('[^/]*');
  const prefix = anyDepthPrefix ? '(?:.*/)?' : '';
  const suffix = anyDepthSuffix ? '(?:/.*)?' : '';
  return new RegExp(`^${prefix}${body}${suffix}$`);
}

export interface CompiledProtectedPathPolicy {
  isProtected(relPath: string): boolean;
}

export function compileProtectedPathPolicy(policy: ProtectedPathPolicy): CompiledProtectedPathPolicy {
  const protectedRes = policy.defaultPatterns.map(compilePattern);
  const sanitizedRes = policy.allowedSanitizedPatterns.map(compilePattern);
  return {
    isProtected(relPath: string): boolean {
      const matchesProtected = protectedRes.some((re) => re.test(relPath));
      if (!matchesProtected) return false;
      const matchesSanitized = sanitizedRes.some((re) => re.test(relPath));
      return !matchesSanitized;
    },
  };
}
