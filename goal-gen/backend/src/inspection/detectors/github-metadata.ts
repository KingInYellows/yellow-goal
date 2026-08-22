/**
 * Wraps `GhClient` PR/issue/milestone/release listings into RepoProfile-shaped facts, each backed
 * by a `github-api` evidence record. A no-op (empty arrays) when no `ghClient`/`ghRepository` is
 * available — these are all optional fields on RepoProfile.
 */
import type { EvidenceStore } from '../../evidence/store';
import type { GhClient } from '../../providers/gh-client';

export interface GithubMetadataResult {
  openPullRequests: Record<string, unknown>[];
  issues: Record<string, unknown>[];
  releaseSignals: Record<string, unknown>[];
  evidenceRefs: string[];
}

export interface GithubMetadataDeps {
  ghClient?: GhClient;
  ghRepository?: string;
}

export async function detectGithubMetadata(evidence: EvidenceStore, deps: GithubMetadataDeps): Promise<GithubMetadataResult> {
  if (!deps.ghClient || !deps.ghRepository) {
    return { openPullRequests: [], issues: [], releaseSignals: [], evidenceRefs: [] };
  }
  const { ghClient, ghRepository } = deps;
  const evidenceRefs: string[] = [];

  const [prList, issueList, releaseList, milestoneList] = await Promise.all([
    ghClient.prList(ghRepository),
    ghClient.issueList(ghRepository),
    ghClient.releaseList(ghRepository),
    ghClient.milestoneList(ghRepository),
  ]);

  const openPullRequests = prList
    .filter((pr) => pr.state === 'OPEN')
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      author: pr.author.login,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
    }));
  if (prList.length > 0) {
    const record = evidence.add({
      sourceType: 'github-api',
      repository: ghRepository,
      sensitivity: 'public',
      facts: prList.map((pr) => `PR #${pr.number} "${pr.title}" state=${pr.state} mergeable=${pr.mergeable} mergeStateStatus=${pr.mergeStateStatus}`),
    });
    evidenceRefs.push(record.id);
  }

  const issues = issueList.map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.author.login,
    labels: issue.labels.map((l) => l.name),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }));
  if (issueList.length > 0) {
    const record = evidence.add({
      sourceType: 'github-api',
      repository: ghRepository,
      sensitivity: 'public',
      facts: issueList.map((i) => `issue #${i.number} "${i.title}" state=${i.state}`),
    });
    evidenceRefs.push(record.id);
  }

  const releaseSignals: Record<string, unknown>[] = [
    ...releaseList.map((r) => ({ kind: 'release', tagName: r.tagName, name: r.name, isDraft: r.isDraft, isPrerelease: r.isPrerelease, publishedAt: r.publishedAt })),
    ...milestoneList.map((m) => ({ kind: 'milestone', number: m.number, title: m.title, state: m.state, dueOn: m.dueOn })),
  ];
  if (releaseSignals.length > 0) {
    const record = evidence.add({
      sourceType: 'github-api',
      repository: ghRepository,
      sensitivity: 'public',
      facts: [
        ...releaseList.map((r) => `release ${r.tagName} prerelease=${r.isPrerelease} draft=${r.isDraft}`),
        ...milestoneList.map((m) => `milestone #${m.number} "${m.title}" state=${m.state}`),
      ],
    });
    evidenceRefs.push(record.id);
  }

  return { openPullRequests, issues, releaseSignals, evidenceRefs };
}
