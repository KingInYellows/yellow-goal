/**
 * End-to-end test for the `github` provider path through inspectRepository — the ONE scenario
 * not covered by any other test file, all of which use `local-git` fixtures. Assembles a
 * RecordedGhClient from every recorded gh-response fixture and asserts: partial-read access with
 * toolLimitations recorded, all file-tree-dependent RepoProfile fields empty (there is no local
 * checkout), and PR/issue/CI-run(including a skipped run)/release/milestone facts all populated.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectRepository } from '../../backend/src/inspection';
import { RepoProfileSchema } from '../../backend/src/contracts';
import { RecordedGhClient } from '../../backend/src/providers/gh-client';
import type {
  GhCiRun,
  GhCiRunJobs,
  GhIssue,
  GhMilestone,
  GhPullRequest,
  GhRelease,
  GhRepoView,
} from '../../backend/src/providers/gh-client';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const FIXED_CLOCK = () => new Date('2024-06-01T00:00:00.000Z');
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github-responses');

async function readJsonFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES_DIR, name), 'utf8')) as T;
}

describe('inspection/index inspectRepository — github provider path', () => {
  it('produces a partial-read, gh-sourced-only RepoProfile with all seven recorded fixtures wired in', async () => {
    const [repoView, prList, issueList, releaseList, milestoneList, ciRuns, ciRunJobs] = await Promise.all([
      readJsonFixture<GhRepoView>('repo-view.json'),
      readJsonFixture<GhPullRequest[]>('pr-list.json'),
      readJsonFixture<GhIssue[]>('issue-list.json'),
      readJsonFixture<GhRelease[]>('release-list.json'),
      readJsonFixture<GhMilestone[]>('milestone-list.json'),
      readJsonFixture<GhCiRun[]>('ci-runs.json'),
      readJsonFixture<GhCiRunJobs>('ci-run-jobs.json'),
    ]);
    const refShas = await readJsonFixture<Record<string, string>>('commit-sha.json');

    const ghClient = new RecordedGhClient({
      repoView,
      refShas,
      prList,
      issueList,
      releaseList,
      milestoneList,
      ciRuns,
      ciRunJobs: { [ciRunJobs.databaseId]: ciRunJobs },
    });

    const workDir = await mkdtemp(join(tmpdir(), 'goal-gen-github-provider-'));
    try {
      const requestPath = join(workDir, 'request.json');
      await writeFile(
        requestPath,
        JSON.stringify({
          schemaVersion: 'yellow-goal/request/v1',
          requestId: 'req-github-provider-1',
          target: { repository: 'fixture-owner/fixture-repo' },
          intent: { goal: 'Inspect a github-hosted target with no local checkout.' },
          mode: 'review-only',
        }),
        'utf8',
      );

      const result = await inspectRepository(
        { requestPath, outputDir: join(workDir, 'out') },
        { clock: FIXED_CLOCK, ghClient },
      );

      const target = JSON.parse(await readFile(result.resolvedTargetPath as string, 'utf8'));
      expect(target.provider).toBe('github');
      expect(target.accessLevel).toBe('partial-read');
      expect(target.toolLimitations.length).toBeGreaterThan(0);
      expect(target.sha).toBe(refShas.main);

      const profileRaw = JSON.parse(await readFile(result.repoProfilePath, 'utf8'));
      const profile = RepoProfileSchema.parse(profileRaw);

      // No local checkout -> every file-tree-dependent field is empty, never guessed.
      expect(profile.repositoryKinds).toEqual([]);
      expect(profile.instructionFiles).toEqual([]);
      expect(profile.manifests).toEqual([]);
      expect(profile.commands).toEqual([]);
      expect(profile.protectedPaths).toEqual([]);

      // gh-sourced facts ARE populated. RepoProfile types these as loose Record<string,unknown>[]
      // (the vendored schema imposes no inner shape), so narrow with an explicit cast for assertions.
      interface ReleaseSignalFact {
        kind: string;
      }
      interface CiWorkflowFact {
        kind: string;
        databaseId?: number;
        conclusion?: string | null;
        jobs?: { name: string; status: string; conclusion: string | null }[];
      }
      const openPullRequests = profile.openPullRequests ?? [];
      const issues = profile.issues ?? [];
      const releaseSignals = (profile.releaseSignals ?? []) as unknown as ReleaseSignalFact[];
      const ciWorkflows = (profile.ciWorkflows ?? []) as unknown as CiWorkflowFact[];

      expect(openPullRequests.length).toBe(prList.filter((pr) => pr.state === 'OPEN').length);
      expect(issues.length).toBe(issueList.length);
      expect(releaseSignals.length).toBe(releaseList.length + milestoneList.length);
      expect(releaseSignals.some((r) => r.kind === 'release')).toBe(true);
      expect(releaseSignals.some((r) => r.kind === 'milestone')).toBe(true);

      const ciRunEntries = ciWorkflows.filter((w) => w.kind === 'ci-run');
      expect(ciRunEntries.length).toBe(ciRuns.length);
      expect(ciRunEntries.some((w) => w.conclusion === 'skipped')).toBe(true);
      expect(ciRunEntries.some((w) => w.conclusion === 'cancelled')).toBe(true);
      const detailedRun = ciRunEntries.find((w) => w.databaseId === ciRunJobs.databaseId);
      expect(detailedRun?.jobs).toEqual(
        ciRunJobs.jobs.map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion })),
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
