---
title: 'Deleted "Always Emits" Assumption Masked a Terminal-Envelope Gap on Pre-RunState Failure Paths'
date: 2026-08-26
category: logic-errors
track: bug
problem: 'runner.ts deleted its unconditional post-run run.summary emit on the false premise that run() always emits one; extraction-failure/abort paths silently did not'
tags: [run-event-v1, terminal-envelope, run-summary, bareSummary, orchestrator, silent-failure]
components: [backend/src/orchestrator/orchestrator.ts]
source: 'review:sweep-all across PR #15-#19 (KingInYellows/yellow-goal), fix commit eacb70a'
---

# Deleted "Always Emits" Assumption Masked a Terminal-Envelope Gap on Pre-RunState Failure Paths

## Problem

An earlier PR in the stack deleted the runner's unconditional post-run
`run.summary` emit — the log line that ran after `Orchestrator.run()`
returned, regardless of outcome. The deletion was justified on the premise
that "`run()` always emits a terminal `run.summary` itself now, via the
event emitter, so the outer emit is redundant." That premise was false for
two specific paths: when extraction throws before any `RunState` exists,
and when the run is aborted mid-extraction. Both paths returned a
`bareSummary()` helper — which **builds** a summary object but does not
**emit** it — so the deleted outer emit was the only thing that had ever
put a terminal envelope on the stream for those two cases.

## Symptoms

- A `run-event/v1` stream for a run whose extraction step throws (e.g. the
  extractor CLI is unavailable) ended with no `run.summary` event at all —
  the last line was whatever the extraction-failure event was, with no
  terminal marker after it.
- Five independent reviewers converged on this exact gap during the
  sweep — the single strongest true-positive signal observed across the
  ~60-agent review (see the companion workflow doc on cross-reviewer
  agreement).
- A downstream consumer relying on "the stream always ends in
  `run.summary`" to know a run is finished would hang indefinitely on
  these two paths, or need a separate stall-timeout to notice.

## What Didn't Work / Root Cause

The general lesson: **before deleting an unconditional trailing
emit/log/write because "the callee already handles it," check every
return path of the callee for the same guarantee** — not just the common
path. `run()`'s main loop does emit `run.summary` on every path *after*
`RunState` is constructed. The two paths that fail *before* `RunState`
exists (extraction threw, or the run aborted during extraction) never
reach that code — they short-circuit through `bareSummary()`, a pure
builder function with no emitter access at that point in the original
code, so nothing on those paths ever called `this.emit(...)`.

The deleted outer emit had been silently covering this gap the whole
time; removing it converted a redundant-looking safety net into an actual
hole the moment its removal shipped.

## Solution

Added a private helper that builds *and* emits in one step, and switched
both pre-RunState failure returns to use it instead of the bare builder:

```ts
// backend/src/orchestrator/orchestrator.ts
/** RR10: even failures that happen before any RunState exists (extraction threw, or the run was
 *  aborted mid-extraction) must terminate the event stream with a run.summary envelope. */
private emitBareSummary(goalText: string, status: RunStatus, reason: string, costUsd: number): RunSummary {
  const summary = bareSummary(goalText, status, reason, costUsd);
  this.emit({ ev: 'run.summary', ...summary });
  return summary;
}
```

```ts
// both call sites, previously `return bareSummary(...)`:
if (this.signal.aborted) return this.emitBareSummary(req.goalText, 'cancelled', 'aborted during extraction', failedCostUsd);
return this.emitBareSummary(req.goalText, 'failed', `extraction failed: ${message}`, failedCostUsd);
```

A regression test asserts the full envelope list for a throwing extractor
ends in exactly one `run.summary` event, is the *last* event in the
stream, and every event in the stream parses against the `run-event/v1`
zod schema.

## Why This Works

`emitBareSummary()` collapses "build the summary" and "put it on the
stream" into a single call, so there is no longer a code path that can
construct a terminal summary without also emitting it — the two
operations can no longer drift apart the way `bareSummary()` (build-only)
and the deleted outer emit (emit-only, coupled by convention rather than
by the type system) had drifted.

## Prevention

- Before deleting a trailing/unconditional emit, log, or write because a
  callee "already covers it," enumerate the callee's actual return paths
  (including early-throw and pre-state-construction paths) and confirm
  each one hits the equivalent guarantee — do not infer coverage from the
  common/happy path alone.
- When a guarantee ("every run ends in exactly one terminal event") is
  meant to be unconditional, prefer a single helper that both builds and
  emits over two functions that must be called together by convention;
  the latter is a silent coupling that a future refactor can break
  without any type error.
- Cross-reviewer agreement at the same fingerprint (5 of ~60 agents
  independently flagged this exact gap) is a strong true-positive signal
  worth weighting heavily when triaging review output — see
  `docs/solutions/workflow/cross-reviewer-agreement-signal.md`.
