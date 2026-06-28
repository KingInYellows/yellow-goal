# CLAUDE.md — GOAL Generator

Repo memory + "constitution" for Claude Code. Keep this file tight. Update it when an architectural decision changes. Full product spec: `docs/prd.md`. Component contracts: `.claude/specs/`. Background/architecture: `../docs/05-self-hosted-build-blueprint.md`.

## What this is
A self-hosted app: plain-English goal → LLM-extracted action graph → deterministic A\* GOAP plan → orchestrator dispatches each action to a headless coding-agent CLI → ground-truth verification → replanning → live view. **Local, single-operator**, self-hosted on a Proxmox LXC or VM.

**v1 = M1 (single-executor core):** Claude Code (`claude -p`) only, run **serially**; extract → plan → confirm definition of done → execute → verify → replan, with a minimal live view. Multi-executor (Codex, Antigravity) + per-step routing + parallelism + full dashboard are **M2 fast-follow**; pgvector memory is **M3**. See `docs/prd.md` §6/§12.

## Stack (decided)
- **Language:** TypeScript end-to-end.
- **Frontend:** React + Vite + Tailwind + shadcn/ui. Lift `goal_ui`'s MIT planner + plan-tree/state-card components liberally where they fit (keep license headers); build the real-event run view fresh.
- **Backend/orchestrator:** Node (Hono or Fastify); built on the **Claude Agent SDK** where useful.
- **DB:** Postgres + pgvector.
- **Realtime:** WebSocket/SSE.
- **Executors:** host-installed CLIs invoked headless. **v1: `claude` only**; `codex` + `agy` at M2.
- **Extraction LLM:** headless `claude -p` (subscription; no API key); strict JSON + zod repair; swappable behind a thin interface later.

## Repo layout
```
CLAUDE.md · AGENTS.md
.claude/specs/        # component contracts (read before implementing a component)
docs/                 # prd.md (source of truth) + decisions/ (ADRs, MADR) + design notes
backend/src/          # api/ planner/ extractors/ executors/ db/ mcp/
frontend/src/         # components/ pages/ lib/ (plan tree, dashboard, realtime)
tests/                # unit + integration + evals/ (vitest + fast-check; promptfoo for extractor)
```

**Repo root gotcha:** this project lives in `goal-gen/`, a *subdirectory* of the git repo rooted at the parent `yellow-goal/` (`git rev-parse --show-toplevel` → `yellow-goal`). Run `git`/`gt` from anywhere in the tree, but note: repo-level config (`.graphite.yml`, PR template) sits at the `yellow-goal` root, while project-local config (`.gitignore`, `.ruvector/`, `.claude/*.local.md`) lives in `goal-gen/`. Tools that probe `show-toplevel` for project files will look one level too high.

## Core invariants (do not violate)
1. **The planner is deterministic.** A\* over symbolic state; no LLM inside the planner. The LLM only *authors* the action graph (in the extractor) and *executes* steps (in executors). Replanning re-runs the deterministic planner; when the existing pool can't reach the goal, the extractor re-authors **additional** actions (append-only, bounded) — the *decision* to re-extract is deterministic (no-plan / N failures).
2. **World state comes from ground truth.** Set state from real exit codes / test output / diffs — never trust an action's declared effect.
3. **Every action has a `verify` check.** No verify → not executable.
4. **Executors are interchangeable** behind one `Executor` interface. The **extraction LLM runs via headless `claude -p`** (subscription; no API key) behind a thin interface so it can be swapped later. `claude -p` has **no server-side forced tool-use**, so strict JSON is prompt-enforced + **zod-repaired**, not guaranteed.
5. **Isolation:** each agent run gets its own git worktree — this is **collision-avoidance (never two writers on the same files), NOT a security sandbox**. In v1 the host LXC/VM is the blast radius; **per-run containers arrive at M2**.
6. **Guardrails are mandatory:** enforce max replans, max budget (USD), wall-clock, per-action retries, max re-extractions, and loop detection on every run. **Defaults (v1, overridable):** $20/run · 5 replans · ≤2 re-extractions · 60-min wall-clock · 3 retries/action · concurrency 1 · loop = same action fails the same way twice → stop & escalate.

## Conventions
- Types-first: define `GoalSpec`/`Action`/`WorldState`/`Plan` (see `.claude/specs/planner.md`) before logic; validate LLM output with **zod**.
- Spec-driven: read the relevant `.claude/specs/*.md` before implementing a component; if behavior must change, update the spec first. **Read the relevant ADR in `docs/decisions/` before changing a locked decision; supersede with a new ADR rather than editing an accepted one.**
- Small, pure functions in the planner; side effects only in executors/db.
- Secrets via environment only — never commit keys; never put secrets in this file.
- No destructive git ops (force-push, hard reset, branch delete) without explicit approval.

## Workflow (how to build this with Claude Code)
- Explore → **Plan Mode** for any multi-file work → code → commit; review diffs in a fresh subagent.
- Use **subagents in isolated worktrees** for parallel components.
- Track work with the task list; one component spec = one work stream.
- **Eval-driven:** keep `tests/evals/` (goal→expected-plan pairs); run before/after planner or prompt changes.

## Commands (M0 planner scaffolded; frontend/lint still TBD)
- Install: `npm install`
- Dev: `TBD` (frontend `vite`, backend watch — not scaffolded yet)
- Test: `npm test` (`vitest run`) · `npm run test:watch` (watch mode); planner properties via `fast-check`
- Evals: `npm run eval` (all) · `npm run eval:planner` (planner gate) — `vitest` over `tests/evals/`; extractor prompt eval via `promptfoo` (M0 part 2)
- Typecheck: `npm run typecheck` (`tsc --noEmit`, strict)
- Lint/format: `TBD` (not configured yet)

## Host
Runs on a dedicated **Proxmox LXC or VM** with Claude Code logged in once (v1); per-run worktrees (collision-avoidance, not a sandbox); **single-admin login**, reachable only on your own network/Tailscale — no LAN-wide or public exposure. A VM is cleaner if you'll run per-run containers at M2 (nesting in an unprivileged LXC needs extra config). See `docs/prd.md` §11.

## Docs to bookmark
Claude Agent SDK: https://platform.claude.com/docs/en/agent-sdk/overview · Claude Code headless: https://code.claude.com/docs/en/headless · Hooks: https://code.claude.com/docs/en/hooks · MCP: https://code.claude.com/docs/en/mcp
