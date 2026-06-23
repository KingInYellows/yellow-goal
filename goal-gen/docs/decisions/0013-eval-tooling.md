---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0013. Eval tooling: Vitest + fast-check + promptfoo

## Context and problem statement
We must evaluate three different things in a TS/solo/self-hosted setting: a deterministic planner, an LLM goal-extractor, and (later) an execution/replan harness. No single tool is best at all three.

## Decision
- **Planner + failure-injection harness:** **Vitest** + **fast-check** (property-based). A native ~100-LOC `simulatePlan()` oracle validates plans by **structural properties** (goal reached, preconditions hold, cost ≤ BFS-derived bound, partial-order/dependency correctness, no-plan for unsatisfiable) — **not** exact golden-plan match.
- **Extractor:** **promptfoo** (TS-native, self-hostable, free) for prompt/schema-conformance regression.
- **Layout:** eval fixtures (YAML) under `tests/evals/`, run via Vitest; CI gates on planner/extractor/ADR changes.

## Alternatives considered
- **Vitest-only for everything** — fewer tools, weaker prompt-eval ergonomics.
- **promptfoo-centric** — great for prompt eval, awkward for property-based planner tests.
- **Python frameworks / SaaS (DeepEval, Braintrust, LangSmith)** — off-stack for a TS self-hosted build.

## Consequences
- 👍 Best fit per layer; everything self-hostable and free.
- 👎 Two test tools to learn and wire into CI.

## Confirmation
Confirmed once `tests/evals/` exists with the planner suite + a `promptfoo` config in CI.

## Links
- PRD §8, [[0004]], [[0012]].
