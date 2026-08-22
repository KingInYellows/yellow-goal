import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runAnalyze,
  runCompile,
  runInspect,
  runPacketVerify,
  runRequestCreate,
  runRequestValidate,
} from '../../backend/src/cli/commands';
import { CliUsageError, NotWiredError } from '../../backend/src/cli/errors';
import { IntakeValidationFailure } from '../../backend/src/intake';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'goal-gen-cli-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('request create', () => {
  it('creates a request from --repo/--goal and writes it to --output', async () => {
    const outputPath = path.join(tempDir, 'request.json');
    const result = await runRequestCreate([
      '--repo',
      'octocat/example',
      '--goal',
      'Ship the thing.',
      '--output',
      outputPath,
    ]);
    expect(result.output.path).toBe(outputPath);
    expect(result.output.request.target.repository).toBe('octocat/example');

    const written = JSON.parse(await readFile(outputPath, 'utf8')) as { requestId: string };
    expect(written.requestId).toBe(result.output.requestId);
  });

  it('does not write a file when --output is omitted', async () => {
    const result = await runRequestCreate(['--repo', 'octocat/example', '--goal', 'Ship the thing.']);
    expect(result.output.path).toBeUndefined();
  });

  it('throws CliUsageError when --repo is missing', async () => {
    await expect(runRequestCreate(['--goal', 'Ship the thing.'])).rejects.toThrow(CliUsageError);
  });

  it('throws CliUsageError when --goal is missing', async () => {
    await expect(runRequestCreate(['--repo', 'octocat/example'])).rejects.toThrow(CliUsageError);
  });

  it('throws IntakeValidationFailure for an unknown --permission-profile', async () => {
    await expect(
      runRequestCreate([
        '--repo',
        'octocat/example',
        '--goal',
        'Ship the thing.',
        '--permission-profile',
        'not-a-real-profile',
      ]),
    ).rejects.toThrow(IntakeValidationFailure);
  });

  it('honors --json', async () => {
    const result = await runRequestCreate(['--repo', 'octocat/example', '--goal', 'Ship the thing.', '--json']);
    expect(result.json).toBe(true);
  });
});

describe('request validate', () => {
  it('reports valid: true for a canonical request file', async () => {
    const filePath = path.join(tempDir, 'request.json');
    await runRequestCreate(['--repo', 'octocat/example', '--goal', 'Ship the thing.', '--output', filePath]);
    const result = await runRequestValidate([filePath]);
    expect(result.output.valid).toBe(true);
    expect(result.output.path).toBe(filePath);
  });

  it('reports valid: false with errors for a malformed request file', async () => {
    const filePath = path.join(tempDir, 'bad-request.json');
    await writeFile(filePath, JSON.stringify({ nope: true }));
    const result = await runRequestValidate([filePath]);
    expect(result.output.valid).toBe(false);
    expect(result.output.errors.length).toBeGreaterThan(0);
  });

  it('reports valid: false for a canonical request with an unknown permission profile', async () => {
    const filePath = path.join(tempDir, 'request.json');
    await runRequestCreate(['--repo', 'octocat/example', '--goal', 'Ship the thing.', '--output', filePath]);
    const written = JSON.parse(await readFile(filePath, 'utf8')) as {
      orchestration: { permissionProfile: string };
    };
    written.orchestration.permissionProfile = 'bypassPermissions';
    await writeFile(filePath, `${JSON.stringify(written, null, 2)}\n`);
    const result = await runRequestValidate([filePath]);
    expect(result.output.valid).toBe(false);
    expect(result.output.errors.some((e) => e.path === 'orchestration.permissionProfile')).toBe(true);
  });

  it('throws CliUsageError when no file path is given', async () => {
    await expect(runRequestValidate([])).rejects.toThrow(CliUsageError);
  });

  it('throws CliUsageError for invalid JSON content', async () => {
    const filePath = path.join(tempDir, 'not-json.json');
    await writeFile(filePath, '{ not valid json');
    await expect(runRequestValidate([filePath])).rejects.toThrow(CliUsageError);
  });
});

describe('commands wired to the real modules', () => {
  // These four originally asserted NotWiredError while the target modules did not exist. The
  // modules are now integrated, so the same invocations must reach real code and fail on their
  // nonexistent input files instead — a NotWiredError here would mean the wiring regressed.
  it('inspect reaches the real inspection module (fails on the missing request file, not NotWired)', async () => {
    const p = runInspect(['request.json', '--output', tempDir]);
    await expect(p).rejects.toThrow();
    await expect(p).rejects.not.toThrow(NotWiredError);
  });

  it('inspect requires --output', async () => {
    await expect(runInspect(['request.json'])).rejects.toThrow(CliUsageError);
  });

  it('analyze reaches the real analysis module (fails on missing inputs, not NotWired)', async () => {
    const p = runAnalyze(['request.json', '--profile', 'profile.json', '--output', tempDir]);
    await expect(p).rejects.toThrow();
    await expect(p).rejects.not.toThrow(NotWiredError);
  });

  it('analyze requires --profile and --output', async () => {
    await expect(runAnalyze(['request.json'])).rejects.toThrow(CliUsageError);
  });

  it('compile reaches the real packets module (fails on missing inputs, not NotWired)', async () => {
    const p = runCompile(['request.json', '--assessment', 'assessment.json', '--output', tempDir]);
    await expect(p).rejects.toThrow();
    await expect(p).rejects.not.toThrow(NotWiredError);
  });

  it('compile requires --assessment and --output', async () => {
    await expect(runCompile(['request.json'])).rejects.toThrow(CliUsageError);
  });

  it('packet verify reaches the real packets module (structured invalid result on a missing packet, not NotWired)', async () => {
    const { output } = await runPacketVerify([path.join(tempDir, 'packet.zip')]);
    expect(output.valid).toBe(false);
    expect(output.errors.join('\n')).toContain('not found');
  });

  it('packet verify requires a positional path', async () => {
    await expect(runPacketVerify([])).rejects.toThrow(CliUsageError);
  });
});
