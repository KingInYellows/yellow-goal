---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0009. Worktrees are collision-avoidance, not a sandbox; containers at M2

## Context and problem statement
The orchestrator runs arbitrary, possibly prompt-injected agent code with the user's logged-in CLIs and keys. Git worktrees are easy to mistake for a security boundary.

## Decision
v1 uses **one git worktree per run for collision-avoidance only — explicitly NOT a security sandbox.** In v1 the **host LXC/VM is the blast radius.** Per-run **containers** for real in-host isolation arrive at **M2** (a VM is cleaner than an unprivileged LXC for nested containers).

## Alternatives considered
- **Containers from day one** — stronger safety, more M1 build/ops friction.
- **Worktrees-only indefinitely** — VM-wide reach for any misbehaving agent, forever.

## Consequences
- 👍 Simple v1; VM snapshots/rollback give a clean recovery story.
- 👎 Only mount repos/dirs you're willing to expose; real in-VM isolation is deferred to M2.

## Confirmation
PRD §9 (security) / §11 (host); host runbook (TBD).

## Links
- PRD §9/§11, doc 05 §6, [[0014]].
