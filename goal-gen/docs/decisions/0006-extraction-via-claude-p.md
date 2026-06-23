---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0006. Goal extraction via headless `claude -p`

## Context and problem statement
Executors run on the user's subscription via local CLI login. The goal-extractor is a separate structured LLM call; we want to avoid a separate API key/bill and stay on the subscription.

## Decision
The goal-extractor runs via **headless `claude -p --output-format json`** on the subscription (no API key), behind a thin LLM interface so it can be swapped later. Strict JSON is prompt-enforced, parsed from the result, **zod-validated**, with one bounded **repair round**.

## Alternatives considered
- **Anthropic API with forced tool-use** — most reliable JSON, but adds a key + metered cost outside the subscription.
- **OpenAI-compatible multi-provider abstraction now** — abstraction cost for a solo tool; structured-output behavior varies by provider.

## Consequences
- 👍 One credential; extraction cost stays on-subscription.
- 👎 No server-side forced tool-use ⇒ JSON isn't guaranteed ⇒ the repair round is load-bearing. Track first-try vs post-repair schema-conformance.

## Confirmation
Extractor eval measures schema-conformance (first-try + post-repair) via `promptfoo` (TBD).

## Links
- PRD §14, `.claude/specs/goal-extractor.md`, [[0013]].
