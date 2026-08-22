/**
 * Packet validation: pre-ZIP (content-level) checks and post-extraction (integrity) checks —
 * `07_PACKET_CONTRACT.md` "Required validation". Every check reports as its own
 * `ValidationResult.checks[]` entry with `passed|failed|skipped|unavailable|not-run`, never
 * collapsed into a single boolean, so a caller can see exactly which invariant broke.
 */
import { spawnSync } from 'node:child_process';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { EvidenceRecord, Finding, MilestoneSpec, RepositoryAssessment } from '../contracts';
import { PacketManifestSchema, ValidationResultSchema, type ValidationResult } from '../contracts';
import { isSymlinkExternalAttributes, readZipEntries } from './archive';
import { parseChecksumsFile, sha256Hex, type ChecksumEntry } from './checksums';

type CheckStatus = 'passed' | 'failed' | 'skipped' | 'unavailable' | 'not-run';

class CheckCollector {
  private readonly checks: { id: string; description: string; status: CheckStatus; details?: string }[] = [];

  add(id: string, description: string, status: CheckStatus, details?: string): void {
    this.checks.push(details === undefined ? { id, description, status } : { id, description, status, details });
  }

  passIf(id: string, description: string, condition: boolean, failDetails: string): void {
    this.add(id, description, condition ? 'passed' : 'failed', condition ? undefined : failDetails);
  }

  toResult(): ValidationResult {
    const overall = this.checks.every((c) => c.status === 'passed' || c.status === 'skipped' || c.status === 'unavailable')
      ? 'passed'
      : 'failed';
    const result = { schemaVersion: 'yellow-goal/validation-result/v1' as const, checks: this.checks, overall };
    const parsed = ValidationResultSchema.safeParse(result);
    if (!parsed.success) throw new Error(`internal error: built an invalid ValidationResult: ${parsed.error.message}`);
    return parsed.data;
  }
}

// ---------------------------------------------------------------------------
// Pre-ZIP content validation
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'private key header', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'generic bearer token assignment', pattern: /\b(?:api[_-]?key|secret|token)\s*[:=]\s*["'][A-Za-z0-9_\-/+]{20,}["']/i },
];

