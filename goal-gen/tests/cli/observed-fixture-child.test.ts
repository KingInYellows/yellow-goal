import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OBSERVER_OUTPUT_LIMIT,
  classifyReadyTick,
  interpretReadyWait,
  observerToolPath,
  runBoundedArgv,
} from '../../backend/src/cli/observed-fixture-child';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checksDir = path.join(packageRoot, 'backend/src/cli/observed-fixture-checks');

const posix = process.platform !== 'win32';

function expectProcessGone(pid: number): void {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.split(') ').at(1)?.[0];
      if (state === 'Z') return;
    } catch {
      return;
    }
  }
  throw new Error(`pid ${pid} still running`);
}

function toolEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: observerToolPath(),
    HOME: home,
    TMPDIR: home,
    LANG: 'C',
    GOAL_GEN_DISPOSABLE_OBSERVER: '1',
  };
}

describe('runBoundedArgv lifecycle', () => {
  let dir = '';

  afterEach(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('bounds captured output by UTF-8 bytes, including split code points', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'of-bytes-'));
    const script = path.join(dir, 'split.mjs');
    await writeFile(
      script,
      [
        "const euro = Buffer.from('\\u20ac', 'utf8');",
        'process.stdout.write(euro.subarray(0, 1));',
        'await new Promise((resolve) => setTimeout(resolve, 20));',
        'process.stdout.write(euro.subarray(1));',
        "process.stdout.write('\\u00e9'.repeat(80));",
      ].join('\n'),
    );
    const run = await runBoundedArgv({
      argv: [process.execPath, script],
      cwd: dir,
      env: toolEnv(dir),
      timeoutMs: 5_000,
      outputLimit: 20,
    });
    expect(run.spawnError).toBeUndefined();
    expect(run.stdoutTruncated).toBe(true);
    expect(run.stdout.startsWith('€')).toBe(true);
    expect(Buffer.byteLength(run.stdout, 'utf8')).toBeLessThanOrEqual(20 + 3);
    expect(run.stdout.length).toBeLessThan(80);
  });

  it('truncates multibyte output that fits a string-length bound but exceeds encoded bytes', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'of-mb-'));
    const script = path.join(dir, 'accent.mjs');
    await writeFile(script, "process.stdout.write('\\u00e9'.repeat(40));\n");
    const run = await runBoundedArgv({
      argv: [process.execPath, script],
      cwd: dir,
      env: toolEnv(dir),
      timeoutMs: 5_000,
      outputLimit: 50,
    });
    expect(run.stdoutTruncated).toBe(true);
    expect(run.stdout.length).toBeLessThanOrEqual(40);
    expect(Buffer.byteLength(run.stdout, 'utf8')).toBeLessThanOrEqual(50 + 2);
  });

  it('aborts an owned child without inventing an exit code', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'of-abort-'));
    const controller = new AbortController();
    const started = Date.now();
    const pending = runBoundedArgv({
      argv: [process.execPath, path.join(checksDir, 'hang-ignore.mjs')],
      cwd: dir,
      env: toolEnv(dir),
      timeoutMs: 20_000,
      outputLimit: OBSERVER_OUTPUT_LIMIT,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 80);
    const run = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(run.aborted).toBe(true);
    expect(run.spawnError).toBeUndefined();
    expect(run.exitStatus).toBeUndefined();
    expect(run.signal === 'SIGTERM' || run.signal === 'SIGKILL').toBe(true);
  });

  it('treats awaitReady child that exits before the ready file as readyFailed, not passed', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'of-ready-exit-'));
    const script = path.join(dir, 'exit-now.mjs');
    const readyPath = path.join(dir, 'ready');
    await writeFile(script, 'process.exit(0);\n');
    const started = Date.now();
    const run = await runBoundedArgv({
      argv: [process.execPath, script],
      cwd: dir,
      env: toolEnv(dir),
      timeoutMs: 5_000,
      outputLimit: OBSERVER_OUTPUT_LIMIT,
      readyPath,
      startupReadyMs: 8_000,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(run.spawnError).toBeUndefined();
    expect(existsSync(readyPath)).toBe(false);
    expect(run.readyFailed).toBe(true);
    expect(run.exitStatus).toBe(0);
    expect(run.signal).toBeUndefined();
    expect(run.timedOut).toBe(false);
  });

  it('does not treat readiness-budget expiry as an execution deadline', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'of-ready-budget-'));
    const script = path.join(dir, 'hang.mjs');
    const readyPath = path.join(dir, 'ready');
    await writeFile(script, 'setInterval(() => {}, 1000);\n');
    const started = Date.now();
    const run = await runBoundedArgv({
      argv: [process.execPath, script],
      cwd: dir,
      env: toolEnv(dir),
      timeoutMs: 5_000,
      outputLimit: OBSERVER_OUTPUT_LIMIT,
      readyPath,
      startupReadyMs: 80,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(existsSync(readyPath)).toBe(false);
    expect(run.readyFailed).toBe(true);
    expect(run.timedOut).toBe(false);
  });

  it('latches readiness-budget timeout even if the ready marker appears afterwards', () => {
    const buggyThen = (why: 'ready' | 'done' | 'timeout', filePresent: boolean) => {
      if (why === 'ready' || (why === 'done' && filePresent)) return 'arm-timeout';
      return filePresent ? 'ordinary-kill' : 'readiness-failed';
    };
    expect(buggyThen('timeout', true)).toBe('ordinary-kill');
    expect(interpretReadyWait('timeout', true)).toBe('readiness-failed');
    expect(interpretReadyWait('timeout', false)).toBe('readiness-failed');
    expect(interpretReadyWait('ready', true)).toBe('arm-timeout');
    expect(interpretReadyWait('done', true)).toBe('arm-timeout');
    expect(interpretReadyWait('done', false)).toBe('readiness-failed');
  });

  it('treats a late poll after the readiness budget as timeout even if the marker is present', () => {
    const markerFirst = (readyPresent: boolean, done: boolean, elapsedMs: number, budgetMs: number) => {
      if (readyPresent) return 'ready';
      if (done) return 'done';
      if (elapsedMs >= budgetMs) return 'timeout';
      return 'continue';
    };
    expect(markerFirst(true, false, 100, 80)).toBe('ready');
    expect(
      classifyReadyTick({ readyPresent: true, done: false, elapsedMs: 100, budgetMs: 80 }),
    ).toBe('timeout');
    expect(
      classifyReadyTick({ readyPresent: false, done: false, elapsedMs: 100, budgetMs: 80 }),
    ).toBe('timeout');
    expect(
      classifyReadyTick({ readyPresent: true, done: false, elapsedMs: 50, budgetMs: 80 }),
    ).toBe('ready');
    expect(
      classifyReadyTick({ readyPresent: false, done: true, elapsedMs: 50, budgetMs: 80 }),
    ).toBe('done');
    expect(
      classifyReadyTick({ readyPresent: false, done: false, elapsedMs: 50, budgetMs: 80 }),
    ).toBe('continue');
    expect(interpretReadyWait('timeout', true)).toBe('readiness-failed');
  });

  it('keeps readiness-failed when the ready marker appears only after the budget expires', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'of-late-ready-'));
    const script = path.join(dir, 'late-ready.mjs');
    const readyPath = path.join(dir, 'ready');
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {
  writeFileSync(process.env.GOAL_GEN_OBSERVER_READY, '');
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
    );
    const started = Date.now();
    const run = await runBoundedArgv({
      argv: [process.execPath, script],
      cwd: dir,
      env: toolEnv(dir),
      timeoutMs: 5_000,
      outputLimit: OBSERVER_OUTPUT_LIMIT,
      readyPath,
      startupReadyMs: 80,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(existsSync(readyPath)).toBe(true);
    expect(run.readyFailed).toBe(true);
    expect(run.timedOut).toBe(false);
    expect(run.exitStatus).toBe(0);
  });

  it.skipIf(!posix)(
    'settles when an owned descendant keeps inherited pipes after the parent exits',
    async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'of-desc-'));
      const readyPath = path.join(dir, 'ready');
      const started = Date.now();
      const run = await runBoundedArgv({
        argv: [process.execPath, path.join(checksDir, 'descendant-pipe.mjs')],
        cwd: dir,
        env: toolEnv(dir),
        timeoutMs: 200,
        outputLimit: OBSERVER_OUTPUT_LIMIT,
        readyPath,
      });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(run.spawnError).toBeUndefined();
      expect(run.timedOut).toBe(true);
      expect(run.exitStatus).toBe(0);
      expect(run.signal).toBeUndefined();
      const pidFile = `${readyPath}.descendant-pid`;
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expectProcessGone(pid);
    },
  );

  it.skipIf(!posix)('bounds descendant output before the pipes can fill memory', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'of-desc-bound-'));
    const readyPath = path.join(dir, 'ready');
    const started = Date.now();
    const run = await runBoundedArgv({
      argv: [process.execPath, path.join(checksDir, 'descendant-pipe.mjs')],
      cwd: dir,
      env: toolEnv(dir),
      timeoutMs: 2_000,
      outputLimit: 4 * 1024,
      readyPath,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(run.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(run.stdout, 'utf8')).toBeLessThanOrEqual(4 * 1024 + 16);
    const pidFile = `${readyPath}.descendant-pid`;
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expectProcessGone(pid);
    }
  });
});
