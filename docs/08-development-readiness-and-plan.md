# 08 — Development Readiness: Docs to Complete & How to Bootstrap with Claude Code

> What to write/decide **before** building, and how to bootstrap and run the build using Claude Code itself. Answers: "what planning should be complete?", "should we define a PRD?", "how do we bootstrap with claude-code?", and "what decisions are needed?"

**Related:** [`05-self-hosted-build-blueprint.md`](05-self-hosted-build-blueprint.md) (the technical design) · [`06-fork-vs-build-decision.md`](06-fork-vs-build-decision.md)

---

## 1. Where we are

Done: the research foundation (docs 01–04), a technical blueprint that's ~80% of a design doc (doc 05), the fork-vs-build decision + subscription-wiring approach (doc 06), and a glossary/references (doc 07).

The gap to "build-ready" is the **product/spec layer**: *what exactly* v1 does, the contracts each component must honor, the decisions captured as a record, and the repo memory that makes Claude Code productive. The good news from the research: for AI coding agents, **the spec is the highest-leverage artifact** — "AI coding agents require specifications that function as programming interfaces: precise enough to execute, structured enough to sequence, and constrained enough to prevent scope drift" ([How to write PRDs for AI Coding Agents](https://medium.com/@haberlah/how-to-write-prds-for-ai-coding-agents-d60d72efb797)).

---

## 2. Recommended pre-build documentation set

Priorities: **P0** = write before any code; **P1** = write during Phase 1; **P2** = nice-to-have / write as you go.

| Doc | Purpose | Status | Priority |
|---|---|---|---|
| **PRD** (`docs/prd.md`) | What & why: problem, users, use cases, **scope/non-goals**, functional requirements, **AI-specific success metrics**, acceptance criteria, risks. The single source of truth. | **Need** | **P0** |
| **Technical Design Doc** | How: architecture, data flow, component responsibilities. Doc 05 is a strong draft — promote/extend it. | Have draft (05) | **P0** |
| **Component specs** (`.claude/specs/*.md`) | Per-component contract: I/O schemas, error cases, acceptance tests — for goal-extractor, planner, orchestrator, executor-router, API, dashboard. **What Claude Code consumes.** | **Need** | **P0** |
| **CLAUDE.md** (repo root) | Project memory for Claude Code: stack, structure, commands, conventions, guardrails. Keep it tight (~50 lines). | **Need** | **P0** |
| **ADR log** (`docs/decisions/`, MADR) | Architecture Decision Records — one short file per decision with context, decision, consequences, confirmation. | **Have (0001–0014)** | **P1** |
| **Data model & schema spec** | DB schema + the `GoalSpec`/`Action` JSON schema (zod). | Partial (05 §3) | **P1** |
| **API contract** | REST endpoints + WebSocket event types. | Partial (05 §9) | **P1** |
| **Test & eval plan** | Unit (planner), integration (mock executors), e2e (real agents), and an **eval set** of goals→expected plans with thresholds + regression CI. | **Need** | **P1** |
| **Security & guardrails doc** | Secrets handling, the subscription-auth host model, sandbox/worktree isolation, cost/loop/replan limits, permission modes. | Partial (05 §11, 06 §3) | **P1** |
| **Milestones & task breakdown** | Phases (05 §10) → concrete tasks with a definition of done per phase. | Partial (05 §10) | **P1** |
| **AGENTS.md** | Codex-compatible repo instructions (mirror of CLAUDE.md for the Codex executor). | **Need** | **P2** |
| **Prompt library** | The goal-extractor prompt, replan prompt, per-executor prompt templates — versioned. | **Need** | **P2** |
| **Observability/runbook** | Telemetry schema, dashboards, ops runbook. | **Need** | **P2** |
| **Glossary** | Shared vocabulary. | Have (07) | ✅ |

**Minimum to start building (P0):** PRD + the existing design doc (05) + a first pass of component specs + CLAUDE.md. Everything else can be filled in during Phase 1.

---

## 3. Spec-driven development (SDD) — the approach to adopt

SDD treats the **spec as the source of truth and code as its output** — a direct answer to "vibe coding" drift, and especially valuable when agents write the code. By 2026 every major tool ships an SDD flavor (GitHub Spec Kit, AWS Kiro, BMAD, OpenSpec, Claude Code, Antigravity) ([SDD 2026 guide](https://thebcms.com/blog/spec-driven-development); [9 best SDD tools 2026](https://www.marktechpost.com/2026/05/08/9-best-ai-tools-for-spec-driven-development-in-2026-kiro-bmad-gsd-and-more-compare/)).

**Frameworks (for awareness):**
- **GitHub Spec Kit** — a "constitution" (immutable project rules) + spec workflow; lightweight, tool-agnostic.
- **BMAD-METHOD** — MIT, ~46.7k stars, v6.6.0 (Apr 2026); orchestrates 12+ role-based agents (analyst, PM, architect, dev, QA) across the full lifecycle. Powerful but heavyweight.
- **OpenSpec / cc-sdd / Kiro / GSD** — other flavors; cc-sdd is a minimal SDD harness specifically for Claude Code.

**Recommendation for this project:** **stay lightweight.** Don't adopt a heavy framework (BMAD) for a solo/small build — the overhead outweighs the benefit. Instead:
1. A concise **CLAUDE.md** as your "constitution" (rules every session inherits).
2. Per-component **specs in `.claude/specs/`** that the build agents read before implementing.
3. The **PRD** as the product-level source of truth that the specs derive from.

You can borrow Spec Kit's "constitution" idea and BMAD's role split (use Claude Code **subagents** as the architect/dev/QA roles) without taking the dependency.

---

## 4. Bootstrapping the build with Claude Code

Distilled from current Anthropic docs and 2026 practice (flag: CLI flags/SDK APIs move fast — verify specifics against [code.claude.com](https://code.claude.com/docs/en/overview) / [platform.claude.com](https://platform.claude.com/docs/en/agent-sdk/overview) when you start).

**4.1 Initialize.** Run **`/init`** in the repo root to generate a starter **CLAUDE.md** (it inspects the repo and infers stack/commands; if CLAUDE.md exists it suggests improvements). Then hand-tighten it. CLAUDE.md best practices: keep it short (~50 lines), include stack + repo layout + build/test commands + conventions + guardrails, **reference env vars, never embed secrets**, and update it after each architectural decision.

**4.2 The core loop: explore → plan → code → commit.**
- **Explore** (read-only; the `Explore` subagent) to map context.
- **Plan Mode** (`Shift+Tab` / `/plan`) for any non-trivial, multi-file work — design before editing; review the plan; then switch to an edit mode. Pro tip: after a big plan session, have a **fresh subagent review the final diff** to catch what the main context missed.
- **Code** with task tracking (`TaskCreate`/task list) decomposing the goal into trackable steps.
- **Commit** with a review pass.

**4.3 Subagents for parallelism.** Define subagents in `.claude/agents/*.md`; use them for parallel exploration, **isolated git worktrees** (`isolation: worktree`) so concurrent work doesn't collide, and fresh-context reviews. This mirrors the orchestrator-worker pattern your *product* uses — you'll build the app the same way the app works.

**4.4 Build the orchestrator on the Claude Agent SDK (TypeScript).** The SDK gives you the same loop that powers Claude Code — `query()`/sessions, subagents, **hooks**, **permission modes**, and an **MCP client** — programmatically. This is the natural foundation for your executor that shells out to `claude -p` (and a clean place to enforce guardrails). Bookmark the [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview), [quickstart](https://platform.claude.com/docs/en/agent-sdk/quickstart), and [TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript).

**4.5 MCP for the executor-router.** Expose the "dispatch action → CLI" and "read/write world state" capabilities as a small **MCP server** (registered in `.mcp.json`, checked into the repo). Use **stdio** for local, **HTTP** for remote (SSE is deprecated). Rule of thumb: MCP for the **dispatcher + state**, plain shell-out for the actual CLI execution. ([Connect Claude Code to MCP](https://code.claude.com/docs/en/mcp))

**4.6 Eval-driven development + guardrails.** Build a small **eval set** (10–20 goal→expected-plan pairs) *before* implementing the planner; score every change against it; wire it into CI to catch regressions. Use **hooks** + **permission modes** as deterministic guardrails: `PreToolUse` to block dangerous commands, a cost-tracking `PostToolUse` to halt at a budget, plan-mode for read-only phases, and hard caps on replan depth / wall-clock (the AutoGPT lesson from [doc 02 §1.5](02-goal-oriented-planning-in-llm-agents.md)). ([Hooks reference](https://code.claude.com/docs/en/hooks))

**4.7 Suggested repo layout:**
```
goal-gen/
├── CLAUDE.md                # repo memory (constitution)
├── AGENTS.md                # Codex-compatible mirror (P2)
├── .mcp.json                # MCP server registrations
├── .claude/
│   ├── agents/              # subagent roles (architect / dev / reviewer)
│   └── specs/               # per-component specs (P0)
├── docs/                    # this knowledge base + prd.md + decisions/ (ADRs)
├── backend/                 # Node orchestrator: api / planner / extractors / executors / db / mcp
└── frontend/                # React/Vite: plan tree, dashboard, realtime
```

---

## 5. Decision log (resolved 2026-06-23)

The choices that unblock the PRD + specs, as decided. PRD §14 is the canonical record.

1. **MVP scope (v1).** **M1 — one real executor end-to-end:** a goal planned *and actually executed* by `claude -p`, serial, with ground-truth verify + replanning (incl. bounded re-extraction) and a minimal live view. Multi-executor + dashboard + parallelism = **M2 fast-follow**; memory = **M3**.
2. **Subscriptions / sequence.** **Claude Code first** (v1), then Codex, then Antigravity (M2).
3. **Orchestrator host (auth/execution boundary).** A dedicated **Proxmox LXC or VM**, single-user behind a **simple admin login**, no LAN-wide/public exposure. Worktrees in v1 (not a sandbox); **per-run containers at M2** (a VM is cleaner for nested containers).
4. **Definition of done.** Per-goal **`completionPolicy`** (`verify-only | verify+signoff | operator-defined`) recommended by the extractor and **confirmed by the operator** before the run; sign-off gate on completion when required.
5. **Stack.** **TypeScript end-to-end** (React/Vite + Node + Postgres/pgvector).
6. **Repo & license posture.** **Fresh private repo** that vendors `goal_ui`'s MIT planner/components **with attribution** (keep MIT headers); lift liberally, build the run view fresh; revisit open-sourcing later.
7. **LLM for the goal-extractor.** **Headless `claude -p`** on the subscription (no API key); strict JSON + zod repair; swappable behind a thin interface later.
8. **Memory tier.** **Postgres + pgvector**; retrieval-augmented extraction at **M3**; consider RuVector later ([doc 04 §3](04-ruvnet-ecosystem-evaluation.md)).
9. **Observability / cost.** Live per-run tokens/cost in v1; historical cost dashboards at M3.

---

## 6. Suggested path to "build-ready"

1. Answer the four starred decisions above.
2. I draft **`docs/prd.md`** (with AI-specific success metrics + acceptance criteria), a tightened **CLAUDE.md**, and first-pass **`.claude/specs/`** for planner + goal-extractor + orchestrator.
3. Write the **eval set** (goal→expected-plan pairs) and the **ADR log** seeded from decisions already made.
4. Begin [doc 05](05-self-hosted-build-blueprint.md) Phase 1 (planner + dynamic extraction, dry-run executors) using the Claude Code loop above.

---

## Sources

- Claude Code: [overview](https://code.claude.com/docs/en/overview) · [best practices](https://code.claude.com/docs/en/best-practices) · [memory/CLAUDE.md](https://code.claude.com/docs/en/memory) · [hooks](https://code.claude.com/docs/en/hooks) · [MCP](https://code.claude.com/docs/en/mcp)
- Agent SDK: [overview](https://platform.claude.com/docs/en/agent-sdk/overview) · [quickstart](https://platform.claude.com/docs/en/agent-sdk/quickstart) · [TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript)
- SDD: [Definitive 2026 guide](https://thebcms.com/blog/spec-driven-development) · [9 best SDD tools 2026](https://www.marktechpost.com/2026/05/08/9-best-ai-tools-for-spec-driven-development-in-2026-kiro-bmad-gsd-and-more-compare/) · [BMAD vs Spec Kit vs OpenSpec](https://medium.com/@reenbit/bmad-vs-spec-kit-vs-openspec-choosing-your-spec-driven-ai-framework-in-2026-a6996b3ebb8d) · [cc-sdd](https://github.com/gotalab/cc-sdd)
- PRDs for AI: [PRDs for AI coding agents](https://medium.com/@haberlah/how-to-write-prds-for-ai-coding-agents-d60d72efb797) · [AI PRD template (OpenAI PM)](https://www.productcompass.pm/p/ai-prd-template)
