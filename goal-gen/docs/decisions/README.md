# Architecture Decision Records

Decisions for the GOAL Generator, recorded in [MADR](https://adr.github.io/madr/) format (lightweight, solo-tuned). One file per decision, four-digit sequential numbering. An ADR is **immutable once `accepted`** — to change a decision, add a new ADR that supersedes the old one (mark the old one `superseded by NNNN`).

**Read the relevant ADR before changing a locked decision** (see `CLAUDE.md` / `AGENTS.md`). The chain is: **PRD** (what/why) → **`.claude/specs/`** (component contract) → **ADR** (the decision + drivers) → **eval fixture / test** (the *Confirmation* that proves it's honored).

Template: [`_template.md`](_template.md).

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-use-madr-for-decisions.md) | Record architecture decisions using MADR | accepted |
| [0002](0002-typescript-stack.md) | TypeScript end-to-end stack + Postgres/pgvector | accepted |
| [0003](0003-vendor-goal-ui.md) | Vendor `goal_ui` (MIT) for UI + planner; build backend fresh | accepted |
| [0004](0004-deterministic-planner.md) | Deterministic A\* GOAP planner; no LLM inside | accepted |
| [0005](0005-v1-scope-m1.md) | v1 scope = M1 (single executor, serial, local single-user) | accepted |
| [0006](0006-extraction-via-claude-p.md) | Goal extraction via headless `claude -p` | accepted |
| [0007](0007-hybrid-replanning.md) | Hybrid replanning with bounded re-extraction | accepted |
| [0008](0008-completion-policy.md) | Definition of done via operator-confirmed `completionPolicy` | accepted |
| [0009](0009-worktree-isolation.md) | Worktrees = collision-avoidance, not a sandbox; containers at M2 | accepted |
| [0010](0010-guardrail-defaults.md) | Guardrail defaults & cap-trip behavior | accepted |
| [0011](0011-single-admin-auth.md) | Single-admin auth on a local Proxmox LXC/VM | accepted |
| [0012](0012-metrics-gate-vs-observed.md) | Success metrics: gate vs observed split | accepted |
| [0013](0013-eval-tooling.md) | Eval tooling: Vitest + fast-check + promptfoo | accepted |
| [0014](0014-defer-verifier-gaming-control.md) | Defer verifier-gaming control (test checksums) to M2 | accepted |
