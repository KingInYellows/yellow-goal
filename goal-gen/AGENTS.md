# AGENTS.md — GOAL Generator

Codex-compatible repo instructions (mirror of `CLAUDE.md`). If both are present, treat `CLAUDE.md` as canonical; this file exists so the Codex executor and other AGENTS.md-aware agents get the same rules. Direct prompts override this file.

## Project
Self-hosted GOAL generator: plain-English goal → LLM action-graph extraction → deterministic A\* GOAP plan → orchestrator dispatches actions to headless coding-agent CLIs → ground-truth verify → replanning → live view. TypeScript end-to-end; Postgres/pgvector; **local, single-operator**, self-hosted on a Proxmox LXC or VM. **v1 = M1: Claude Code (`claude -p`) only, serial** — implemented; Codex + Antigravity + parallelism + full dashboard are M2 fast-follow. A second, **read-only** subsystem — the Universal Repository Goal Packet Compiler (`npm run cli`: request → inspect → analyze → compile → packet verify, emitting verified `repository-goal-packet@1` ZIPs) — is also implemented; it never mutates target repositories and rejects unknown permission/orchestration profiles fail-closed (`.claude/specs/packet-compiler.md`). Product spec: `docs/prd.md`. Component contracts: `.claude/specs/`.

## Build / test
- Install: `npm install`
- Dev: `TBD` (not scaffolded yet)
- Test: `npm test` · `npm run test:watch` (watch mode) · Evals: `npm run eval` (all) / `npm run eval:planner` (planner gate) · Typecheck: `npm run typecheck`
- Compiler CLI: `npm run cli -- <subcommand>` · M1 runner: `npm run runner -- "<goal>"` (real cost)
- Lint/format: `TBD` (not configured yet)
Always run tests + the eval set before declaring a planner or prompt change done.

## Hard rules
1. Planner is deterministic (A\* over symbolic state); no LLM inside it. Replanning re-runs the planner; when the pool can't reach the goal, the extractor authors **additional** actions (append-only, bounded) — deciding to re-extract is deterministic.
2. Update `WorldState` from **real** results (exit codes/tests/diffs), not declared effects.
3. Every `Action` needs a `verify` check.
4. Keep executors behind one interface. The extraction LLM runs via headless `claude -p` (subscription; no API key) behind a thin interface, swappable later; `claude -p` has no forced tool-use, so strict JSON is zod-validated + repaired.
5. One git worktree per agent run; no two writers on the same files. Worktrees are **collision-avoidance, not a sandbox** — the host LXC/VM is the blast radius in v1; per-run containers at M2.
6. Enforce guardrails on every run: max replans, max budget USD, wall-clock, retries, max re-extractions, loop detection. Defaults: $20/run · 5 replans · ≤2 re-extractions · 60-min · 3 retries/action · concurrency 1; on trip → stop & escalate.
7. Secrets via env only; no destructive git ops without approval.

## Conventions
Types-first; validate model output with zod; read the relevant `.claude/specs/*.md` before implementing a component, and update the spec first if behavior must change.

## Scope note
v1 = **M1: single executor (Claude Code), serial**, with ground-truth verify + replanning (incl. bounded re-extraction), a minimal live view, and operator confirm-criteria/sign-off. Multi-executor (Codex, Antigravity), per-step routing, parallelism, and the full dashboard are **M2 fast-follow**; pgvector memory is **M3**. See `docs/prd.md` §6/§12.