const BYPASS_PERMISSIONS_USAGE_PATTERNS: readonly RegExp[] = [
  /--permission-mode[\s=]+["']?bypassPermissions["']?/,
  /PERMISSION_MODE\s*=\s*["']?bypassPermissions/,
  /\$PermissionMode\s*=\s*["']?bypassPermissions/i,
];

/** The unresolved-placeholder check scopes to pack-shipped content only: the 9 numbered `.md`
 *  reports, `prompts/*`, and `templates/*` (all `.tmpl`-rendered, where a leftover `{{...}}`
 *  means a rendering defect) plus `scripts/*` (static pack assets copied via `readAsset` — not
 *  rendered, but pack-authored content that must never legitimately carry placeholder syntax).
 *  Everything else (`evidence/*`, `research/*`, `contracts/*.json`, `MANIFEST.json`,
 *  `CHECKSUMS.sha256`) is canonical JSON/JSONL or an untrusted repository-derived excerpt — a
 *  real evidence excerpt can legitimately CONTAIN placeholder-looking text (e.g. an excerpt of a
 *  repo's own docs about templating syntax) without that being a defect. Matches `compiler.ts`'s
 *  `TEMPLATE_LOGICAL_PATHS`/`SCRIPT_ASSET_PATHS` output paths exactly. */
const NUMBERED_REPORT_PATTERN = /^\d{2}_[A-Z0-9_]+\.md$/;

export function isTemplateRenderedPath(entryPath: string): boolean {
  return (
    NUMBERED_REPORT_PATTERN.test(entryPath) ||
    entryPath.startsWith('templates/') ||
    entryPath.startsWith('prompts/') ||
    entryPath.startsWith('scripts/')
  );
}

export interface RenderedFile {
  entryPath: string;
  content: string;
}

export interface PreZipValidationInput {
  files: readonly RenderedFile[];
  assessment: RepositoryAssessment;
  findings: readonly Finding[];
  milestone: MilestoneSpec;
  evidence: readonly EvidenceRecord[];
  goalResolutionEvidenceRefs: readonly string[];
}

export function validatePacketPreZip(input: PreZipValidationInput): ValidationResult {
  const c = new CheckCollector();
  const evidenceIds = new Set(input.evidence.map((e) => e.id));

  // Evidence references resolve.
  const unresolvedFindingRefs = input.findings.flatMap((f) => f.evidenceRefs.filter((ref) => !evidenceIds.has(ref)));
  c.passIf(
    'evidence-refs-resolve-findings',
    'every finding evidenceRef resolves to a known evidence record',
    unresolvedFindingRefs.length === 0,
    `unresolved: ${unresolvedFindingRefs.join(', ')}`,
  );
  const unresolvedGoalRefs = input.goalResolutionEvidenceRefs.filter((ref) => !evidenceIds.has(ref));
  c.passIf(
    'evidence-refs-resolve-goal-resolution',
    'every goalResolution evidenceRef resolves to a known evidence record',
    unresolvedGoalRefs.length === 0,
    `unresolved: ${unresolvedGoalRefs.join(', ')}`,
  );

  // Blocking/high findings have evidence (schema already enforces evidenceRefs.min(1); this
  // check catches a finding that somehow bypassed that, e.g. via a future schema relaxation).
  const blockingOrHighWithoutEvidence = input.findings.filter(
    (f) => (f.severity === 'blocking' || f.severity === 'high') && f.evidenceRefs.length === 0,
  );
  c.passIf(
    'blocking-high-findings-have-evidence',
    'every blocking/high finding cites at least one evidence record',
    blockingOrHighWithoutEvidence.length === 0,
    `findings without evidence: ${blockingOrHighWithoutEvidence.map((f) => f.id).join(', ')}`,
  );

  // Acceptance criteria have a verification method with the fields their type requires.
  const acWithoutMethod = input.milestone.acceptanceCriteria.filter((ac) => {
    if (ac.verification.type === 'command') return !ac.verification.commandRef;
    if (ac.verification.type === 'workflow') return !ac.verification.workflowRef;
    return false;
  });
  c.passIf(
    'acceptance-criteria-have-verification',
    'every acceptance criterion has a verification method with the fields its type requires',
    acWithoutMethod.length === 0,
    `criteria missing a ref: ${acWithoutMethod.map((ac) => ac.id).join(', ')}`,
  );

  // Duplicate IDs.
  const dupe = (ids: readonly string[]): string[] => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) dupes.add(id);
      seen.add(id);
    }
    return [...dupes];
  };
  const dupeFindingIds = dupe(input.findings.map((f) => f.id));
  c.passIf('no-duplicate-finding-ids', 'no duplicate finding IDs', dupeFindingIds.length === 0, dupeFindingIds.join(', '));
  const dupeAcIds = dupe(input.milestone.acceptanceCriteria.map((ac) => ac.id));
  c.passIf('no-duplicate-ac-ids', 'no duplicate acceptance-criterion IDs', dupeAcIds.length === 0, dupeAcIds.join(', '));
  const dupeEvidenceIds = dupe(input.evidence.map((e) => e.id));
  c.passIf('no-duplicate-evidence-ids', 'no duplicate evidence record IDs', dupeEvidenceIds.length === 0, dupeEvidenceIds.join(', '));

  // No protected/secret values.
  const secretHits: string[] = [];
  for (const file of input.files) {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(file.content)) secretHits.push(`${file.entryPath}: ${name}`);
    }
  }
  c.passIf('no-secret-patterns', 'no secret-like patterns in any rendered file', secretHits.length === 0, secretHits.join('; '));

  // Launch permissions comply — never bypassPermissions as an actual assigned/passed value.
  const bypassHits: string[] = [];
  for (const file of input.files) {
    if (BYPASS_PERMISSIONS_USAGE_PATTERNS.some((p) => p.test(file.content))) bypassHits.push(file.entryPath);
  }
  c.passIf('no-bypass-permissions-usage', 'no generated script assigns/passes bypassPermissions', bypassHits.length === 0, bypassHits.join(', '));

  // No unresolved required placeholders — scoped to template-rendered outputs only (numbered
  // reports, prompts/, templates/, scripts/), never data files. A placeholder can only originate
  // from .tmpl rendering; evidence/research/contracts/MANIFEST content is canonical data or an
  // untrusted excerpt that may legitimately contain placeholder-looking text.
  const templateRenderedFiles = input.files.filter((f) => isTemplateRenderedPath(f.entryPath));
  const unresolvedFiles = templateRenderedFiles.filter((f) => /\{\{[^{}]+\}\}/.test(f.content));
  c.passIf(
    'no-unresolved-placeholders',
    'no template-rendered file (numbered reports, prompts/, templates/, scripts/) still contains a {{ }} placeholder token',
    unresolvedFiles.length === 0,
    unresolvedFiles.map((f) => f.entryPath).join(', '),
  );

  // Malformed JSON/JSONL among rendered content.
  const malformed: string[] = [];
  for (const file of input.files) {
    if (file.entryPath.endsWith('.json')) {
      try {
        JSON.parse(file.content);
      } catch {
        malformed.push(file.entryPath);
      }
    } else if (file.entryPath.endsWith('.jsonl')) {
      for (const [i, line] of file.content.split('\n').filter((l) => l.trim()).entries()) {
        try {
          JSON.parse(line);
        } catch {
          malformed.push(`${file.entryPath}:${i + 1}`);
        }
      }
    }
  }
  c.passIf('no-malformed-json', 'every .json/.jsonl file parses', malformed.length === 0, malformed.join(', '));

  return c.toResult();
}

