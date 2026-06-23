---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0005. v1 scope = M1 (single executor, serial, local single-user)

## Context and problem statement
The full vision (three executors + parallelism + full dashboard) is large. The unique, demo-beating value — real execution with ground-truth verify + replanning — already appears with a single executor.

## Decision
**v1 release gate = M1:** a single executor (Claude Code, `claude -p`), run **serially**, on a **local, single-user** host, with ground-truth verify, replanning (incl. bounded re-extraction), a confirm-criteria/sign-off gate, a minimal live view, and persistence. Multi-executor + routing + parallelism + full dashboard = **M2 fast-follow**; memory = **M3**.

## Alternatives considered
- **v1 = M2 (full multi-executor + dashboard)** — largest surface, highest slip risk.
- **v1 = M0 (dry-run only)** — doesn't yet beat the `goal.ruv.io` mock.

## Consequences
- 👍 Fastest path to real value; lowest slip risk.
- 👎 Defers the multi-agent showcase to M2.

## Confirmation
PRD §6 (scope), §10 (acceptance criteria), §12 (milestones).

## Links
- PRD §6/§12, doc 08 §5.
