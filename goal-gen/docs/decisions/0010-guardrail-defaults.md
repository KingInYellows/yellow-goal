---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0010. Guardrail defaults & cap-trip behavior

## Context and problem statement
Runaway loops and cost are the AutoGPT failure mode. Caps must be concrete, enforced centrally, and have defined trip behavior.

## Decision
Defaults (v1, overridable per-run): **$20/run budget · 5 max replans · ≤ 2 re-extractions/run · 60-min wall-clock · 3 retries/action · concurrency 1 (serial).** Loop detection = the same action failing the same way twice. **On a cap trip:** stop dispatching new work, mark the run paused/blocked, and surface to the operator to raise the cap, resume, or cancel; budget exhaustion → `budget-exhausted`.

## Alternatives considered
- **Tighter** (~$2 / 2 replans / 15 min) — cheaper/safer, more false stops on legitimately long goals.
- **Looser without loop detection** — runaway risk.

## Consequences
- 👍 No-runaway guarantee; predictable cost ceiling.
- 👎 Long legitimate goals may need a manual cap raise.

## Confirmation
PRD §8 no-runaway gate; a forced-loop guardrail test must terminate (TBD).

## Links
- PRD §8/§11 (FR-11), `.claude/specs/orchestrator.md`.
