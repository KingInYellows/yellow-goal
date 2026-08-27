---
title: 'Interactive Gate Prompts Corrupting the run-event/v1 Protocol Stream on stdout'
date: 2026-08-26
category: integration-issues
track: bug
problem: 'Interactive stdin confirmation prompts wrote prose to stdout after it silently became a machine-parsed JSON Lines stream; EOF stdin also hung forever'
tags: [stdin, readline, run-event-v1, protocol-stream, eof, gate, orchestrator, never-throws]
components: [backend/src/orchestrator/orchestrator.ts, backend/src/cli/run-command.ts]
source: 'review:sweep-all across PR #15-#19 (KingInYellows/yellow-goal), fix commit 0a7e6e7'
---

# Interactive Gate Prompts Corrupting the run-event/v1 Protocol Stream on stdout

## Problem

`stdinConfirm` (the DoD gate) and `stdinAcceptanceGate` (the sign-off gate)
wrote their `readline` prompt text directly to `process.stdout`. That was
fine when stdout was a human terminal. It stopped being fine the moment the
`run-event/v1` event emitter (added earlier in the same PR stack) made
stdout a **machine-parsed JSON Lines protocol stream** for both entry points
that call these gates (the M1 runner and the `run` verb) — interactive
prose spliced into the middle of that stream corrupts every downstream
consumer parsing it line-by-line as JSON.

A second, independent bug shared the same two call sites: with stdin at EOF
(`/dev/null`, or a pipe that has already drained — any non-interactive
invocation), `node:readline/promises`' `rl.question()` **never settles** —
it neither resolves nor rejects. The event loop simply drains and the
process exits 0 mid-stream, with no terminal `run.summary` envelope ever
emitted.

## Symptoms

- Piping `run` verb output to a JSON Lines parser broke on the prompt lines
  (`Proceed? [y/N]`, `Accept? [y/N]`) — they were not valid JSON.
- Invoking the M1 runner or the `run` verb non-interactively (stdin
  redirected from `/dev/null`, or under any process supervisor that doesn't
  attach a tty) exited 0 with the stream cut short at `extract.done` — no
  `run.summary` line, so a consumer waiting for the terminal envelope
  waited forever or falsely inferred success from the exit code.
- Multi-agent review (adversarial persona, confidence 100, corroborated by
  the silent-failure-hunter persona) flagged both independently; verified
  live against the stub engine before the fix, not just from static review.

## What Didn't Work / Root Cause

The prompts were written before `run-event/v1` existed, when stdout was
purely human-facing. Nothing about the gate code changed when the event
emitter was introduced — the **contract of the channel changed underneath
it**. This is the general failure mode: an output stream silently becomes a
consumed protocol, and code written for "stdout is for humans" keeps
writing to it unmodified.

The EOF-hang bug has a subtler root cause: `rl.question()`'s promise is
driven by the `'line'` event. When stdin hits EOF with no line ever typed,
`readline` fires `'close'` instead of `'line'` — and the promise returned
by `question()` has no listener wired to `'close'` at all, so it just
never settles. `AbortSignal`-based cancellation (already in place for
SIGINT/SIGTERM) doesn't help here because nothing aborts the signal on
EOF — the process just runs out of work to do.

## Solution

Two changes to `backend/src/orchestrator/orchestrator.ts`, applied
identically to both gates:

```ts
// 1. Prompt text and the readline interface itself target stderr, never stdout.
process.stderr.write(`${lines.join('\n')}\n`);
const rl = createInterface({ input: process.stdin, output: process.stderr });

// 2. Race the question against readline's 'close' event to detect EOF.
const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
const answer = await Promise.race([rl.question('Proceed? [y/N] ', { signal }), closed]);
if (answer === null) {
  return false; // stdinConfirm (DoD gate): EOF declines — costs nothing, produces a clean 'cancelled' summary
  // stdinAcceptanceGate instead does:
  // throw new Error('stdin closed while awaiting sign-off — refusing to auto-decide a completion gate non-interactively');
}
```

The two gates deliberately diverge on what EOF means:

- **DoD gate** (`stdinConfirm`): EOF → **decline**. Declining before any
  spend happens costs nothing and produces a clean `cancelled` summary.
- **Acceptance/sign-off gate** (`stdinAcceptanceGate`): EOF → **throw**,
  never silently resolve `'reject'`. A `'reject'` answer here re-enters the
  remediation loop, which spends real LLM budget unattended — an
  unattended process must never make that decision on its own.

Two smaller, related fixes shipped in the same commit:

- `stdinConfirm`'s catch block no longer rethrows non-abort stdin errors
  (e.g. `EIO` from a genuinely broken stdin) — it declines, the same as
  EOF, preserving `Orchestrator.run()`'s documented never-throws contract.
- `runRunCommand` now wraps `orchestrator.run()` in a try/catch: *if* the
  never-throws contract is ever violated by a future bug, it still emits a
  synthetic `run.summary(status: 'failed')` before rethrowing, so "the
  last stdout line is always the terminal envelope" holds unconditionally
  rather than depending on every caller upholding the contract correctly.

## Why This Works

Redirecting prompts to stderr separates the human-facing and
machine-parsed channels cleanly — stdout stays pure JSON Lines regardless
of whether a human or a pipe is on the other end of stdin. Racing against
`'close'` converts an unobservable hang into an observable, immediate
decision, and letting the two gates diverge on what that decision *means*
(decline vs. fail loudly) encodes the actual cost asymmetry: declining is
free, but silently choosing "reject" on behalf of an absent operator is
not.

Verified post-fix: piped `'n'` → exit 1, prompt on stderr, stdout stays
pure JSON ending in `run.summary(cancelled)`; closed stdin → exit 1, same
terminal envelope guarantee (previously exit 0 with the stream truncated
at `extract.done`).

## Prevention

- Whenever a new consumer starts machine-parsing an existing output
  stream (stdout, a log file, a socket), audit every writer to that
  stream that predates the new consumer — human-facing prose and
  machine protocol data must never share a channel.
- Any blocking read on external input (`readline`, a socket read, a
  subprocess wait) needs an explicit EOF/close path, not just an abort
  path — `resolve`/`reject` are not the only two ways a promise-wrapped
  I/O call can fail to progress.
- When two similar-looking gates in the same code path have different
  blast radii on ambiguous input (declining is free vs. triggers real
  spend), make that asymmetry explicit in code (fail loud vs. fail safe)
  rather than handling both identically for consistency's sake.
- A `never-throws` contract on a function that terminates a protocol
  stream is worth defending at the caller too — wrap the call so a future
  violation still produces a valid terminal envelope instead of silently
  truncating the stream.
