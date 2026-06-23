# 02 — Goal-Oriented Planning in LLM Coding Agents

> How "goals" and planning work in modern LLM agents (Claude Code, Codex, Antigravity), how classic GOAP maps onto them, how multiple agents coordinate, and the GOAP+LLM hybrid frontier.

**Related:** [`01-goap-fundamentals.md`](01-goap-fundamentals.md) (the symbolic baseline) · [`05-self-hosted-build-blueprint.md`](05-self-hosted-build-blueprint.md) (how we use all this)

---

## 0. The substrate: what "planning" means for an LLM agent

Anthropic's distinction between **workflows** and **agents** is the cleanest backbone ([Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)):

- **Workflows** = "systems where LLMs and tools are orchestrated through **predefined code paths**."
- **Agents** = "systems where LLMs **dynamically direct their own processes and tool usage**."

An agent is "just an LLM using tools based on environmental feedback **in a loop**," and it's "crucial for the agents to gain 'ground truth' from the environment at each step (such as tool call results or code execution)," with stopping conditions to maintain control.

That one sentence — **LLM picks a tool call in a loop, grounded by environment feedback, until a stop condition** — is the substrate. Everything below is a variation on *how the loop is structured, where planning happens, and how multiple loops coordinate.*

---

## 1. Planning patterns in LLM agents

