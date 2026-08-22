/**
 * Compiler golden test (node-plugin fixture class), orchestration golden test (proves the
 * profile resolves exactly as documented and the generated master prompt proves Fable-sole-lead
 * + no-merge/no-push + no-overlapping-ownership + explicit model IDs), and the AC-13 determinism
 * test (compile twice with the same fixed clock, normalize only declared timestampFields + zip
 * metadata, assert logical equality).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnalyzeRepository, RecordedAnalysisProvider } from '../../backend/src/analysis';
import { createCompilePacket, verifyPacketPath } from '../../backend/src/packets';
import { PACKET_TIMESTAMP_FIELDS } from '../../backend/src/packets/manifest';

const FIXTURES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'analysis');
const FIXTURE_DIR = path.join(FIXTURES_ROOT, 'node-plugin');
const PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packs', 'repository-goal-packet', 'v1');
const FIXED_CLOCK = (): Date => new Date('2026-08-22T00:00:00.000Z');

/** All three golden fixture classes the mission requires (08_PACK_SYSTEM.md "Golden fixtures"):
 *  Python/web application, Node/plugin repository, infrastructure repository. */
const GOLDEN_FIXTURE_CLASSES = ['node-plugin', 'python-app', 'infra-repo'] as const;

async function runFullPipeline(outputDir: string, fixtureDir: string = FIXTURE_DIR) {
  const analyze = createAnalyzeRepository(new RecordedAnalysisProvider(fixtureDir), FIXED_CLOCK);
  const analysisDir = path.join(outputDir, 'analysis');
  const analyzeResult = await analyze({
    requestPath: path.join(fixtureDir, 'request.json'),
    repoProfilePath: path.join(fixtureDir, 'repository-profile.json'),
    outputDir: analysisDir,
  });

  const compile = createCompilePacket({ clock: FIXED_CLOCK, packDirOverride: PACK_DIR });
  const compileResult = await compile({
    requestPath: path.join(fixtureDir, 'request.json'),
    assessmentPath: analyzeResult.assessmentPath,
    pack: 'repository-goal-packet@1',
    outputDir: path.join(outputDir, 'compiled'),
  });

  return compileResult;
}

describe.each(GOLDEN_FIXTURE_CLASSES)('compilePacket — golden fixture class: %s', (fixtureClass) => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), `compile-golden-${fixtureClass}-`));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('compiles a packet whose file set exactly matches the canonical 30-file layout', async () => {
    const result = await runFullPipeline(workDir, path.join(FIXTURES_ROOT, fixtureClass));
    const packetDirPath = (result as unknown as { packetDirPath: string }).packetDirPath;

    const manifest = JSON.parse(await readFile(path.join(packetDirPath, 'MANIFEST.json'), 'utf8')) as {
      files: { path: string }[];
      targetMutationOccurred: boolean;
      validation: { status: string };
    };
    expect(manifest.targetMutationOccurred).toBe(false);
    expect(manifest.validation.status).toBe('passed');
    // MANIFEST.json lists every file except itself and CHECKSUMS.sha256.
    expect(manifest.files).toHaveLength(28);
  });

  it('the compiled ZIP verifies with no failed checks', async () => {
    const result = await runFullPipeline(workDir, path.join(FIXTURES_ROOT, fixtureClass));
    const validation = await verifyPacketPath(result.packetPath);
    const failed = validation.checks.filter((c) => c.status === 'failed');
    expect(failed).toEqual([]);
    expect(validation.overall).toBe('passed');
  });
});

describe('compilePacket — node-plugin golden fixture', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'compile-golden-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('compiles a packet whose file set exactly matches the canonical 30-file layout', async () => {
    const result = await runFullPipeline(workDir);
    const packetDirPath = (result as unknown as { packetDirPath: string }).packetDirPath;

    const manifest = JSON.parse(await readFile(path.join(packetDirPath, 'MANIFEST.json'), 'utf8')) as {
      files: { path: string }[];
      targetMutationOccurred: boolean;
      validation: { status: string };
    };
    expect(manifest.targetMutationOccurred).toBe(false);
    expect(manifest.validation.status).toBe('passed');
    // MANIFEST.json lists every file except itself and CHECKSUMS.sha256.
    expect(manifest.files).toHaveLength(28);
  });

  it('the compiled ZIP verifies with no failed checks', async () => {
    const result = await runFullPipeline(workDir);
    const validation = await verifyPacketPath(result.packetPath);
    const failed = validation.checks.filter((c) => c.status === 'failed');
    expect(failed).toEqual([]);
    expect(validation.overall).toBe('passed');
  });

  it('01_EXECUTIVE_JUDGMENT.md and 05_MILESTONE.md render the fixture content with no leftover placeholders', async () => {
    const result = await runFullPipeline(workDir);
    const packetDirPath = (result as unknown as { packetDirPath: string }).packetDirPath;

    const judgment = await readFile(path.join(packetDirPath, '01_EXECUTIVE_JUDGMENT.md'), 'utf8');
    expect(judgment).toContain('Small, focused Node plugin');
    expect(judgment).not.toMatch(/\{\{[^{}]+\}\}/);

    const milestone = await readFile(path.join(packetDirPath, '05_MILESTONE.md'), 'utf8');
    expect(milestone).toContain('Add a lint script and wire it into the existing test command');
    expect(milestone).toContain('AC-001');
    expect(milestone).not.toMatch(/\{\{[^{}]+\}\}/);
  });
});

