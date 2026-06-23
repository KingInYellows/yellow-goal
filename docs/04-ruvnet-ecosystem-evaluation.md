# 04 — The ruvnet Ecosystem: What's Worth Reusing

> A package-by-package evaluation of `github.com/ruvnet` and related npm/crates packages, judged for usefulness in building a **self-hosted GOAP/GOAL agent-orchestration system**.

**Related:** [`03-goal-ruv-io-analysis.md`](03-goal-ruv-io-analysis.md) · [`06-fork-vs-build-decision.md`](06-fork-vs-build-decision.md)

---

## 0. TL;DR

The ruvnet ecosystem is the personal output of **Reuven Cohen ("rUv" / ruvnet)** — ~165 GitHub repos, ~82 crates, big claimed download numbers. It is **enormous, fast-moving, marketing-heavy, and single-maintainer**. The flagship — **claude-flow**, now rebranded **RuFlo** — is the only mature, well-documented, actively-maintained piece, and it directly contains a GOAP planner (the `ruflo-goals` plugin + the hosted `goal.ruv.io` UI). A standalone GOAP research tool (**`goalie`**) also exists but is tiny. Most other repos (ruv-FANN, ruv-swarm, flow-nexus, sublinear-time-solver, SAFLA, QuDAG) are interesting but immature, tangential, or — for flow-nexus — proprietary.

**Credibility flags up front (take all self-reported metrics skeptically):**
- **Inconsistent star counts** for the same repo (pinned card says ruflo = 23.6k; live header says ~60k; a directory listing says 59.9k; the README badge points at the *old* claude-flow repo).
- **Grandiose framing** in the maintainer's own materials ("dropping the equivalent of Edison's lifetime of patents in a weekend," crates described as "quantum consciousness voice interface").
- **Aggressive, unaudited benchmark claims** ("1.3×–1953× faster than LangGraph/AutoGen/CrewAI," "84.8% SWE-Bench").
- **Rapid renames** (claude-flow → ruflo mid-stream) and **pervasive alpha sub-dependencies**.

None of that means the code is fake — it's real, published, npm-signed, and installable. It means: **pin exact versions, verify load-bearing claims yourself, and run it sandboxed first.**

---

## 1. RuFlo / claude-flow (the flagship) — **worth exploring**

**RuFlo *is* claude-flow, renamed.** The npm `claude-flow` package's own description now reads *"Ruflo - Enterprise AI agent orchestration for Claude Code,"* and the README states "Claude Flow is now Ruflo." Same git repo.

| Field | Detail |
|---|---|
| **Purpose** | A multi-agent orchestration **meta-harness layered on top of Claude Code**: swarms, persistent vector memory, self-learning, hooks/daemon, federation, and an MCP server exposing agent-coordination tools. Also ships a **Codex plugin** (`@claude-flow/codex`). |
| **Stack** | TypeScript (Node ≥20), ES modules; pulls in WASM-backed Rust components for vector search & neural routing. Web UI is Svelte/Vite + MongoDB, shipped as Docker. |
| **Install** | **(A) Claude Code plugins:** `/plugin marketplace add ruvnet/ruflo` → `/plugin install ruflo-core@ruflo` (slash commands + agent defs only — **no MCP server, no hooks**). **(B) Full CLI:** `npx ruflo@latest init wizard`, or the install script. MCP: `claude mcp add ruflo -- npx ruflo@latest mcp start`. |
| **License** | **MIT** |
| **Maturity** | The most mature thing in the ecosystem. Stable **claude-flow@3.10.1** on npm (npm-signed, ~51 MB unpacked). Wiki has 17+ pages + 130 ADRs. High commit velocity. Stars disputed (~23.6k–60k). |

**What you get:** 60–100+ specialized agents; ~26 CLI commands; "**314 MCP tools**" (memory, swarm, neural routing, embeddings, security); swarm coordination with hierarchical/mesh/adaptive topologies + consensus (Raft/Byzantine/Gossip); HNSW vector memory ("AgentDB"); SONA self-learning + "ReasoningBank" trajectory learning; 17 hooks + 12 background workers; agent federation; "witness verification" (`ruflo verify`).

