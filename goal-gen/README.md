# GOAL Generator

Self-hosted, single-user web app that turns a plain-English goal into an inspectable **GOAP plan** and **executes it with a real coding agent**. An LLM extracts a structured action graph; a deterministic **A\*** planner orders it into a valid, lowest-cost plan; an orchestrator dispatches each step to a headless coding-agent CLI on your own subscription; real results drive ground-truth verification and replanning.

**Status:** pre-M0 scaffold. Specs, decisions (ADRs), and the planner **eval harness** are in place; the planner itself is the first build task. Milestones: [`docs/prd.md`](docs/prd.md) §12.

## Why
`goal.ruv.io` markets this but ships a mock (its "live agents" are a `setTimeout` animation). This builds the two missing pieces: **dynamic LLM action-graph extraction** and a **real execution + telemetry layer**. Full research is in the parent knowledge base (`../docs/01`–`08`).

## Stack (ADR-0002)
TypeScript end-to-end — React/Vite (frontend) · Node (orchestrator/API) · Postgres + pgvector. Executors: host-installed `claude` (v1), then `codex`, `agy`.

## Quickstart — M0 (planner + evals; no host or CLIs needed)
Run from this `goal-gen/` directory:
```bash
nvm use            # Node 22+ (.nvmrc)
npm install
npm test           # oracle + fixture-integrity tests
npm run eval:planner
```
Expected today: **15 passed, 56 skipped** — the per-fixture planner suite and property tests auto-enable once `backend/src/planner/plan.ts` is implemented.

## Layout
| Path | What |
|------|------|
| `docs/prd.md` | Source-of-truth scope. |
| `docs/decisions/` | ADRs (MADR) — read before changing a locked decision. |
| `.claude/specs/` | Per-component contracts. |
| `CLAUDE.md` · `AGENTS.md` | Agent constitution (Claude Code / Codex). |
| `backend/src/planner/` | Canonical types, the `simulatePlan` oracle, and the `plan()` stub (implement next). |
| `tests/evals/planner/` | The eval set — 52 fixtures + properties ([README](tests/evals/planner/README.md)). |

## Building this with Claude Code
This repo is structured for spec-driven, eval-driven development. Start at [`docs/claude-code-handoff.md`](docs/claude-code-handoff.md), then implement the planner against the eval gate.

## License
Private; license TBD. Third-party attributions in [`NOTICE`](NOTICE).