// ---------------------------------------------------------------------------
// Post-extraction verification (directory input)
// ---------------------------------------------------------------------------

const MAX_TOTAL_INFLATED_BYTES = 256 * 1024 * 1024;

function checkPathContainment(entryPath: string): boolean {
  if (path.isAbsolute(entryPath)) return false;
  const normalized = path.posix.normalize(entryPath);
  if (normalized.startsWith('..') || normalized.includes('../')) return false;
  return true;
}

async function walkDir(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // reported separately by the symlink check
    if (entry.isDirectory()) {
      files.push(...(await walkDir(root, full)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Stale-target-SHA detection (07_PACKET_CONTRACT.md / 06_SECURITY... "fail closed when: target
// SHA changes unexpectedly"). Shared by both the directory and ZIP post-extraction verifiers.
// ---------------------------------------------------------------------------

export interface VerifyOptions {
  /** Path to a live, real checkout of the target repository. Omit to skip staleness evaluation
   *  entirely (recorded as `skipped`, never silently absent from `checks[]`). */
  liveTargetPath?: string;
  /** A mismatched target SHA is `failed` by default (fail-closed). Set `true` only when a human
   *  has explicitly reviewed and accepted a stale packet — the acceptance is recorded verbatim in
   *  the check's `details` (`"STALE ACKNOWLEDGED: manifest=<sha> live=<sha>"`), never silent. */
  allowStale?: boolean;
}

/**
 * Resolves `HEAD` of a real, local git checkout at `targetPath` with a single arg-array
 * `spawnSync('git', ['rev-parse', 'HEAD'], ...)` call — deliberately NOT importing from
 * `inspection/` (this module must not depend on that layer; see
 * `.claude/specs/packet-compiler.md`'s module map). No shell, no untrusted string
 * interpolation — `targetPath` is only ever used as the `cwd` option, never concatenated into a
 * command string. Returns `null` (not a throw) if resolution fails for any reason, so a caller can
 * report `unavailable` rather than crash the whole verification run.
 */
const VERIFY_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
/** Same 30s cap as inspection/git.ts — a hung credential helper must not stall `packet verify`. */
const VERIFY_GIT_TIMEOUT_MS = 30_000;

function resolveLiveHeadSha(targetPath: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: targetPath,
    encoding: 'utf8',
    env: VERIFY_GIT_ENV,
    timeout: VERIFY_GIT_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

function isManifestFileEntry(value: unknown): value is { path: string; sha256: string } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('path' in value) || !('sha256' in value)) return false;
  return typeof value.path === 'string' && typeof value.sha256 === 'string';
}

function looseManifestFields(raw: unknown): { files: { path: string; sha256: string }[]; headSha?: string } {
  if (typeof raw !== 'object' || raw === null) return { files: [] };
  const files = 'files' in raw && Array.isArray(raw.files) ? raw.files.filter(isManifestFileEntry) : [];
  if (
    'target' in raw &&
    typeof raw.target === 'object' &&
    raw.target !== null &&
    'headSha' in raw.target &&
    typeof raw.target.headSha === 'string'
  ) {
    return { files, headSha: raw.target.headSha };
  }
  return { files };
}

/** JSON-parsed MANIFEST.json: schema result plus loose files/headSha so later checks can still
 *  diagnose a structurally invalid packet instead of returning after the schema failure alone. */
function inspectManifestJson(raw: unknown): {
  schemaError?: string;
  files: { path: string; sha256: string }[];
  headSha?: string;
} {
  const parsed = PacketManifestSchema.safeParse(raw);
  const loose = looseManifestFields(raw);
  if (parsed.success) {
    return { files: parsed.data.files, headSha: parsed.data.target.headSha };
  }
  return { schemaError: parsed.error.message, ...loose };
}

/** Adds the `stale-target-sha` check to `c`, per the four branches in the team lead's design (plus
 *  one defensive fifth: `liveTargetPath` given but git resolution itself fails, e.g. not a git
 *  checkout — reported `failed`, because the operator explicitly asked for a freshness gate). */
function addStaleTargetShaCheck(c: CheckCollector, manifestHeadSha: string, options: VerifyOptions): void {
  const description = 'manifest target SHA matches the live target repository HEAD';

  if (!options.liveTargetPath) {
    c.add('stale-target-sha', description, 'skipped', 'no live target supplied; staleness not evaluated');
    return;
  }

  const liveSha = resolveLiveHeadSha(options.liveTargetPath);
  if (liveSha === null) {
    c.add(
      'stale-target-sha',
      description,
      'failed',
      `could not resolve live HEAD at ${options.liveTargetPath}; freshness cannot be verified against the explicitly supplied live target (fail-closed)`,
    );
    return;
  }

  if (liveSha === manifestHeadSha) {
    c.add('stale-target-sha', description, 'passed');
    return;
  }

  if (options.allowStale) {
    c.add('stale-target-sha', description, 'passed', `STALE ACKNOWLEDGED: manifest=${manifestHeadSha} live=${liveSha}`);
    return;
  }

  c.add('stale-target-sha', description, 'failed', `manifest=${manifestHeadSha} live=${liveSha}`);
}

/**
 * Missing-`target.headSha` handling composes with the operator's intent FAIL-CLOSED: when the
 * operator explicitly asked for staleness enforcement (`--target` / `liveTargetPath`), a manifest
 * with no `target.headSha` must FAIL — otherwise a tampered/forged packet could omit the field
 * and route the check into `unavailable`, which does not flip `overall`, silently bypassing the
 * very gate the operator turned on (fresh re-review finding). Without `liveTargetPath` the field's
 * absence stays `unavailable`: harmless, and there is no gate to bypass.
 */
function addManifestHashCheck(
  c: CheckCollector,
  manifestFiles: readonly { path: string; sha256: string }[],
  checksumEntries: readonly ChecksumEntry[],
): void {
  const checksumByPath = new Map(checksumEntries.map((e) => [e.path, e.sha256]));
  const mismatches: string[] = [];
  for (const file of manifestFiles) {
    const checksumHash = checksumByPath.get(file.path);
    if (checksumHash === undefined) {
      mismatches.push(`${file.path}: in MANIFEST.json but not in CHECKSUMS.sha256`);
      continue;
    }
    if (checksumHash !== file.sha256) {
      mismatches.push(`${file.path}: MANIFEST.json sha256 does not match CHECKSUMS.sha256`);
    }
  }
  c.passIf(
    'manifest-hashes-match-checksums',
    "each MANIFEST.json files[].sha256 matches the corresponding CHECKSUMS.sha256 entry",
    mismatches.length === 0,
    mismatches.join('; '),
  );
}

function addStaleTargetShaOrMissingManifestSha(
  c: CheckCollector,
  manifestHeadSha: string | undefined,
  options: VerifyOptions,
): void {
  if (manifestHeadSha) {
    addStaleTargetShaCheck(c, manifestHeadSha, options);
    return;
  }
  const description = 'manifest target SHA matches the live target repository HEAD';
  if (options.liveTargetPath) {
    c.add(
      'stale-target-sha',
      description,
      'failed',
      'MANIFEST.json has no target.headSha; freshness cannot be verified against the explicitly supplied live target (fail-closed)',
    );
    return;
  }
  c.add('stale-target-sha', description, 'unavailable', 'MANIFEST.json has no target.headSha to compare against');
}

export async function verifyExtractedDirectory(dir: string, options: VerifyOptions = {}): Promise<ValidationResult> {
  const c = new CheckCollector();

  const manifestPath = path.join(dir, 'MANIFEST.json');
  const checksumsPath = path.join(dir, 'CHECKSUMS.sha256');

  let manifestFiles: { path: string; sha256: string }[] = [];
  let manifestTargetHeadSha: string | undefined;
  try {
    const manifestRaw = await readFile(manifestPath, 'utf8');
    const inspected = inspectManifestJson(JSON.parse(manifestRaw));
    manifestFiles = inspected.files;
    manifestTargetHeadSha = inspected.headSha;
    c.add('manifest-readable', 'MANIFEST.json is present and parses', 'passed');
    c.add(
      'manifest-schema',
      'MANIFEST.json satisfies PacketManifestSchema',
      inspected.schemaError === undefined ? 'passed' : 'failed',
      inspected.schemaError,
    );
  } catch (e) {
    c.add('manifest-readable', 'MANIFEST.json is present and parses', 'failed', e instanceof Error ? e.message : String(e));
    return c.toResult();
  }

  addStaleTargetShaOrMissingManifestSha(c, manifestTargetHeadSha, options);

  let checksumEntries: ChecksumEntry[] = [];
  try {
    const checksumsRaw = await readFile(checksumsPath, 'utf8');
    checksumEntries = parseChecksumsFile(checksumsRaw);
    c.add('checksums-readable', 'CHECKSUMS.sha256 is present and parses', 'passed');
  } catch (e) {
    c.add('checksums-readable', 'CHECKSUMS.sha256 is present and parses', 'failed', e instanceof Error ? e.message : String(e));
    return c.toResult();
  }

  // Symlink rejection (dir input: lstat every entry).
  const symlinkHits: string[] = [];
  const walkForSymlinks = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        symlinkHits.push(path.relative(dir, full).split(path.sep).join('/'));
        continue;
      }
      if (entry.isDirectory()) await walkForSymlinks(full);
    }
  };
  await walkForSymlinks(dir);
  c.passIf('no-symlinks', 'no symlink entries anywhere in the extracted packet', symlinkHits.length === 0, symlinkHits.join(', '));

  const actualFiles = (await walkDir(dir)).sort();
  // CHECKSUMS.sha256 cannot list its own hash, so it never appears in its own entry list —
  // compare everything else.
  const actualFilesMinusChecksums = actualFiles.filter((f) => f !== 'CHECKSUMS.sha256');
  const expectedFromChecksums = [...checksumEntries.map((e) => e.path)].sort();
  c.passIf(
    'file-set-matches-checksums',
    'the extracted file set (minus CHECKSUMS.sha256 itself) matches CHECKSUMS.sha256 exactly',
    JSON.stringify(actualFilesMinusChecksums) === JSON.stringify(expectedFromChecksums),
    `actual=${actualFilesMinusChecksums.length} expected=${expectedFromChecksums.length}`,
  );

  const expectedFromManifest = new Set([...manifestFiles.map((f) => f.path), 'MANIFEST.json']);
  const dupCheck = new Set(actualFiles);
  c.passIf(
    'manifest-file-list-matches',
    "MANIFEST.json's files[] (plus itself) matches the extracted file set minus CHECKSUMS.sha256",
    actualFiles.filter((f) => f !== 'CHECKSUMS.sha256').every((f) => expectedFromManifest.has(f)) &&
      [...expectedFromManifest].every((f) => f === 'MANIFEST.json' || dupCheck.has(f)),
    '',
  );

  addManifestHashCheck(c, manifestFiles, checksumEntries);

  // Recompute checksums.
  const mismatches: string[] = [];
  for (const entry of checksumEntries) {
    const full = path.join(dir, entry.path);
    if (!checkPathContainment(entry.path)) {
      mismatches.push(`${entry.path}: escapes packet root`);
      continue;
    }
    try {
      const content = await readFile(full);
      const actual = sha256Hex(content);
      if (actual !== entry.sha256) mismatches.push(`${entry.path}: checksum mismatch`);
    } catch (e) {
      mismatches.push(`${entry.path}: unreadable (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  c.passIf('checksums-recompute', 'every file in CHECKSUMS.sha256 recomputes to the recorded hash', mismatches.length === 0, mismatches.join('; '));

  return c.toResult();
}

// ---------------------------------------------------------------------------
// Post-extraction verification (ZIP input)
// ---------------------------------------------------------------------------

export async function verifyZipPacket(zipPath: string, options: VerifyOptions = {}): Promise<ValidationResult> {
  const c = new CheckCollector();

  let entries;
  try {
    entries = await readZipEntries(zipPath, MAX_TOTAL_INFLATED_BYTES);
    c.add('zip-readable', 'zip opens and every entry inflates within the size bound', 'passed');
  } catch (e) {
    c.add('zip-readable', 'zip opens and every entry inflates within the size bound', 'failed', e instanceof Error ? e.message : String(e));
    return c.toResult();
  }

  const traversalHits = entries.filter((e) => !checkPathContainment(e.entryPath)).map((e) => e.entryPath);
  c.passIf('no-path-traversal', 'no entry path escapes the packet root (no "..", no absolute path)', traversalHits.length === 0, traversalHits.join(', '));

  const symlinkHits = entries.filter((e) => isSymlinkExternalAttributes(e.externalFileAttributes)).map((e) => e.entryPath);
  c.passIf('no-symlinks', 'no symlink entries (external file attributes)', symlinkHits.length === 0, symlinkHits.join(', '));

  const nameCounts = new Map<string, number>();
  for (const e of entries) nameCounts.set(e.entryPath, (nameCounts.get(e.entryPath) ?? 0) + 1);
  const dupNames = [...nameCounts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  c.passIf('no-duplicate-entries', 'no duplicate entry names', dupNames.length === 0, dupNames.join(', '));

  const manifestEntry = entries.find((e) => e.entryPath === 'MANIFEST.json');
  const checksumsEntry = entries.find((e) => e.entryPath === 'CHECKSUMS.sha256');
  if (!manifestEntry || !checksumsEntry) {
    c.add('manifest-and-checksums-present', 'MANIFEST.json and CHECKSUMS.sha256 are both present', 'failed', 'one or both missing');
    return c.toResult();
  }
  c.add('manifest-and-checksums-present', 'MANIFEST.json and CHECKSUMS.sha256 are both present', 'passed');

  let manifestFiles: { path: string; sha256: string }[] = [];
  let manifestTargetHeadSha: string | undefined;
  try {
    const inspected = inspectManifestJson(JSON.parse(manifestEntry.content.toString('utf8')));
    manifestFiles = inspected.files;
    manifestTargetHeadSha = inspected.headSha;
    c.add('manifest-readable', 'MANIFEST.json parses', 'passed');
    c.add(
      'manifest-schema',
      'MANIFEST.json satisfies PacketManifestSchema',
      inspected.schemaError === undefined ? 'passed' : 'failed',
      inspected.schemaError,
    );
  } catch (e) {
    c.add('manifest-readable', 'MANIFEST.json parses', 'failed', e instanceof Error ? e.message : String(e));
    return c.toResult();
  }

  addStaleTargetShaOrMissingManifestSha(c, manifestTargetHeadSha, options);

  let checksumEntries: ChecksumEntry[] = [];
  try {
    checksumEntries = parseChecksumsFile(checksumsEntry.content.toString('utf8'));
    c.add('checksums-readable', 'CHECKSUMS.sha256 parses', 'passed');
  } catch (e) {
    c.add('checksums-readable', 'CHECKSUMS.sha256 parses', 'failed', e instanceof Error ? e.message : String(e));
    return c.toResult();
  }

  const actualFiles = entries.map((e) => e.entryPath).sort();
  // CHECKSUMS.sha256 cannot list its own hash, so it never appears in its own entry list —
  // compare everything else.
  const actualFilesMinusChecksums = actualFiles.filter((f) => f !== 'CHECKSUMS.sha256');
  const expectedFromChecksums = [...checksumEntries.map((e) => e.path)].sort();
  c.passIf(
    'file-set-matches-checksums',
    'the archive file set (minus CHECKSUMS.sha256 itself) matches CHECKSUMS.sha256 exactly',
    JSON.stringify(actualFilesMinusChecksums) === JSON.stringify(expectedFromChecksums),
    `actual=${actualFilesMinusChecksums.length} expected=${expectedFromChecksums.length}`,
  );

  const expectedFromManifest = new Set([...manifestFiles.map((f) => f.path), 'MANIFEST.json']);
  const actualSet = new Set(actualFiles);
  c.passIf(
    'manifest-file-list-matches',
    "MANIFEST.json's files[] (plus itself) matches the archive file set minus CHECKSUMS.sha256",
    actualFiles.filter((f) => f !== 'CHECKSUMS.sha256').every((f) => expectedFromManifest.has(f)) &&
      [...expectedFromManifest].every((f) => f === 'MANIFEST.json' || actualSet.has(f)),
    '',
  );

  addManifestHashCheck(c, manifestFiles, checksumEntries);

  const mismatches: string[] = [];
  const byPath = new Map(entries.map((e) => [e.entryPath, e]));
  for (const entry of checksumEntries) {
    const found = byPath.get(entry.path);
    if (!found) {
      mismatches.push(`${entry.path}: not in archive`);
      continue;
    }
    const actual = sha256Hex(found.content);
    if (actual !== entry.sha256) mismatches.push(`${entry.path}: checksum mismatch`);
  }
  c.passIf('checksums-recompute', 'every file in CHECKSUMS.sha256 recomputes to the recorded hash', mismatches.length === 0, mismatches.join('; '));

  return c.toResult();
}

// ---------------------------------------------------------------------------
// Entry point used by `packet verify` (dir or zip)
// ---------------------------------------------------------------------------

export async function verifyPacketPath(packetPath: string, options: VerifyOptions = {}): Promise<ValidationResult> {
  const info = await stat(packetPath).catch(() => null);
  if (!info) {
    const c = new CheckCollector();
    c.add('path-exists', 'packetPath exists', 'failed', `not found: ${packetPath}`);
    return c.toResult();
  }
  if (info.isDirectory()) return verifyExtractedDirectory(packetPath, options);
  return verifyZipPacket(packetPath, options);
}

/** Convenience for a caller that wants to know whether `entryPath` (already known to be a real
 *  file, e.g. inside a freshly-materialized directory) is itself a symlink — used by tests that
 *  build adversarial directory fixtures without going through a full compile. */
export async function isPathSymlink(fullPath: string): Promise<boolean> {
  const info = await lstat(fullPath).catch(() => null);
  return info?.isSymbolicLink() ?? false;
}
