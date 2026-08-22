/**
 * `GhClient` — the interface every GitHub-hosted-target detector depends on for PR/issue/CI/
 * release/milestone metadata (repository-tree facts come from `inspection/git.ts` against a local
 * checkout instead; see `inspection/resolver.ts`'s file-top comment for why a bare `OWNER/REPO`
 * target has no local tree to read).
 *
 * Two implementations:
 * - `RecordedGhClient` — reads from an in-memory fixture bundle (built from
 *   `tests/fixtures/github-responses/*.json`). The ONLY implementation ever used in tests.
 * - `LiveGhClient` — shells `gh` via argument arrays (never `shell: true`), bounded output,
 *   timeout. Not exercised by any test in this suite (06_SECURITY: "no live network... in tests").
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';

export interface GhAuthor {
  login: string;
  id: string;
  is_bot: boolean;
  name: string;
}

export interface GhRepoView {
  name: string;
  owner: { id: string; login: string };
  defaultBranchRef: { name: string } | null;
  description?: string;
  isPrivate: boolean;
  pushedAt: string;
  url: string;
}

export interface GhPullRequest {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  author: GhAuthor;
  createdAt: string;
  updatedAt: string;
}

export interface GhIssue {
  number: number;
  title: string;
  state: string;
  author: GhAuthor;
  createdAt: string;
  updatedAt: string;
  labels: { id: string; name: string; color: string; description: string }[];
}

export interface GhCiRun {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  headBranch: string;
  headSha: string;
  event: string;
  createdAt: string;
  updatedAt: string;
}

export interface GhCiJobStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
}

export interface GhCiJob {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: GhCiJobStep[];
}

export interface GhCiRunJobs {
  databaseId: number;
  jobs: GhCiJob[];
}

export interface GhRelease {
  tagName: string;
  name: string;
  isDraft: boolean;
  isPrerelease: boolean;
  publishedAt: string;
}

export interface GhMilestone {
  number: number;
  title: string;
  state: string;
  dueOn: string | null;
  description?: string;
}

export interface GhClient {
  repoView(repo: string): Promise<GhRepoView | null>;
  /** Resolves a ref (branch/tag/sha-ish) to its exact commit SHA. Null if unresolved. */
  resolveRefSha(repo: string, ref: string): Promise<string | null>;
  prList(repo: string): Promise<GhPullRequest[]>;
  issueList(repo: string): Promise<GhIssue[]>;
  ciRuns(repo: string): Promise<GhCiRun[]>;
  ciRunJobs(repo: string, runId: number): Promise<GhCiRunJobs | null>;
  releaseList(repo: string): Promise<GhRelease[]>;
  milestoneList(repo: string): Promise<GhMilestone[]>;
}

// ---------------------------------------------------------------------------------------------
// RecordedGhClient — the only implementation used in tests
// ---------------------------------------------------------------------------------------------

export interface GhFixtureBundle {
  repoView?: GhRepoView | null;
  /** ref -> resolved SHA. */
  refShas?: Record<string, string>;
  prList?: GhPullRequest[];
  issueList?: GhIssue[];
  ciRuns?: GhCiRun[];
  /** run databaseId -> job detail. */
  ciRunJobs?: Record<number, GhCiRunJobs>;
  releaseList?: GhRelease[];
  milestoneList?: GhMilestone[];
}

export class RecordedGhClient implements GhClient {
  constructor(private readonly bundle: GhFixtureBundle) {}

  async repoView(): Promise<GhRepoView | null> {
    return this.bundle.repoView ?? null;
  }
  async resolveRefSha(_repo: string, ref: string): Promise<string | null> {
    return this.bundle.refShas?.[ref] ?? null;
  }
  async prList(): Promise<GhPullRequest[]> {
    return this.bundle.prList ?? [];
  }
  async issueList(): Promise<GhIssue[]> {
    return this.bundle.issueList ?? [];
  }
  async ciRuns(): Promise<GhCiRun[]> {
    return this.bundle.ciRuns ?? [];
  }
  async ciRunJobs(_repo: string, runId: number): Promise<GhCiRunJobs | null> {
    return this.bundle.ciRunJobs?.[runId] ?? null;
  }
  async releaseList(): Promise<GhRelease[]> {
    return this.bundle.releaseList ?? [];
  }
  async milestoneList(): Promise<GhMilestone[]> {
    return this.bundle.milestoneList ?? [];
  }
}

