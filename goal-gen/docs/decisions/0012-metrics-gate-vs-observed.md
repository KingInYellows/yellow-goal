---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0012. Success metrics: gate vs observed split

## Context and problem statement
Some §8 metrics measure *our system*; others (executor success, replan recovery) measure the *underlying agent's* competence and can't be judged meaningfully without a fixed eval set — gating release on them would block on the model, not our code.

## Decision
Split the metrics. **GATE (block release):** plan validity ≥ 98%, GoalSpec schema-conformance ≥ 95%, no-runaway 100%, plan latency < 10s. **OBSERVED (report, not gate):** executor success rate, replan effectiveness, cost/goal — measured on a **frozen, difficulty-tiered** goal set, re-run unchanged on model upgrades so deltas are attributable to us, not the model.

## Alternatives considered
- **All hard gates** — blocks release on agent competence, using pre-eval guessed numbers.
- **No targets** — no signal at all.

## Consequences
- 👍 Honest, attributable metrics.
- 👎 Requires building and freezing an eval set before observed numbers mean anything.

## Confirmation
CI gates the GATE metrics on `tests/evals/`; an observed-metrics report runs on the frozen tiered set (TBD).

## Links
- PRD §8, [[0013]].