### 1.1 ReAct (Reason + Act) — the default loop
[Yao et al., arXiv:2210.03629](https://arxiv.org/abs/2210.03629). Interleaves reasoning "thoughts" with actions: `Thought → Action → Observation → Thought → …`. Reasoning traces "help the model induce, track, and update action plans," while actions ground it against an environment. **Planning style: emergent** — the plan is never a separate artifact; it's re-derived token-by-token. This is the loop most production agents (Claude Code, Codex) actually run.

### 1.2 Plan-and-Execute — the GOAP-shaped pattern
A **planner** LLM produces a full multi-step plan up front; an **executor** runs each step (often a ReAct agent per step); the planner may **replan** with results ([LangGraph plan-and-execute tutorial](https://langchain-ai.github.io/langgraph/tutorials/plan-and-execute/plan-and-execute/)). **Planning style: explicit** — a discrete plan artifact exists before execution. Motivations: forces explicit up-front reasoning, and lets a big model plan while a cheap model executes (cutting cost/latency). **This planner/executor split is the closest LLM-native analogue to classical GOAP.** (Related: *Plan-and-Solve* prompting, [Wang et al., arXiv:2305.04091](https://arxiv.org/abs/2305.04091).)

### 1.3 Tree-of-Thoughts, least-to-most, decomposition
- **Tree-of-Thoughts** ([Yao et al., arXiv:2305.10601](https://arxiv.org/abs/2305.10601)): generalizes CoT into a **search tree over thoughts** with self-evaluation, lookahead, and backtracking. On Game of 24, GPT-4 went from 4% (CoT) to **74%** (ToT). The LLM pattern that most resembles explicit search — but the "graph" is over free-text thoughts scored by the LLM, not a formal state space.
- **Least-to-most** ([Zhou et al., arXiv:2205.10625](https://arxiv.org/abs/2205.10625)): decompose into ordered subproblems, then solve sequentially feeding each answer forward. The direct ancestor of "break the goal into a TODO list."

### 1.4 Reflexion / self-critique / replanning
[Shinn et al., arXiv:2303.11366](https://arxiv.org/abs/2303.11366): after a failure, the agent **verbally reflects** and stores the reflection in episodic memory "to induce better decision-making in subsequent trials." Anthropic's productized version is the **evaluator-optimizer** workflow (one LLM generates, another critiques, in a loop). **Replanning is the recovery half of robust planning** — and the LLM analogue of GOAP's deterministic re-plan-on-failure.

### 1.5 The autonomous-goal-agent lineage (and why it failed)

Within ~2 weeks of GPT-4 (March 2023), **AutoGPT** and **BabyAGI** showed you could wrap a frontier LLM in a loop, hand it a goal, and let it spawn its own subtasks:

- **AutoGPT** ([repo](https://github.com/Significant-Gravitas/AutoGPT)): user gives a role + up to 5 goals; each loop the LLM emits a fixed JSON schema (`thoughts{text, reasoning, plan, criticism}` + `command`); results append to FIFO + vector memory. Decomposition was **emergent**, not an upfront plan.
- **BabyAGI** ([repo](https://github.com/yoheinakajima/babyagi)): ~140 lines — an **execution agent**, a **task-creation agent**, and a **prioritization agent** cycling over a task deque, with Pinecone memory.

**Why they failed as products** (the honest retrospective):
- **Infinite loops / non-termination** — the most-cited failure (a task running 300+ API calls with no output).
- **Goal loss / context limits** — "finite context window… go off the rails" (Karpathy); no durable long-term memory.
- **Compounding errors / hallucinated progress** — "relies on its own feedback, which can compound errors."
- **Cost**, and **rarely completing complex real-world tasks**.

**The lessons that shaped today's agents** (and this project): scoped/concrete goals over "do anything"; **strong external grounding** (tests, compilers, type-checkers as the verify step); human-in-the-loop checkpoints; **hard iteration/cost budgets** and loop detection; constrained, composable workflows over recursive free-running autonomy. AutoGPT itself pivoted to a low-code "blocks" platform marketed for *predictable execution* — the opposite of the original.

---

## 2. Mapping classical GOAP onto LLM agents

An LLM coding agent is **GOAP-shaped** — goal → decompose into a sequence of tool-actions with implicit preconditions/effects → execute → replan on failure — **but the planning mechanism is fundamentally different.**

| GOAP concept | LLM-agent analogue | Where it holds | Where it breaks |
|---|---|---|---|
| **Goal state** (predicates) | NL objective / Codex `/goal` definition-of-done / TODO end-condition | Both are "the thing to achieve" | LLM goal is a fuzzy string with no formal satisfaction check |
| **Actions** (precond→effect, cost) | **Tools** the agent can call | Tools are the action repertoire | Preconditions/effects/cost are **implicit**, not declared or verified |
| **World state** | **Context window / memory / files / git status** | Both represent "what's true now" | LLM state is unstructured, lossy, context-bounded |
| **Planner (A\*)** | LLM choosing the next tool call (ReAct) or an explicit planner LLM | Both produce an action sequence | The LLM does **not** run A\* over a discrete graph; it samples a plausible next step — no optimality, completeness, or termination guarantee |
| **Replanning** | Reflexion / re-prompt with the error | Both react to failures | GOAP replans deterministically; LLM replanning is stochastic, may loop |
| **Decoupling actions from control** | Tool definitions vs. the agent loop | Strong parallel (good tool design ≈ clean action authoring) | — |

**The core takeaway:** GOAP's strengths (optimality, completeness, fast deterministic replanning, a legible plan tree) are exactly the LLM's weaknesses on long horizons; the LLM's strengths (open-vocabulary goals, common-sense priors, no hand-authored action model) are exactly GOAP's limitations. **That complementarity is the entire reason to combine them** (see §5).

---

## 3. Goals & planning in the three coding agents you want to wire in

> Product facts verified against vendor docs as of **June 2026**; feature flags and model names move fast — re-check before relying on a specific flag. See [`06-fork-vs-build-decision.md`](06-fork-vs-build-decision.md) for how to drive each one headlessly with your subscription.

### 3.1 Claude Code & the Claude Agent SDK (Anthropic)

The agentic loop is **"gather context → take action → verify work → repeat"** ([Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)). Relevant planning machinery:

- **Plan Mode** — a read-only permission mode: Claude researches and proposes a plan without editing source (`Shift+Tab` to cycle, or `--permission-mode plan`). Backed by `EnterPlanMode`/`ExitPlanMode` tools; exploration is delegated to a read-only **Plan** subagent in its own context ([permission modes](https://code.claude.com/docs/en/permission-modes)).
- **Task tracking** — a structured checklist decomposes a goal into trackable steps. **Version note:** the older `TodoWrite` tool was disabled by default as of v2.1.142 in favor of `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate`, which add **dependencies** between tasks and fire `TaskCreated`/`TaskCompleted` hooks ([tools reference](https://code.claude.com/docs/en/tools-reference)).
- **Subagents** — specialized assistants, each in its own **isolated context window**; the parent only sees the subagent's final summary. Delegation is **automatic** based on the subagent's `description` ([sub-agents](https://code.claude.com/docs/en/sub-agents)).
- **The Agent tool** (renamed from **Task** in v2.1.63) spawns subagents; spawn several in parallel for independent work, then synthesize.
- **Hooks** — deterministic shell/HTTP/prompt callbacks at lifecycle points (`PreToolUse` can *block* a call, `Stop` can prevent stopping). They "run in your application process, not inside the agent's context window." **Hooks are the deterministic guard layer around the stochastic loop — the closest thing to enforcing real GOAP preconditions.**
- **Skills** — `SKILL.md` files with progressive disclosure (descriptions always loaded; full content on demand).
- **The multi-agent research system** ([How we built it](https://www.anthropic.com/engineering/multi-agent-research-system)) is the flagship orchestrator-worker case study: a LeadResearcher plans, **saves the plan to memory**, spawns parallel subagents, synthesizes. Findings: **+90.2%** over single-agent on their eval; **token usage explains 80%** of the variance (multi-agent uses ~15× chat tokens); great for breadth/parallel work, bad for tightly-dependent tasks ("most coding tasks involve fewer truly parallelizable tasks than research").
- **The Claude Agent SDK** (renamed from Claude Code SDK, Sep 2025) exposes the same loop programmatically: `query()`, subagents via `agents`, orchestration tools (`Agent`, `Skill`, `AskUserQuestion`, `TaskCreate`/`TaskUpdate`), hooks, sessions, and loop controls (`max_turns`, `max_budget_usd`, `permission_mode`). **This is the most natural SDK for building a GOAP executor that drives Claude.**

### 3.2 OpenAI Codex

(The 2025–2026 agentic Codex — not the deprecated 2021 model.) Surfaces: **Codex CLI** (open-source, Rust, Apr 2025), **Codex cloud**, IDE extension, and a **Codex SDK**. The loop: "calls the model, performs the indicated actions (file reads/edits, tool calls), repeats until done"; cloud tasks run in isolated containers, run tests/linters, iterate until green, and cite logs as evidence ([Prompting – Codex](https://developers.openai.com/codex/prompting)).

**Planning is explicit and three-layered** — the richest of any shipping agent:
1. **`update_plan` tool** — an always-on TODO/checklist (made default by [PR #5384](https://github.com/openai/codex/pull/5384)). Analogue to Claude Code's task list.
2. **`/plan` mode** — read-only; "propose an execution plan before implementation work starts" (Shift+Tab; streams a `<proposed_plan>` you approve).
3. **`/goal` mode** — "a persistent objective… a clear **definition of done** that it can keep checking as it works. The goal text acts as both the starting prompt and the completion criteria." **This `/goal` definition-of-done is the closest thing in any shipping coding agent to a GOAP-style explicit goal predicate.**

Autonomy via approval modes (Read-only / Auto / Full Access). Repo instructions live in **`AGENTS.md`** (open standard at [agents.md](https://agents.md)). Parallelism via cloud sandboxes and `codex cloud exec --attempts`; **subagents only spawn on explicit request** (unlike Claude Code's auto-delegation).

### 3.3 Google Antigravity CLI (Gemini)

**Important, time-sensitive fact:** Google has **retired Gemini CLI and replaced it with Antigravity CLI** (`agy`), a Go-based terminal agent sharing its engine with the Antigravity 2.0 desktop app. **As of June 18, 2026, Gemini CLI / Gemini Code Assist IDE extensions stop serving requests for Google AI Pro and Ultra** ([Google Developers Blog: transitioning Gemini CLI to Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/); [TechCrunch, Antigravity 2.0 at I/O 2026](https://techcrunch.com/2026/05/19/google-launches-antigravity-2-0-with-an-updated-desktop-app-and-cli-tool-at-io-2026/)). **So target `agy`, not `gemini`.**

Antigravity CLI: powered by the Gemini family (with optional Claude/OSS backends), supports **asynchronous background subagents**, Agent Skills, Hooks, MCP servers, and Plugins. Headless invocation: `agy -p "..."` with `--output-format` flags for piping ([Choosing Antigravity or Gemini CLI](https://cloud.google.com/blog/topics/developers-practitioners/choosing-antigravity-or-gemini-cli); [Antigravity CLI hands-on guide](https://dev.to/arindam_1729/antigravity-cli-a-hands-on-guide-to-googles-terminal-coding-agent-5bc7)). Google's own framing: "Antigravity IDE is for agent management and visual development; the CLI is for terminal-based and **headless execution**."

### 3.4 Convergence

All three converge on the same GOAP-shaped shape: a **read-only plan-first mode**, a **TODO/checklist** decomposition, **context-isolated subagents** that return summaries, **a repo-instruction file** (CLAUDE.md / AGENTS.md), and **approval/permission gates**. Codex's `/goal` is the most explicit "goal predicate." Claude Code **auto-delegates** to subagents; Codex requires explicit spawns; Antigravity adds async background agents. This convergence is exactly what makes a unified GOAP front-end over all three feasible.

---

## 4. Multi-agent coordination architectures

- **Orchestrator-worker (lead + subagents)** — a central LLM decomposes, delegates to workers, synthesizes. Dominant in Claude Code, Codex, CrewAI (hierarchical), LangGraph (supervisor). State shared by **message passing** + **return summaries**; Anthropic recommends **filesystem artifacts** to avoid the lossy "game of telephone."
- **Swarms / handoffs** — decentralized; agents hand off control peer-to-peer (OpenAI Swarm → Agents SDK). Good for routing/triage, weaker for global progress tracking.
- **Blackboard systems** — agents read/write a shared blackboard; a controller picks who acts next. **In GOAP terms, the world state *is* the blackboard** — a clean conceptual bridge for our build. Maps to a shared scratchpad / shared state object (e.g., LangGraph's `State`).
- **Society of Mind** — capability emerging from agent *conversation* (the inspiration for AutoGen).
- **Graph-based orchestration (LangGraph)** — control flow is a directed graph of nodes over a shared typed `State`, with checkpointing and human-in-the-loop. Most inspectable; closest to "engineered workflow."

**Four ways state/memory is shared:** (1) shared scratchpad/state, (2) message passing, (3) vector memory/RAG, (4) filesystem artifacts.

**Trade-offs:** parallelism helps only for *independent* subtasks (up to ~90% time reduction); context isolation prevents pollution but risks the "telephone" problem; multi-agent costs ~**15× chat tokens** (only worth it for high-value parallelizable work); **errors compound** (mitigate with checkpointing, retries, verification). Anthropic's blunt caveat: "LLM agents are not yet great at coordinating and delegating to other agents in real time," and most coding tasks parallelize poorly.

### Framework cheat-sheet

| Framework | Planning model | Coordination |
|---|---|---|
| **LangGraph** | Both (emergent ReAct + explicit plan-and-execute tutorial) | Supervisor / hierarchical / swarm as nodes+subgraphs |
| **AutoGen** (MS; now maintenance mode → Microsoft Agent Framework) | Emergent (conversational); explicit in Magentic-One | GroupChat / teams |
| **CrewAI** | Both (sequential=emergent; hierarchical=explicit manager) | Role-based crews; sequential vs. hierarchical |
| **OpenAI Agents SDK** (successor to Swarm) | Emergent + guardrails | Handoffs + agents-as-tools |
| **Semantic Kernel** | Historically explicit Planners (now deprecated → function-calling) | Agent + Process frameworks |
| **smolagents** (HF) | Emergent ReAct; optional periodic planning steps | Managed/hierarchical agents |

> **Uncertainty flag:** AutoGen "maintenance mode" + Microsoft Agent Framework as successor (claimed 1.0 GA Apr 2026) and Semantic Kernel Planner deprecation are fast-moving — verify against current Microsoft docs.

---

## 5. The frontier: classical GOAP + LLM agents

The thesis: GOAP gives **deterministic A\* search over a symbolic state graph** (optimal, complete, fast replanning) but everything must be hand-authored; LLMs give **flexible open-vocabulary planning** but are stochastic and degrade on long horizons. Combining them targets each one's blind spot. **Four concrete integration archetypes** exist in the literature:

**(A) LLM-as-translator, classical-planner-as-solver** — the dominant academic pattern. **LLM+P** ([Liu et al., arXiv:2304.11477](https://arxiv.org/abs/2304.11477)) converts an NL description into a **PDDL** file, lets a classical planner find an optimal solution, then translates back to NL. Motivation = exactly the GOAP/LLM complementarity: "while LLMs cannot reliably solve long-horizon planning problems, classical planners can use efficient search algorithms to quickly identify correct, or even optimal, plans once a problem is formatted appropriately." **Principle: let the LLM populate the symbolic model (predicates, actions, goal); let a sound planner do the search.**

**(B) GOAP for control, LLM for cognition** — the games line. [Shan & Michel, "Generative AI with GOAP…", IEEE CoG 2024](https://ieeexplore.ieee.org/document/10645549) uses GOAP for real-time action selection (dodging LLM latency) while the LLM supplies higher-level strategy.

**(C) LLM authors/repairs the GOAP action model** — use the LLM to generate action definitions from NL, estimate costs from context, and infer missing preconditions. Addresses GOAP's biggest burden (hand-writing every action). (Active 2024 research direction; specific papers provisional.)

**(D) GOAP node inside an LLM-agent graph** — the practical engineering recipe: a `goap_planning_node` runs real deterministic A\* to produce the plan skeleton; an `action_execution_node` uses the **LLM to execute each step flexibly**, with a conditional `should_replan` edge. **This maps cleanly onto Plan-and-Execute and is the most directly buildable "GOAP + LLM" pattern** — and it's essentially what this project's blueprint adopts.

**What the synthesis *means*:** a division of labor along the deterministic/stochastic seam — symbolic layer for search/validity/termination; LLM layer for turning fuzzy goals into predicates, authoring the action model, grounding/executing steps, and deciding *when* to replan. Open problems remain at the seams: partial observability, continuous (non-discrete) state, multi-agent GOAP coordination, and meta-planning ("replan vs. persist?").

> **Maturity caveat:** This is an active, fragmented research area, not settled practice. LLM+P (A) is well-cited and reproducible; explicit "GOAP+LLM" (B) is a single 2024 paper; (C)/(D) rest partly on secondary engineering notes — treat the *patterns* as well-attested and *specific papers* as provisional.

---

## 6. The through-line (why this matters for the build)

The arc from AutoGPT (2023) to Claude Code / Codex / Antigravity (2026) is a deliberate **retreat from open-ended autonomy toward grounded, bounded, GOAP-shaped planning**: scoped goals with verifiable completion (Codex `/goal`, test-pass signals); a separate **plan artifact** before execution (Plan Mode, `/plan`); a **TODO/task list** as explicit decomposition; **strong external grounding** (compilers/tests as the precondition/effect oracle the LLM lacks); **deterministic guardrails** around the loop (hooks, approval modes, budgets); and **orchestrator-worker** coordination with isolated subagents.

Classical GOAP is the formal template all of this approximates. A self-hosted GOAL generator's job is to make that template **explicit and legible**: an LLM turns your plain-English goal into a structured action graph, a deterministic A\* planner orders it, and each action node dispatches to a real coding-agent CLI (Claude Code / Codex / Antigravity) — with replanning when an action fails. That design is doc 05.
