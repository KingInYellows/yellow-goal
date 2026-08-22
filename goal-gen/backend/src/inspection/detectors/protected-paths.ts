/**
 * Protected-path metadata detector. STRUCTURALLY never reads file content: it only calls
 * `lsTree` (path/type/hash/size) from `inspection/git.ts`, which has no content-read export at
 * all — there is nothing this file could call to open a protected file's contents even by
 * accident. Evidence records for a protected match carry `facts` (path, size, hash) and
 * `sensitivity: 'protected-metadata'`, and deliberately omit `excerpt`.
 */
import type { EvidenceStore } from '../../evidence/store';
import { lsTree } from '../git';
import type { CompiledProtectedPathPolicy } from '../policy';

export interface ProtectedPathsResult {
  paths: string[];
  evidenceRefs: string[];
}

export function detectProtectedPaths(
  localDir: string,
  policy: CompiledProtectedPathPolicy,
  evidence: EvidenceStore,
): ProtectedPathsResult {
  const entries = lsTree(localDir, 'HEAD').filter((e) => e.type === 'blob');
  const paths: string[] = [];
  const evidenceRefs: string[] = [];

  for (const entry of entries) {
    if (!policy.isProtected(entry.path)) continue;
    paths.push(entry.path);
    const record = evidence.add({
      sourceType: 'git-metadata',
      path: entry.path,
      sensitivity: 'protected-metadata',
      facts: [`path=${entry.path}`, `size=${entry.size ?? 'unknown'}`, `hash=${entry.hash}`],
    });
    evidenceRefs.push(record.id);
  }

  return { paths: paths.sort(), evidenceRefs };
}
