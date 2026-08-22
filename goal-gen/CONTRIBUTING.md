# Contributing / Dev setup

Solo, **spec-driven, eval-driven**. The short version: the spec is the source of truth, the eval set is the gate, and you read both before you code.

## Prerequisites
- **Node 22+** (`.nvmrc`).
- **M1+ only:** a host (Proxmox LXC/VM — ADR-0011) with `claude` logged in; Postgres for persistence. M0 (planner) needs neither.

## Setup
Run from `goal-gen/`:
```bash
nvm use
npm install
npm test            # full deterministic suite — everything passes, nothing skipped
npm run eval:planner
npm run typecheck
```

## The loop: explore → plan → code → commit
1. Read the relevant `.claude/specs/*.md` and any linked ADR in `docs/decisions/` **before** implementing.
2. Use **Plan Mode** for multi-file work; review the plan before editing.
3. Code **types-first**; validate all model output with **zod**.
4. Run `npm run eval:planner` and `npm test` — the eval set is the acceptance gate (plan-validity ≥ 98%).
5. Commit with a tight message that references the spec/ADR; review the diff (a fresh subagent is ideal).

## Hard rules (from CLAUDE.md / AGENTS.md)
- The **planner is deterministic** — no LLM inside it.
- **World state comes from real results** (exit codes/tests/diffs), never declared effects.
- **Every `Action` has a `verify`.**
- **Never edit a test, fixture, or `verify` to make it pass.** If you think a fixture is wrong, stop and flag it. If behavior must change, update the spec (and add/supersede an ADR) **first**.
- Secrets via env only; no destructive git ops without approval.

## Decisions
Locked decisions live in `docs/decisions/` (MADR). Changing one is a **new superseding ADR**, not an edit to an accepted one.

## Milestones (docs/prd.md §12)
**M0** planner + dynamic extraction (dry-run) — *done* → **M1** single `claude -p` executor end-to-end *(release bar)* — *done* → **M2** multi-executor + dashboard + container isolation → **M3** pgvector memory. The read-only **Repository Goal Packet Compiler** (contracts, inspector, evidence ledger, pack renderer, packet validator, CLI — see `.claude/specs/packet-compiler.md`) shipped alongside M1 as a separate subsystem.

## Git / repo root
The cleanest setup is to version the **whole `GOAL/` project** (research docs + `goal-gen/`) as one repo, so the PRD/spec cross-links to `../docs/01`–`08` keep resolving:
```bash
cd <GOAL project root>
git init && git add -A && git commit -m "chore: scaffold — specs, ADRs, planner eval harness"
```
Then run Claude Code and `npm` commands from `goal-gen/` (its `CLAUDE.md` is the agent memory). If you ever split `goal-gen/` into a standalone repo, copy the research `docs/` along (e.g. to `docs/research/`) and fix the relative links first.
