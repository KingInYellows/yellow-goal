---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0003. Vendor `goal_ui` (MIT) for UI + planner; build the backend fresh

## Context and problem statement
`goal_ui` (MIT) ships a polished plan-tree UI and a correct ~150-LOC client-side A\* planner. The execution + telemetry layer we actually want does not exist to fork.

## Decision
Vendor `goal_ui`'s MIT planner and plan-tree/state-card/config components (with attribution + license headers); **build the orchestration backend and the real-event run view fresh.** Lift liberally where it fits; do **not** import its `setTimeout`-mock or Supabase coupling.

## Alternatives considered
- **Adopt full RuFlo/claude-flow** — heavy, churny, single-maintainer, large footprint.
- **Build all UI fresh** — slower; reinvents what ruv.io genuinely nailed.

## Consequences
- 👍 Large head start on UI + planner.
- 👎 Must retain the MIT `NOTICE` and avoid dragging in mock/Supabase assumptions.

## Confirmation
`NOTICE`/attribution file present; `dashboard.md` "build the real-event run view fresh" criterion.

## Links
- doc 06 §4/§5, `.claude/specs/dashboard.md`, [[0004]].
