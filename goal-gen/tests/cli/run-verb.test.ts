/**
 * `run` verb contract (RR11–RR16, plans/specs/request-to-run-pipeline.md), tested in-process
 * through `main()` with stdout/stderr spies like the rest of tests/cli/. Every test uses
 * `--executor stub` (RR16) — nothing here can spawn a real `claude` or spend money; the
 * claude-code engine path stays covered by tests/integration/runner.probe.ts (operator-run).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunEventSchema } from '../../backend/src/contracts/run-event';
import { main } from '../../backend/src/cli/index';
import { requestExecutionSample, requestSample } from '../contracts/support/samples';

let tempDir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'goal-gen-run-verb-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  await rm(tempDir, { recursive: true, force: true });
});

function stdoutLines(): string[] {
  const text: string = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
  return text.split('\n').filter((line) => line !== '');
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

async function writeRequest(candidate: unknown): Promise<string> {
  const filePath = path.join(tempDir, 'request.json');
  await writeFile(filePath, JSON.stringify(candidate));
  return filePath;
}

describe('run verb (stub engine)', () => {
  it('streams valid run-event/v1 JSON Lines ending in run.summary and exits 0 (RR11/RR12)', async () => {
    const requestPath = await writeRequest(requestExecutionSample);
    const code = await main(['run', requestPath, '--executor', 'stub']);
    expect(stderrText()).toBe('');
    expect(code).toBe(0);

    const lines = stdoutLines();
    expect(lines.length).toBeGreaterThan(1);
    const envelopes = lines.map((line) => {
      const parsed = RunEventSchema.safeParse(JSON.parse(line));
      expect(parsed.success, line).toBe(true);
      return parsed.success ? parsed.data : undefined!;
    });
    expect(envelopes.map((e) => e.sequence)).toEqual(envelopes.map((_, i) => i));
    expect(new Set(envelopes.map((e) => e.runId)).size).toBe(1);
    const last = envelopes[envelopes.length - 1]!;
    expect(last.type).toBe('run.summary');
    expect(last.payload).toMatchObject({ status: 'succeeded' });
    // requestExecutionSample sets autoConfirmDod, so the DoD gate auto-confirms without --yes.
    expect(envelopes.some((e) => e.type === 'gate.autoConfirm')).toBe(true);
  });

  it('honors --yes when the request does not auto-confirm (RR14)', async () => {
    const requestPath = await writeRequest({
      ...requestExecutionSample,
      orchestration: { execution: { autoConfirmDod: false } },
    });
    const code = await main(['run', requestPath, '--executor', 'stub', '--yes']);
    expect(code).toBe(0);
    expect(stdoutLines().some((line) => (JSON.parse(line) as { type: string }).type === 'gate.autoConfirm')).toBe(true);
  });

  it('refuses to run without --executor: exit 2, USAGE_ERROR, nothing spawned (RR13)', async () => {
    const requestPath = await writeRequest(requestExecutionSample);
    const code = await main(['run', requestPath]);
    expect(code).toBe(2);
    expect(stdoutLines()).toEqual([]);
    const parsed = JSON.parse(stderrText().trim()) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('USAGE_ERROR');
    expect(parsed.error.message).toContain('--executor');
  });

  it('rejects an unknown --executor value with exit 2 (RR13)', async () => {
    const requestPath = await writeRequest(requestExecutionSample);
    const code = await main(['run', requestPath, '--executor', 'codex']);
    expect(code).toBe(2);
    expect((JSON.parse(stderrText().trim()) as { error: { code: string } }).error.code).toBe('USAGE_ERROR');
  });

  it('refuses a review-mode request with VALIDATION_FAILED and exit 1 (RR4)', async () => {
    const requestPath = await writeRequest(requestSample); // mode: review-and-compile
    const code = await main(['run', requestPath, '--executor', 'stub']);
    expect(code).toBe(1);
    expect(stdoutLines()).toEqual([]);
    const parsed = JSON.parse(stderrText().trim()) as { error: { code: string; details?: unknown } };
    expect(parsed.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(parsed.error.details)).toContain('RUN_MODE_NOT_EXECUTABLE');
  });

  it('requires the request-file positional (exit 2)', async () => {
    const code = await main(['run', '--executor', 'stub']);
    expect(code).toBe(2);
    expect((JSON.parse(stderrText().trim()) as { error: { code: string } }).error.code).toBe('USAGE_ERROR');
  });
});
