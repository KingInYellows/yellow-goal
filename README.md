# GOAL — Goal-Oriented Action Planning for AI Agents

> A research-and-build knowledge base for **GOAP** (Goal-Oriented Action Planning) applied to software-development agents, the **ruv.io / RuFlo "GOAL" generator**, and a blueprint for building a **self-hosted** version wired to your own coding-agent subscriptions (Claude Code, Codex, Antigravity/Gemini).

**Last updated:** 2026-06-18
**Produced by:** a multi-agent research fan-out (4 parallel research streams) + primary-source verification. Citations are inline throughout each doc.

---

## What this is

This project answers three questions in depth:

1. **What is GOAP**, where did it come from, and how does the architecture actually work (state, goals, actions, the A\* planner, replanning)?
2. **How do "goals" work in modern LLM coding agents** (Claude Code, Codex, Antigravity), and how does classic GOAP map onto LLM agents and multi-agent coordination?
3. **How does `goal.ruv.io` work**, is it worth reusing, and **how would I build my own self-hosted version** that dispatches real work to my own agent subscriptions?

## The headline finding (read this first)

`goal.ruv.io` is **open-source (MIT)** and genuinely clever, **but the marketing copy describes a roadmap, not the shipped code.** Reading the actual source:

- The real, reusable core is small and good: a **~150-line client-side A\* GOAP planner** (`goapPlanner.ts`) plus **one** working Supabase Edge Function (`research-step`) that does web-grounded research via an LLM.
- The parts you actually care about — the **"live agent dashboard," "dispatch work to live agents," "wired to ~210 MCP tools," AgentDB/SONA learning** — are a **scripted mock-up** in the deployed demo (hard-coded agents animated with `setTimeout`, **zero** backend calls). They are the unbuilt roadmap (ruflo issue #1692), not working features.

**So the part you want — a GOAP plan that dispatches real work to your Claude Code / Codex / Antigravity subscriptions — does not exist in any forkable form yet.** You will build that execution layer regardless of which starting point you pick. Good news: driving those CLIs headlessly with your own subscription is well-supported, so the build is very achievable. Full analysis and recommendation in **[`docs/06-fork-vs-build-decision.md`](docs/06-fork-vs-build-decision.md)**.

## Document index

| # | File | What's inside |
|---|------|---------------|
| 01 | [`docs/01-goap-fundamentals.md`](docs/01-goap-fundamentals.md) | Classic GOAP theory: STRIPS → Orkin/F.E.A.R., world state, goals, actions (preconditions/effects/cost), the A\* planner, backward vs forward search, replanning, worked examples, comparison to HTN/BT/FSM/Utility AI, open-source implementations. |
| 02 | [`docs/02-goal-oriented-planning-in-llm-agents.md`](docs/02-goal-oriented-planning-in-llm-agents.md) | Planning patterns in LLM agents (ReAct, Plan-and-Execute, ToT, Reflexion), the AutoGPT/BabyAGI lineage and why it failed, how GOAP maps onto LLM agents, Claude Code & Codex & Antigravity planning internals, multi-agent coordination architectures, and the GOAP+LLM hybrid frontier. |
| 03 | [`docs/03-goal-ruv-io-analysis.md`](docs/03-goal-ruv-io-analysis.md) | Reverse-engineering of `goal.ruv.io` from its source: the real pipeline, the planner internals, the edge functions, the tech stack, what's real vs. mocked, and self-hosting facts. |
| 04 | [`docs/04-ruvnet-ecosystem-evaluation.md`](docs/04-ruvnet-ecosystem-evaluation.md) | Package-by-package evaluation of the ruvnet ecosystem (ruflo/claude-flow, goalie, ruv-swarm, flow-nexus, RuVector, etc.): maturity, license, usability, and what's worth reusing vs. avoiding. |
| 05 | [`docs/05-self-hosted-build-blueprint.md`](docs/05-self-hosted-build-blueprint.md) | Architecture/design spec for a self-hosted GOAL generator: data model, planner algorithm, the LLM↔planner split, the agent-execution layer, recommended stack, API, phased plan. |
| 06 | [`docs/06-fork-vs-build-decision.md`](docs/06-fork-vs-build-decision.md) | The decision: fork `goal_ui` vs. adopt the full RuFlo platform vs. build clean — with a recommendation — plus exactly how to wire in your Claude Code / Codex / Antigravity subscriptions. |
| 07 | [`docs/07-glossary-and-references.md`](docs/07-glossary-and-references.md) | Glossary of every term used, and the consolidated master reference list. |
| 08 | [`docs/08-development-readiness-and-plan.md`](docs/08-development-readiness-and-plan.md) | Pre-build documentation checklist (incl. PRD), spec-driven-development approach, the Claude Code bootstrapping workflow, and the open-decisions log. |

## Build-ready scaffold — `goal-gen/`

Seed for the actual application repo. Decisions locked: **v1 = M1 — a single executor (Claude Code `claude -p`), run serially**, with ground-truth verify + replanning and a minimal live view; multi-executor (Codex, Antigravity) + parallelism + full dashboard are **M2 fast-follow**. **TypeScript end-to-end**; **local, single-operator**, hosted on a **Proxmox LXC or VM**. Copy this folder out to start the repo.

| Path | What |
|------|------|
| [`goal-gen/docs/prd.md`](goal-gen/docs/prd.md) | Product Requirements Document — the source of truth for scope. |
| [`goal-gen/CLAUDE.md`](goal-gen/CLAUDE.md) | Repo memory / "constitution" for Claude Code. |
| [`goal-gen/AGENTS.md`](goal-gen/AGENTS.md) | Codex-compatible mirror of the rules. |
| [`goal-gen/.claude/specs/`](goal-gen/.claude/specs/) | Component contracts: `planner`, `goal-extractor`, `orchestrator`, `executor-router`, `api`, `dashboard`. |

## Suggested reading order

- **Want the concepts:** 01 → 02.
- **Want to decide what to build:** 03 → 04 → 06.
- **Want to start building:** 06 → 05 (then 01/02 as reference).

## A note on sources & confidence

Every doc preserves inline `[source](url)` citations. Where sources conflict or a claim is shaky (e.g., ruvnet's self-reported benchmarks and star counts, fast-moving CLI feature flags, provisional research citations), the docs say so explicitly rather than smoothing it over. Product facts (CLI flags, subscription auth, model names) were verified against vendor docs as of **June 2026** and will drift — re-check before relying on a specific flag.