**The Goal-Module (most relevant to you), two parts:**
- **`ruflo-goals` plugin** ([README](https://raw.githubusercontent.com/ruvnet/ruflo/main/plugins/ruflo-goals/README.md)): "Long-horizon goal planning, deep research orchestration, and adaptive replanning." Ships a **`goal-planner` agent** ("GOAP specialist with A\* planning and trajectory learning") and a **`goal-plan` skill** ("Create and execute GOAP action plans"), plus `deep-researcher`, `horizon-tracker`, `dossier-investigator`. Persists across sessions via AgentDB namespaces. Install: `/plugin install ruflo-goals@ruflo`. **This is the closest existing "GOAL generator" component.**
- **`goal.ruv.io` UI** — the self-hostable front-end analyzed in detail in [doc 03](03-goal-ruv-io-analysis.md).

**Claude Code / Codex integration:** distributed as a Claude Code plugin marketplace + MCP server, plus the Codex plugin. After `init`, hooks auto-route tasks, spawn agents, and feed successful patterns into memory. Multi-provider routing (Claude, GPT, Gemini, Cohere, Ollama).

**Risks:** heavy footprint (writes a daemon, hooks, many files into your workspace; large dep tree); the plugin-vs-CLI split is a foot-gun (the lite plugin path silently gives you *no* MCP tools); rapid version churn; unverifiable benchmark/star claims; single maintainer. But: MIT, signed, Dockerized, real docs.

> **Note on the `ruflo` npm package itself:** confusingly, the literal `ruflo` package is a **thin alpha wrapper** (v3.7.0-alpha.x, single dependency `@claude-flow/cli`) whose metadata still points at claude-flow. **Pin `claude-flow@3.10.x` for reproducibility — not `ruflo@latest` or `@alpha`.**

---

## 2. `goalie` — the standalone GOAP tool — **reference-grade**

The direct answer to "is there an installable GOAP planner?": **yes, `goalie`** — but it's a GOAP-driven *research agent*, not a generic reusable library.

| Field | Detail |
|---|---|
| **Purpose** | "AI-powered research assistant with GOAP planning, advanced reasoning, MCP protocol support, and Perplexity API integration." |
| **Artifacts** | **npm `goalie` v1.3.x** (TypeScript, MIT, Node ≥18) is the real implementation. **crates.io `goalie`** is just a ~41-line Rust shim that shells out to `npx goalie`. |
| **Install** | `npx goalie` / `npm i -g goalie`; or `cargo install goalie` (the wrapper). Repo [`github.com/ruvnet/goalie`](https://github.com/ruvnet/goalie). |
| **Maturity** | Young (created Sep 2025), low downloads, single maintainer, thin docs. |
| **Usability** | **Read its source** to understand a minimal "plain-English goal → GOAP plan → execute via MCP tools" loop — conceptually exactly your GOAL-generator pattern. **Don't take a hard dependency** (young, Perplexity-coupled, research-specific). |

There is **no clean standalone reusable GOAP library** from ruvnet (no `npm i goap-core`) — the planning logic is embedded in agents/apps. (Ecosystem-wide, crates.io shows only ~11 crates tagged `goap`; it's a thin space generally — see [doc 01 §7](01-goap-fundamentals.md) for the better game-AI implementations to read as spec.)

---

## 3. Component candidates — **maybe, for specific layers**

- **RuVector** ([repo](https://github.com/ruvnet/RuVector)) — Rust real-time self-learning **vector + graph neural DB** (~3.5k stars). The engine behind RuFlo's AgentDB/memory. **The most relevant sub-component if you want a self-hosted vector memory tier** (Graph RAG). Worth a look for the memory layer.
- **agentic-flow** ([repo](https://github.com/ruvnet/agentic-flow)) — "switch between low-cost AI models in Claude Code / Agent SDK" + deploy hosted agents (TS, ~563 stars). Relevant if your GOAL generator needs **multi-model routing / provider failover**. Optional dep of claude-flow.

---

## 4. Reference-only / avoid

| Package | Verdict | Why |
|---|---|---|
| **flow-nexus** ([repo](https://github.com/ruvnet/flow-nexus)) | **Avoid for self-hosting** | "First competitive *agentic* platform on MCP" — a gamified, **credit-based hosted SaaS** with **Proprietary license** and Supabase/E2B cloud lock-in. Antithetical to self-hosting. Useful only as a reference for the sandboxed-agent pattern. |
| **ruv-FANN** ([repo](https://github.com/ruvnet/ruv-FANN)) | Reference-only | Pure-Rust neural-net lib (MIT/Apache-2.0, ~338 stars). Niche; a GOAP orchestrator doesn't need a from-scratch NN lib. |
| **ruv-swarm** | Reference-only | WASM neural swarm orchestration (MIT/Apache-2.0, v1.x). More mature than ruv-FANN but **superseded in practice** by the `@ruvector` stack inside RuFlo; overlapping/confusing. |
| **sublinear-time-solver** ([repo](https://github.com/ruvnet/sublinear-time-solver)) | Skip | Rust+WASM linear-system solver powering RuFlo's "complexity-aware execution." **Has an open "Arbitrary File Write Vulnerability" issue.** Niche/experimental. |
| **SAFLA** ([repo](https://github.com/ruvnet/SAFLA)) | Reference-only | Python "self-aware feedback loop" autonomous system. Conceptually adjacent (self-improving agent); separate Python stack. |
| **QuDAG** ([repo](https://github.com/ruvnet/QuDAG)) | Skip (unless you need it) | Rust quantum-resistant DAG anonymous comms / "darknet for agent swarms." Only matters if you want federated/anonymous agent comms. |
| **SPARC / `ruflo-sparc`** | Pattern, not dependency | A development *methodology* (Specification → Pseudocode → Architecture → Refinement → Completion) baked into RuFlo. Useful as a structured-workflow idea. |

---

## 5. Recommendation

**Top 3 worth exploring (priority order):**

1. **RuFlo / claude-flow** — *pin `claude-flow@3.10.x`.* The only mature, MIT, documented, self-hostable GOAP+orchestration system here, and its `goal-planner` agent + `goal.ruv.io` UI are a near-exact match for "a self-hosted GOAL generator." **Use it as your primary reference architecture and (optionally) prototype substrate.** Adopt a *subset* deliberately — you do **not** need all 314 MCP tools or the federation/neural/IoT plugins. Run it sandboxed first.
2. **`goalie`** — *reference / lightweight prototype.* Cleanest small end-to-end "goal → GOAP plan → MCP tool execution" loop. Read the source; don't depend on it.
3. **RuVector (+ optionally agentic-flow)** — *component candidates* for a self-hosted vector/graph memory tier and multi-model routing, respectively.

**Cross-cutting risks to carry into any decision:** single-maintainer (bus-factor = 1); rapid renames & churn (**always pin exact versions**); marketing ≫ verification (don't trust the benchmarks/star counts); heavy footprint + large supply chain (mitigated somewhat by npm signing and an active security-`overrides` block).

> The practical consequence for your build: RuFlo is the best **map** of the territory and the best source of **reference implementations**, but its value-as-a-dependency is highest for narrow pieces (the goal_ui front-end, the goal-planner skill's methodology, maybe RuVector for memory). For the part you actually care about — your *own* subscriptions executing real work — you're building that regardless. See [doc 06](06-fork-vs-build-decision.md).

---

## Key sources

- RuFlo repo + README: [github.com/ruvnet/ruflo](https://github.com/ruvnet/ruflo) · [README (raw)](https://raw.githubusercontent.com/ruvnet/ruflo/main/README.md) · [Wiki](https://github.com/ruvnet/ruflo/wiki)
- `ruflo-goals` plugin: [README](https://raw.githubusercontent.com/ruvnet/ruflo/main/plugins/ruflo-goals/README.md)
- npm: [`claude-flow@3.10.1`](https://registry.npmjs.org/claude-flow/latest) · [`ruflo`](https://registry.npmjs.org/ruflo/latest) · [`ruv-swarm`](https://registry.npmjs.org/ruv-swarm/latest) · [`flow-nexus`](https://registry.npmjs.org/flow-nexus/latest) · [`goalie`](https://registry.npmjs.org/goalie/latest)
- Repos: [ruv-FANN](https://github.com/ruvnet/ruv-FANN) · [RuVector](https://github.com/ruvnet/RuVector) · [agentic-flow](https://github.com/ruvnet/agentic-flow) · [SAFLA](https://github.com/ruvnet/SAFLA) · [QuDAG](https://github.com/ruvnet/QuDAG) · [sublinear-time-solver](https://github.com/ruvnet/sublinear-time-solver) · [goalie](https://github.com/ruvnet/goalie)
- Maintainer profile: [github.com/ruvnet](https://github.com/ruvnet)
