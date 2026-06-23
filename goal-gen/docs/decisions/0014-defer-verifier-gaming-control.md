---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0014. Defer the verifier-gaming control (test checksums) to M2

## Context and problem statement
Because `claude -p` can write to the repo **including the test files**, an agent can make a `verify` "pass" by deleting or weakening the test — a documented reward-hacking pattern. A strong defense is to **hash each verify/test file before and after every action and fail on change** (a "verify-integrity = 100%" gate), plus read-only test mounts. The question is whether to build this in v1.

## Decision
**Record it as a known v1 risk; implement the checksum/integrity control (+ read-only test mounts) at M2**, alongside execution hardening — **not** a v1 gate. v1 relies on the operator-reviewed `verify` checks ([[0008]]) and per-run worktrees ([[0009]]).

## Alternatives considered
- **Build the checksum gate in v1** — cleanest, but added M1 cost.
- **Skip entirely** — leaves success signals gameable indefinitely.

## Consequences
- 👍 Keeps M1 lean.
- 👎 v1 success signals are gameable by a misbehaving agent — **accepted** because v1 is single-user, operator-reviewed, and operator-watched. Revisit before any multi-user or unattended use.

## Confirmation
Tracked as a PRD §13 risk + an M2 note in `orchestrator.md`. **This ADR is superseded when the control ships** (new ADR).

## Links
- PRD §13, `.claude/specs/orchestrator.md`, `executor-router.md`, [[0008]], [[0009]].
