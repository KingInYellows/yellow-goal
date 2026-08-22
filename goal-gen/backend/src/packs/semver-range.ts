/**
 * Minimal semver-range check, scoped to exactly what pack.json's `compatibleEngine` field needs:
 * a space-separated AND of `<op><major>.<minor>.<patch>` clauses (e.g. `>=0.1.0 <1.0.0`). Not a
 * general semver library — no pre-release tags, no `^`/`~`, no OR ranges. Kept dependency-free
 * per the worker charter ("DO NOT touch package.json").
 */

interface Version {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(text: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!match) throw new Error(`not a valid dotted version: "${text}"`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

const CLAUSE_PATTERN = /^(>=|<=|>|<|=)(\d+\.\d+\.\d+)$/;

/**
 * Returns true if `version` satisfies every AND-ed clause in `range` (e.g. `>=0.1.0 <1.0.0`).
 * Throws on a clause this minimal parser does not understand, rather than silently passing —
 * fail-closed on unparseable engine constraints, never fail-open.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const target = parseVersion(version);
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (clauses.length === 0) throw new Error(`empty compatibleEngine range`);

  for (const clause of clauses) {
    const match = CLAUSE_PATTERN.exec(clause);
    if (!match) throw new Error(`unsupported compatibleEngine clause: "${clause}" (in range "${range}")`);
    const [, op, versionText] = match;
    const clauseVersion = parseVersion(versionText!);
    const cmp = compareVersions(target, clauseVersion);
    const ok =
      op === '>=' ? cmp >= 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : op === '<' ? cmp < 0 : cmp === 0;
    if (!ok) return false;
  }
  return true;
}
