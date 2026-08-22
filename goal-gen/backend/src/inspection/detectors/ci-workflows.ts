/**
 * CI workflow detection: parses `.github/workflows/*.yml` for jobs that are unconditionally
 * skipped (`if: false`) or allowed to fail (`continue-on-error: true`) — a green run summary is
 * not sufficient evidence when a required job was skipped or allowed-failure (05_REPOSITORY_
 * INSPECTION_AND_RESEARCH.md). Optionally correlates with live-run conclusions via `GhClient`
 * (skipped/cancelled/allowed-failure at the *run* level) when a gh repository identifier is
 * available — this works for `local-git` targets too, pairing a local fixture tree with recorded
 * gh responses about "the same" logical repository (see the `conflicting-pr-metadata` fixture).
 */
import yaml from 'js-yaml';
import type { EvidenceStore } from '../../evidence/store';
import type { GhClient } from '../../providers/gh-client';
import { lsFiles } from '../git';
import type { CompiledProtectedPathPolicy } from '../policy';
import { readTrackedPublicFile } from '../safe-tracked-read';

interface WorkflowJobRaw {
  if?: unknown;
  'continue-on-error'?: unknown;
}
interface WorkflowDocRaw {
  jobs?: Record<string, WorkflowJobRaw>;
}

export interface CiWorkflowsResult {
  /** Loose facts for RepoProfile.ciWorkflows (schema: array of untyped records). */
  ciWorkflows: Record<string, unknown>[];
  evidenceRefs: string[];
}

const WORKFLOW_MAX_BOUND_CHARS = 4000;

async function detectFromWorkflowFiles(
  localDir: string,
  evidence: EvidenceStore,
  policy?: CompiledProtectedPathPolicy,
): Promise<CiWorkflowsResult> {
  const files = lsFiles(localDir).filter((p) => /^\.github\/workflows\/.*\.ya?ml$/.test(p)).sort();
  const ciWorkflows: Record<string, unknown>[] = [];
  const evidenceRefs: string[] = [];

  for (const relPath of files) {
    const read = await readTrackedPublicFile(localDir, relPath, policy);
    if (read.status !== 'ok') {
      if (read.reason === 'unreadable') continue;
      const record = evidence.add({
        sourceType: read.reason === 'protected' ? 'git-metadata' : 'repository-file',
        path: relPath,
        sensitivity: read.reason === 'protected' ? 'protected-metadata' : 'public',
        facts: [`workflow file present at ${relPath}`, `content not read: ${read.reason}`],
      });
      evidenceRefs.push(record.id);
      ciWorkflows.push({ kind: 'workflow-file', path: relPath, skipped: read.reason });
      continue;
    }
    const content = read.content;
    let doc: WorkflowDocRaw;
    try {
      doc = (yaml.load(content) as WorkflowDocRaw) ?? {};
    } catch {
      continue;
    }
    const jobs = Object.entries(doc.jobs ?? {}).map(([name, job]) => ({
      name,
      alwaysSkipped: job.if === false,
      allowedFailure: job['continue-on-error'] === true,
    }));
    const skipped = jobs.filter((j) => j.alwaysSkipped).map((j) => j.name);
    const allowedFailure = jobs.filter((j) => j.allowedFailure).map((j) => j.name);
    const record = evidence.add({
      sourceType: 'repository-file',
      path: relPath,
      sensitivity: 'public',
      facts: [
        `workflow declares ${jobs.length} job(s)`,
        `always-skipped jobs: ${skipped.length > 0 ? skipped.join(', ') : 'none'}`,
        `allowed-failure jobs: ${allowedFailure.length > 0 ? allowedFailure.join(', ') : 'none'}`,
      ],
      excerpt: content.length > WORKFLOW_MAX_BOUND_CHARS ? content.slice(0, WORKFLOW_MAX_BOUND_CHARS) : content,
    });
    evidenceRefs.push(record.id);
    ciWorkflows.push({ kind: 'workflow-file', path: relPath, jobs });
  }

  return { ciWorkflows, evidenceRefs };
}

export interface CiWorkflowsDeps {
  ghClient?: GhClient;
  ghRepository?: string;
  /** Bounds how many recent runs get a job-level detail fetch (each is a separate gh call). */
  maxRunsToDetail?: number;
  policy?: CompiledProtectedPathPolicy;
}

async function detectFromGhRuns(evidence: EvidenceStore, deps: CiWorkflowsDeps): Promise<CiWorkflowsResult> {
  if (!deps.ghClient || !deps.ghRepository) return { ciWorkflows: [], evidenceRefs: [] };
  const runs = await deps.ghClient.ciRuns(deps.ghRepository);
  if (runs.length === 0) return { ciWorkflows: [], evidenceRefs: [] };

  const maxDetail = deps.maxRunsToDetail ?? 10;
  const ciWorkflows: Record<string, unknown>[] = [];
  const facts = runs.map((r) => `run ${r.databaseId} on ${r.headBranch}: status=${r.status} conclusion=${r.conclusion ?? 'null'}`);

  for (const run of runs.slice(0, maxDetail)) {
    const jobDetail = await deps.ghClient.ciRunJobs(deps.ghRepository, run.databaseId);
    ciWorkflows.push({
      kind: 'ci-run',
      databaseId: run.databaseId,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      headBranch: run.headBranch,
      headSha: run.headSha,
      event: run.event,
      jobs: jobDetail?.jobs.map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion })) ?? null,
    });
  }

  const record = evidence.add({
    sourceType: 'github-api',
    repository: deps.ghRepository,
    sensitivity: 'public',
    facts,
  });
  return { ciWorkflows, evidenceRefs: [record.id] };
}

export async function detectCiWorkflows(
  localDir: string | null,
  evidence: EvidenceStore,
  deps: CiWorkflowsDeps = {},
): Promise<CiWorkflowsResult> {
  const fromFiles = localDir ? await detectFromWorkflowFiles(localDir, evidence, deps.policy) : { ciWorkflows: [], evidenceRefs: [] };
  const fromGh = await detectFromGhRuns(evidence, deps);
  return {
    ciWorkflows: [...fromFiles.ciWorkflows, ...fromGh.ciWorkflows],
    evidenceRefs: [...fromFiles.evidenceRefs, ...fromGh.evidenceRefs],
  };
}
