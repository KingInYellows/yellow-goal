---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0004. Deterministic A\* GOAP planner; no LLM inside the planner

## Context and problem statement
Plan ordering must be reliable, repeatable, and inspectable. LLM-driven ordering is exactly the opaque, unverifiable failure mode we're trying to avoid.

## Decision
The planner is a **deterministic forward A\*** over symbolic `WorldState` (g = sum of action costs; h = count of unmet goal predicates; BFS mode for guaranteed-shortest with multi-effect actions). **No LLM inside the planner.** The LLM only *authors* the action graph (extractor) and *executes* steps (executors).

## Alternatives considered
- **LLM-ordered plans** — non-deterministic, unverifiable.
- **HTN / heavier planners** — overkill for small, mostly-linear action sets.

## Consequences
- 👍 Same input ⇒ same plan; unit-testable; provable validity.
- 👎 The unmet-predicate heuristic is admissible only when each action satisfies ≤1 new goal predicate; use BFS mode otherwise (documented).

## Confirmation
Planner eval set asserts determinism + structural validity via a forward `simulatePlan()` oracle and `fast-check` properties (TBD: `tests/evals/planner/`).

## Links
- PRD §3, `.claude/specs/planner.md`, [[0007]], [[0013]].
