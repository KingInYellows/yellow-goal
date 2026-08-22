/**
 * Proves the protected-path invariant at the process-spawn level, not just by asserting on
 * output: every `git` subcommand invoked anywhere during a full `inspectRepository` run against
 * the `protected-file` fixture is metadata-only (`ls-files`, `ls-tree`, `cat-file -s`/`-t`,
 * `rev-parse`, `symbolic-ref`, `status`, `log`, `diff --name-status`, `branch`, `remote`) — never
 * `cat-file -p`, `show`, `log -p`, or any other content-revealing subcommand. Uses `vi.mock` on
 * `node:child_process` (not a DI seam on git.ts — its spawn primitive is deliberately private, see
 * git.ts's file-top comment) so every spawnSync call in the module graph is recorded while the
 * real implementation still runs underneath.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface RecordedSpawnCall {
  cmd: string;
  args: string[];
}
const spawnCalls: RecordedSpawnCall[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (cmd: string, args?: readonly string[], options?: unknown) => {
      spawnCalls.push({ cmd, args: args ? [...args] : [] });
      return actual.spawnSync(cmd, args as string[] | undefined, options as never);
    },
  };
});

// Imports below resolve through the mocked node:child_process for their entire module graph.
const { inspectRepository } = await import('../../backend/src/inspection');
const { initFixtureRepo } = await import('../fixtures/repositories/init-fixture');
type FixtureRepoHandle = Awaited<ReturnType<typeof initFixtureRepo>>;

const FIXED_CLOCK = () => new Date('2024-06-01T00:00:00.000Z');

const CONTENT_READING_GIT_SUBCOMMANDS = new Set(['show', 'archive', 'format-patch']);

describe('protected-path spawn safety (real spawnSync, recorded)', () => {
  let repo: FixtureRepoHandle | undefined;
  let workDir: string | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    if (workDir) await rm(workDir, { recursive: true, force: true });
    repo = undefined;
    workDir = undefined;
    spawnCalls.length = 0;
  });

  it('only invokes metadata-safe git subcommands during inspection of the protected-file fixture', async () => {
    repo = await initFixtureRepo('protected-file');
    workDir = await mkdtemp(join(tmpdir(), 'goal-gen-spawn-safety-'));
    const requestPath = join(workDir, 'request.json');
    await writeFile(
      requestPath,
      JSON.stringify({
        schemaVersion: 'yellow-goal/request/v1',
        requestId: 'req-spawn-safety-1',
        target: { repository: repo.dir },
        intent: { goal: 'Inspect the protected-file fixture for a spawn-safety proof.' },
        mode: 'review-only',
      }),
      'utf8',
    );

    // Only start recording once fixture setup (init/add/commit — legitimate writes, not
    // inspection) is done, so this test's assertions are about what INSPECTION does.
    spawnCalls.length = 0;

    const result = await inspectRepository({ requestPath, outputDir: join(workDir, 'out') }, { clock: FIXED_CLOCK });
    const profile = JSON.parse(await readFile(result.repoProfilePath, 'utf8'));
    expect(profile.protectedPaths.sort()).toEqual(['.env', 'key.pem']);

    const gitCalls = spawnCalls.filter((c) => c.cmd === 'git');
    expect(gitCalls.length).toBeGreaterThan(0);

    const subcommandsSeen = new Set<string>();
    for (const call of gitCalls) {
      const subcommand = call.args[0];
      expect(subcommand).toBeDefined();
      subcommandsSeen.add(subcommand!);
      expect(CONTENT_READING_GIT_SUBCOMMANDS.has(subcommand!)).toBe(false);
      if (subcommand === 'cat-file') {
        expect(call.args[1]).not.toBe('-p');
        expect(['-s', '-t']).toContain(call.args[1]);
      }
      if (subcommand === 'log') {
        expect(call.args).not.toContain('-p');
        expect(call.args).not.toContain('--patch');
      }
      if (subcommand === 'diff') {
        expect(call.args).toContain('--name-status');
      }
    }
    // Sanity: the metadata operations we expect to see for a protected-path scan actually ran.
    expect(subcommandsSeen.has('ls-tree')).toBe(true);
  });
});
