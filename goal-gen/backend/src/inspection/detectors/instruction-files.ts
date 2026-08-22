/**
 * Detects instruction/governance files (CLAUDE.md, AGENTS.md, CONTRIBUTING, SECURITY, README,
 * ADRs/decisions, specs/plans) among tracked paths. Reads their content only through
 * `readTrackedPublicFile` (lstat + realpath containment; never follows a tracked symlink; never
 * opens a protected-path match). Bounded excerpts are recorded as public evidence; protected
 * matches are metadata-only.
 */
import type { EvidenceStore } from '../../evidence/store';
import { lsFiles } from '../git';
import type { CompiledProtectedPathPolicy } from '../policy';
import { readTrackedPublicFile } from '../safe-tracked-read';

/** Repository content is untrusted; never let one file balloon an evidence record. */
const EXCERPT_CHAR_CAP = 4000;

const ROOT_BASENAME_RE = /^(CLAUDE|AGENTS|CONTRIBUTING|SECURITY|README)(\.[A-Za-z0-9]+)?$/i;
const ADR_OR_SPEC_PATH_RE = /(^|\/)(adr|adrs|decisions|specs?|plans?)(\/|$)/i;

function isInstructionFile(relPath: string): boolean {
  const basename = relPath.split('/').pop() ?? relPath;
  const depth = relPath.split('/').length;
  if (depth === 1 && ROOT_BASENAME_RE.test(basename)) return true;
  if (relPath.endsWith('.md') && ADR_OR_SPEC_PATH_RE.test(relPath)) return true;
  return false;
}

export interface InstructionFilesResult {
  paths: string[];
  evidenceRefs: string[];
}

export async function detectInstructionFiles(
  localDir: string,
  evidence: EvidenceStore,
  policy?: CompiledProtectedPathPolicy,
): Promise<InstructionFilesResult> {
  const files = lsFiles(localDir);
  const matches = files.filter(isInstructionFile).sort();
  const evidenceRefs: string[] = [];

  for (const relPath of matches) {
    const read = await readTrackedPublicFile(localDir, relPath, policy);
    if (read.status === 'ok') {
      const excerpt = read.content.length > EXCERPT_CHAR_CAP ? read.content.slice(0, EXCERPT_CHAR_CAP) : read.content;
      const record = evidence.add({
        sourceType: 'repository-file',
        path: relPath,
        sensitivity: 'public',
        facts: [`instruction file present at ${relPath}`, `length=${read.content.length}`],
        excerpt,
      });
      evidenceRefs.push(record.id);
      continue;
    }
    if (read.reason === 'unreadable') continue;
    const record = evidence.add({
      sourceType: read.reason === 'protected' ? 'git-metadata' : 'repository-file',
      path: relPath,
      sensitivity: read.reason === 'protected' ? 'protected-metadata' : 'public',
      facts: [`instruction file present at ${relPath}`, `content not read: ${read.reason}`],
    });
    evidenceRefs.push(record.id);
  }

  return { paths: matches, evidenceRefs };
}