// ---------------------------------------------------------------------------------------------
// LiveGhClient — NEVER instantiated by any test; live network + `gh` binary required
// ---------------------------------------------------------------------------------------------

const GH_ENV: NodeJS.ProcessEnv = { ...process.env };
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function runGh(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  let r: SpawnSyncReturns<string>;
  try {
    r = spawnSync('gh', args, { env: GH_ENV, encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER_BYTES });
  } catch (e) {
    return { status: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
  const stderr = r.error ? `${r.stderr ?? ''}${r.error.message}`.trim() : (r.stderr ?? '');
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr };
}

function parseJsonOrNull<T>(stdout: string): T | null {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

/** Live `gh` CLI implementation. Not covered by this test suite by design. */
export class LiveGhClient implements GhClient {
  async repoView(repo: string): Promise<GhRepoView | null> {
    const r = runGh(['repo', 'view', repo, '--json', 'name,owner,defaultBranchRef,description,isPrivate,pushedAt,url']);
    if (r.status !== 0) return null;
    return parseJsonOrNull<GhRepoView>(r.stdout);
  }

  async resolveRefSha(repo: string, ref: string): Promise<string | null> {
    const r = runGh(['api', `repos/${repo}/commits/${ref}`, '--jq', '.sha']);
    if (r.status !== 0) return null;
    const sha = r.stdout.trim();
    return sha.length >= 7 ? sha : null;
  }

  async prList(repo: string): Promise<GhPullRequest[]> {
    const r = runGh([
      'pr', 'list', '--repo', repo, '--state', 'all',
      '--json', 'number,title,headRefName,baseRefName,state,mergeable,mergeStateStatus,isDraft,author,createdAt,updatedAt',
    ]);
    if (r.status !== 0) return [];
    return parseJsonOrNull<GhPullRequest[]>(r.stdout) ?? [];
  }

  async issueList(repo: string): Promise<GhIssue[]> {
    const r = runGh([
      'issue', 'list', '--repo', repo, '--state', 'all',
      '--json', 'number,title,state,author,createdAt,updatedAt,labels',
    ]);
    if (r.status !== 0) return [];
    return parseJsonOrNull<GhIssue[]>(r.stdout) ?? [];
  }

  async ciRuns(repo: string): Promise<GhCiRun[]> {
    const r = runGh([
      'run', 'list', '--repo', repo,
      '--json', 'databaseId,name,status,conclusion,headBranch,headSha,event,createdAt,updatedAt',
    ]);
    if (r.status !== 0) return [];
    return parseJsonOrNull<GhCiRun[]>(r.stdout) ?? [];
  }

  async ciRunJobs(repo: string, runId: number): Promise<GhCiRunJobs | null> {
    const r = runGh(['run', 'view', String(runId), '--repo', repo, '--json', 'databaseId,jobs']);
    if (r.status !== 0) return null;
    return parseJsonOrNull<GhCiRunJobs>(r.stdout);
  }

  async releaseList(repo: string): Promise<GhRelease[]> {
    const r = runGh(['release', 'list', '--repo', repo, '--json', 'tagName,name,isDraft,isPrerelease,publishedAt']);
    if (r.status !== 0) return [];
    return parseJsonOrNull<GhRelease[]>(r.stdout) ?? [];
  }

  async milestoneList(repo: string): Promise<GhMilestone[]> {
    const r = runGh(['api', `repos/${repo}/milestones`, '--jq', '[.[] | {number, title, state, dueOn: .due_on, description}]']);
    if (r.status !== 0) return [];
    return parseJsonOrNull<GhMilestone[]>(r.stdout) ?? [];
  }
}
