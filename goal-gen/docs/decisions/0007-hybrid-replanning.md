---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0007. Hybrid replanning with bounded re-extraction

## Context and problem statement
Classic GOAP assumes a complete, fixed action library. Our pool is LLM-authored and deliberately "minimal sufficient," so it's frequently incomplete on failure paths — pure re-plan over a fixed pool returns "no plan" exactly when recovery is needed. Re-extracting on *every* failure is the AutoGPT runaway/loop mode.

## Decision
**Hybrid:** on failure, re-plan deterministically over the existing pool first; if that returns **no plan** (or a subgoal fails ≥ N times), call `extractor.expand()` with the **real failure evidence** to author **additional** actions (append-only), then re-plan over the expanded pool. Bounded by a per-run re-extraction cap. The *decision* to re-extract is deterministic; only the *authoring* is LLM — so [[0004]] holds.

## Alternatives considered
- **Fixed-pool re-plan only** — fully deterministic but brittle; many real failures need a new step.
- **Always re-extract on failure** — most adaptive, highest cost, least repeatable.

## Consequences
- 👍 Adaptive exactly where GOAP-on-an-LLM-pool is brittle; bounded against runaway; planner stays LLM-free.
- 👎 An extra LLM call on hard failures; the action pool grows within a run.

## Confirmation
Failure-injection harness measures recovery-within-N replans/re-extractions (TBD, M1).

## Links
- PRD §7 (FR-7), `.claude/specs/orchestrator.md`, `planner.md`, `goal-extractor.md`, [[0004]].
