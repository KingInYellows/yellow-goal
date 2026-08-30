---
title: 'Cross-Reviewer Agreement Is the Strongest True-Positive Signal in Multi-Agent Review Sweeps'
date: 2026-08-26
category: workflow
track: knowledge
problem: 'Triaging ~60 reviewer-agent findings across a stacked-PR sweep needs a confidence signal beyond each finding own self-reported confidence score'
tags: [multi-agent-review, review-sweep, confidence-calibration, false-positive, reviewer-context, triage]
components: []
source: 'review:sweep-all across PR #15-#19 (KingInYellows/yellow-goal)'
---

# Cross-Reviewer Agreement Is the Strongest True-Positive Signal in Multi-Agent Review Sweeps

## Context

A `/review:sweep-all` pass across a 5-PR stack (CI gates → request
contract → run-event/v1 → run verb → version verb) dispatched roughly 60
reviewer-agent reports across independent personas (security, adversarial,
correctness, silent-failure, type-design, reliability, plus an external
Codex reviewer). Several genuine, verified bugs came out of this sweep
(see the companion docs on protocol-stream purity, the terminal-envelope
gap, and the sequence-collision/migration fix) — all three were confirmed
independently by more than one reviewer persona before being triaged as
real.

## Guidance

When triaging a large batch of independently-generated review findings,
**weight cross-reviewer agreement at the same fingerprint (same file
region, same underlying defect) above each individual finding's
self-reported confidence score.** In this sweep:

- The terminal-envelope hole (deleted unconditional `run.summary` emit
  masking a gap in two failure paths) was independently flagged by
  **five** of the ~60 reviewers.
- The stdout protocol-purity + EOF-stdin hang defect was independently
  flagged by **three** reviewers (adversarial, confidence 100, plus
  silent-failure-hunter corroborating from a different angle).
- Both were true positives, verified live against the stub engine before
  being accepted — not accepted on reviewer say-so alone.
- Single-reviewer findings at the low end of the confidence scale
  (confidence ~50) were, in this sweep, mostly correctly suppressed by
  the project's existing confidence gate — the gate's threshold was doing
  its job on the low-agreement, low-confidence tail.

A single false positive in this sweep (from the Codex reviewer) had a
root cause outside the code under review entirely: the orchestrating
process's own diff pathspec excluded the lockfile from what Codex was
given to review, so Codex flagged an inconsistency that was an artifact
of its own restricted view, not a real defect.

## Why This Matters

Any individual reviewer agent's confidence score is a self-assessment
from a single vantage point — it says nothing about whether *other*
independent vantage points reached the same conclusion. Multiple
personas built around different concerns (security vs. correctness vs.
silent-failure detection) converging on the *same* fingerprint from
*different* angles is a stronger correctness signal than any one of them
scoring itself highly, precisely because it rules out persona-specific
blind spots or a single model's idiosyncratic false-positive pattern.

## When to Apply

- Triaging output from any multi-agent review pass (`/review:sweep-all`,
  `/review:pr` with multiple personas, `/council`) where more than a
  handful of independent reports land at once and reading every one in
  full is impractical.
- Deciding which findings to act on first when time or reviewer-fix
  budget is limited — start with the fingerprints that recur across
  reviewers, not the ones with the highest individual confidence score.
- Building or tuning an automated confidence gate for a review pipeline:
  cross-reviewer recurrence count is a candidate signal worth combining
  with (not replacing) each finding's own confidence score.

## Examples

- Treat "N of M independent reviewers flagged the same file region for
  the same underlying reason" as a distinct, elevated priority tier —
  even if no single one of those N reports carries the highest
  self-reported confidence in the batch.
- When a reviewer's finding looks like a false positive, check whether
  the reviewer's *input construction* (diff pathspec, file scoping,
  truncated context) is itself part of what's under review — a
  restricted view can produce a plausible-looking finding about a gap
  that exists only in what the reviewer was shown, not in the code
  itself.
- Don't discount an isolated low-confidence (~50) finding purely for
  being isolated — but do treat isolation *combined with* low
  self-reported confidence as the signal that a confidence-gate
  suppression is probably correct, absent other evidence.
