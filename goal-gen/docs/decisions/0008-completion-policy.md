---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0008. Definition of done via operator-confirmed `completionPolicy`

## Context and problem statement
The extractor authors both the `goalState` and the `verify` checks. Without a human gate, the system can declare success against criteria it invented, using checks it wrote — "ground truth" is only as strong as an LLM-authored check.

## Decision
Every `GoalSpec` carries a **`completionPolicy`** (`verify-only | verify+signoff | operator-defined`) **recommended by the extractor and confirmed/edited by the operator before the run**. When sign-off is required, a satisfied `goalState` enters an `awaiting-acceptance` state until the operator accepts.

## Alternatives considered
- **Ground-truth verify only** — fast, but the system grades its own homework.
- **Always require sign-off** — adds friction on goals with unambiguous checks.

## Consequences
- 👍 Closes the self-grading loop; the operator owns the bar.
- 👎 Adds a confirm-criteria step and an acceptance UI surface.

## Confirmation
PRD FR-2a/FR-13; `api.md` `PATCH /goals/:id/criteria` + `POST /runs/:id/accept`; `orchestrator.md` `awaiting-acceptance`.

## Links
- PRD §3/§7, `.claude/specs/orchestrator.md`, `api.md`, `dashboard.md`.