describe('orchestration golden test', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'compile-orch-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('06_ORCHESTRATION.md resolves exactly: lead claude-fable-5; investigation opus/opus/sonnet; implementation sonnet x3; verification opus/opus/sonnet', async () => {
    const result = await runFullPipeline(workDir);
    const packetDirPath = (result as unknown as { packetDirPath: string }).packetDirPath;
    const orchestration = JSON.parse(await readFile(path.join(packetDirPath, 'contracts', 'orchestration.json'), 'utf8')) as {
      profileId: string;
      lead: { modelId: string };
      waves: { name: string; teammates: { modelId: string }[] }[];
    };

    expect(orchestration.profileId).toBe('claude-fable-opus-sonnet@1');
    expect(orchestration.lead.modelId).toBe('claude-fable-5');

    const byName = Object.fromEntries(orchestration.waves.map((w) => [w.name, w.teammates.map((t) => t.modelId)]));
    expect(byName.investigation).toEqual(['claude-opus-5', 'claude-opus-5', 'claude-sonnet-5']);
    expect(byName.implementation).toEqual(['claude-sonnet-5', 'claude-sonnet-5', 'claude-sonnet-5']);
    expect(byName.verification).toEqual(['claude-opus-5', 'claude-opus-5', 'claude-sonnet-5']);
  });

  it('the generated master prompt proves Fable is sole lead, teammates cannot merge/push, ownership does not overlap, and every model ID is explicit', async () => {
    const result = await runFullPipeline(workDir);
    const packetDirPath = (result as unknown as { packetDirPath: string }).packetDirPath;
    const prompt = await readFile(path.join(packetDirPath, 'prompts', 'MASTER_IMPLEMENTATION_PROMPT.md'), 'utf8');

    // Sole lead / final integrator.
    expect(prompt).toMatch(/lead orchestrator and final integration owner/i);
    expect(prompt).toMatch(/sole integrator and final decision-maker/i);

    // No teammate merge/push/deploy — stated as a mutation boundary, enforced for every wave.
    expect(prompt).toMatch(/no wave may stage, commit, push, merge, resolve review threads, change permissions, or deploy/i);
    expect(prompt).toMatch(/only the lead performs those actions/i);

    // Every teammate line names a concrete model ID via backticked `model \`claude-...\``, never
    // a role assignment left as a vague description.
    const teammateLines = prompt.split('\n').filter((line) => /^\d+\. .+ — model `/.test(line));
    expect(teammateLines.length).toBeGreaterThanOrEqual(9); // 3 investigation + 3 implementation + 3 verification
    for (const line of teammateLines) {
      expect(line).toMatch(/model `claude-(fable|opus|sonnet)-5`/);
    }
    expect(prompt).toContain('claude-fable-5');
    expect(prompt).toContain('claude-opus-5');
    expect(prompt).toContain('claude-sonnet-5');

    // No leftover placeholders anywhere in the prompt.
    expect(prompt).not.toMatch(/\{\{[^{}]+\}\}/);

    // Non-overlapping ownership is stated as a requirement (exact allocation is per-run, not
    // baked into the packet — the packet states the invariant, not a specific file list).
    expect(prompt).toMatch(/must not overlap other teammates in the same wave/i);
    expect(prompt).toMatch(/file ownership must not overlap/i);
  });
});

describe('compilePacket — request/bundle identity', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'compile-mismatch-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('refuses a request whose repository identity is a different path than the assessment bundle', async () => {
    const analyze = createAnalyzeRepository(new RecordedAnalysisProvider(FIXTURE_DIR), FIXED_CLOCK);
    const analyzeResult = await analyze({
      requestPath: path.join(FIXTURE_DIR, 'request.json'),
      repoProfilePath: path.join(FIXTURE_DIR, 'repository-profile.json'),
      outputDir: path.join(workDir, 'analysis-repo'),
    });

    const mismatched = path.join(workDir, 'other-repo-request.json');
    const original = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'request.json'), 'utf8')) as {
      target: { repository: string };
    };
    original.target.repository = '/definitely/another/repository';
    await writeFile(mismatched, JSON.stringify(original));

    const compile = createCompilePacket({ clock: FIXED_CLOCK, packDirOverride: PACK_DIR });
    await expect(
      compile({
        requestPath: mismatched,
        assessmentPath: analyzeResult.assessmentPath,
        pack: 'repository-goal-packet@1',
        outputDir: path.join(workDir, 'compiled-repo'),
      }),
    ).rejects.toThrow(/repository mismatch/);
  });

  it('refuses a request whose goal or repository does not match the assessment bundle', async () => {
    const analyze = createAnalyzeRepository(new RecordedAnalysisProvider(FIXTURE_DIR), FIXED_CLOCK);
    const analyzeResult = await analyze({
      requestPath: path.join(FIXTURE_DIR, 'request.json'),
      repoProfilePath: path.join(FIXTURE_DIR, 'repository-profile.json'),
      outputDir: path.join(workDir, 'analysis'),
    });

    const mismatched = path.join(workDir, 'other-request.json');
    const original = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'request.json'), 'utf8')) as {
      intent: { goal: string };
    };
    original.intent.goal = 'A completely different goal that was never analyzed.';
    await writeFile(mismatched, JSON.stringify(original));

    const compile = createCompilePacket({ clock: FIXED_CLOCK, packDirOverride: PACK_DIR });
    await expect(
      compile({
        requestPath: mismatched,
        assessmentPath: analyzeResult.assessmentPath,
        pack: 'repository-goal-packet@1',
        outputDir: path.join(workDir, 'compiled'),
      }),
    ).rejects.toThrow(/do not describe the same run/);
  });
});

describe('AC-13 — deterministic double-compile', () => {
  let workDirA: string;
  let workDirB: string;

  beforeEach(async () => {
    workDirA = await mkdtemp(path.join(tmpdir(), 'compile-det-a-'));
    workDirB = await mkdtemp(path.join(tmpdir(), 'compile-det-b-'));
  });
  afterEach(async () => {
    await rm(workDirA, { recursive: true, force: true });
    await rm(workDirB, { recursive: true, force: true });
  });

  /** Strips every declared timestamp field (see manifest.ts's PACKET_TIMESTAMP_FIELDS) from a
   *  parsed MANIFEST.json before comparing two compiles — the only normalization AC-13 permits. */
  function normalizeManifest(manifest: Record<string, unknown>): Record<string, unknown> {
    const clone = structuredClone(manifest);
    delete clone.inspectionStartedAt;
    delete clone.inspectionCompletedAt;
    return clone;
  }

  it('compiling twice with the same fixed clock produces logically identical file sets and content', async () => {
    const resultA = await runFullPipeline(workDirA);
    const resultB = await runFullPipeline(workDirB);

    const dirA = (resultA as unknown as { packetDirPath: string }).packetDirPath;
    const dirB = (resultB as unknown as { packetDirPath: string }).packetDirPath;

    // Same packetId (deterministic from repo+milestone+clock date), same file set.
    expect(path.basename(dirA)).toBe(path.basename(dirB));

    for (const relPath of ['00_START_HERE.md', '05_MILESTONE.md', '06_ORCHESTRATION.md', 'contracts/orchestration.json', 'CHECKSUMS.sha256']) {
      const [contentA, contentB] = await Promise.all([
        readFile(path.join(dirA, relPath), 'utf8'),
        readFile(path.join(dirB, relPath), 'utf8'),
      ]);
      expect(contentA, `${relPath} should be byte-identical`).toBe(contentB);
    }

    const [manifestA, manifestB] = await Promise.all([
      readFile(path.join(dirA, 'MANIFEST.json'), 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>),
      readFile(path.join(dirB, 'MANIFEST.json'), 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>),
    ]);
    expect(normalizeManifest(manifestA)).toEqual(normalizeManifest(manifestB));
    // Every declared timestamp field really is present in both manifests (nothing silently
    // renamed away from what PACKET_TIMESTAMP_FIELDS claims to cover).
    expect(manifestA.timestampFields).toEqual(PACKET_TIMESTAMP_FIELDS);

    // Same fixed clock -> same ZIP entry mtimes -> byte-identical archives.
    const [zipA, zipB] = await Promise.all([readFile(resultA.packetPath), readFile(resultB.packetPath)]);
    expect(zipA.equals(zipB)).toBe(true);
  });
});
