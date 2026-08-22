/**
 * Detects the presence (or absence) of a test/fixture/eval surface — file-path pattern matching
 * only, no execution. Absence is itself a fact worth recording (feeds `missing_evidence` findings
 * downstream in analysis).
 */
import type { EvidenceStore } from '../../evidence/store';
import { lsFiles } from '../git';

const TEST_PATH_RE = /(^|\/)(tests?|specs?|__tests__|evals?)(\/|$)|\.(test|spec)\.[A-Za-z0-9]+$|_test\.[A-Za-z0-9]+$/i;

export interface TestsSurfaceResult {
  hasTests: boolean;
  testPaths: string[];
  evidenceRefs: string[];
}

export function detectTestsSurface(localDir: string, evidence: EvidenceStore): TestsSurfaceResult {
  const files = lsFiles(localDir);
  const testPaths = files.filter((p) => TEST_PATH_RE.test(p)).sort();
  const record = evidence.add({
    sourceType: 'git-metadata',
    sensitivity: 'public',
    facts: [
      `hasTests=${testPaths.length > 0}`,
      `testFileCount=${testPaths.length}`,
      ...testPaths.slice(0, 50).map((p) => `test path: ${p}`),
    ],
  });
  return { hasTests: testPaths.length > 0, testPaths, evidenceRefs: [record.id] };
}
