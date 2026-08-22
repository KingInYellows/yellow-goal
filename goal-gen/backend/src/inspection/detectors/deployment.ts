/**
 * Detects deployment and migration material — path-pattern matching only, facts recorded as
 * evidence for downstream analysis. Never inspects file content (deployment manifests are ordinary
 * tracked files, not protected, but this detector doesn't need their content to record presence).
 */
import type { EvidenceStore } from '../../evidence/store';
import { lsFiles } from '../git';

const DEPLOYMENT_PATH_RE =
  /(^|\/)(Dockerfile|docker-compose\.ya?ml|\.dockerignore)$|(^|\/)k8s\/|(^|\/)kubernetes\/|(^|\/)helm\/|(^|\/)terraform\/|main\.tf$|(^|\/)ansible\/|playbook\.ya?ml$|(^|\/)migrations?\//i;

export interface DeploymentResult {
  paths: string[];
  evidenceRefs: string[];
}

export function detectDeploymentMaterial(localDir: string, evidence: EvidenceStore): DeploymentResult {
  const files = lsFiles(localDir);
  const matches = files.filter((p) => DEPLOYMENT_PATH_RE.test(p)).sort();
  if (matches.length === 0) return { paths: [], evidenceRefs: [] };
  const record = evidence.add({
    sourceType: 'git-metadata',
    sensitivity: 'public',
    facts: [`deployment/migration material present: ${matches.length} path(s)`, ...matches.map((p) => `path: ${p}`)],
  });
  return { paths: matches, evidenceRefs: [record.id] };
}
