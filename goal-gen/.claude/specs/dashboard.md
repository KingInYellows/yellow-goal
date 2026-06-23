# Spec — Frontend / Live Dashboard

**Component:** `frontend/src/` · **Depends on:** the api (REST + `/stream`). **Principle:** render real state from real events — no mocked telemetry (the explicit contrast with `goal.ruv.io`'s `setTimeout` mock, see `../../docs/03-goal-ruv-io-analysis.md`). **v1 is a minimal single-run view; the full multi-agent dashboard is M2.**

## Screens
1. **Goal intake** — textarea + optional config (depth, constraints, repo path); "Generate plan". Handles a `needsClarification` response by prompting for more detail. *(Per-step executor preference is M2.)*
2. **Plan review (plan tree)** — collapsible action-tree from `Plan`: each node shows name, executor, cost, preconditions/effects, status, `dependsOn`; blocked/replanned branches highlighted. Side panels: world-state vs goal-state (with gaps), run config, and the **definition of done** — `goalState`, each action's `verify` check, and the recommended `completionPolicy`, all **editable before approving** (FR-2a). **"Approve & run"** (or step mode).
3. **Live run view** — real status driven by `StreamEvent`s: current action, streamed output, plan-tree progress, per-run tokens/cost, and an **event log** (real events, no static literals); controls: **pause/resume, kill, approve step**, and **accept/reject** when a run is `AwaitingAcceptance`. *v1 is a single-run minimal view; the multi-agent card grid and **reassign** are M2.*
4. **History** — past goals/plans/runs; replay a run's event log.

## Behavior
- Subscribe to `/stream/:planId`; update plan tree + live view from events; handle reconnect/resume.
- All numbers (tokens, cost, status) come from server events — **never** fabricated or randomized.
- Kill/pause/approve-step/accept call the api and reflect the resulting events. *(Reassign = M2.)*
- **Lift `goal_ui`'s MIT components liberally** where they fit (plan tree, state card, config panel) — keep license headers/attribution; **build the real-event run view fresh** rather than adapting the demo's `setTimeout` mock or Supabase coupling.

## Error / edge cases
- Stream drop → show "reconnecting"; resume from last event id.
- No-plan result → show the planner's `reason` clearly, offer to revise the goal.
- Long-running run → virtualize logs; cap rendered history.

## Acceptance criteria
- Operator can go intake → plan tree → **confirm definition of done** → approve → watch a live run end-to-end.
- Telemetry matches reality (spot-check run numbers against raw CLI logs).
- A real replan is visibly reflected (blocked → replanned branch), including re-extraction.
- Controls (pause/kill/step-approve, and accept/reject on `AwaitingAcceptance`) work mid-run. *(Reassign = M2.)*

## Out of scope
Planning/execution logic (backend); auth provider internals.
