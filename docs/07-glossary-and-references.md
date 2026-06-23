# 07 — Glossary & Master References

**Related:** all docs. This is the lookup/appendix file.

---

## Glossary

**A\* (A-star)** — A best-first graph-search algorithm that minimizes `f(n) = g(n) + h(n)`, where `g` is cost-so-far and `h` is a heuristic estimate of cost-to-goal. In GOAP, nodes are world states and edges are actions.

**Action (operator)** — An atomic step an agent can take. In GOAP it has **preconditions**, **effects**, and a **cost**. In an LLM agent, the analogue is a **tool**.

**Admissible heuristic** — A heuristic that never overestimates the true cost to the goal; required for A\* to guarantee an optimal path. GOAP's common "count of unsatisfied goal predicates" heuristic is admissible only when each action satisfies at most one new goal predicate.

**AGENTS.md** — Codex's repo-level instruction file (open standard at agents.md); the Codex analogue of CLAUDE.md.

**AgentDB** — RuFlo's HNSW vector-memory store for plans/trajectories/outcomes. (In `goal.ruv.io`'s shipped demo it's roadmap, not wired in.)

**Antigravity CLI (`agy`)** — Google's Go-based terminal coding agent (Gemini-powered, optional Claude/OSS backends) that **replaced Gemini CLI**; supports headless execution (`agy -p`), async subagents, skills, hooks, MCP, plugins.

**Backward / regressive search** — Planning search that starts at the **goal** and works toward the current state, only considering actions whose effects satisfy an unsatisfied subgoal. Classic GOAP's direction.

**Behavior Tree (BT)** — A hierarchy of composite nodes (sequence/selector) re-ticked each frame; reactive, debuggable, but less emergent than GOAP.

**Blackboard system** — A coordination pattern where agents read/write a shared data structure ("blackboard"); in GOAP the **world state is the blackboard**.

**Claude Agent SDK** — Anthropic's SDK (formerly Claude Code SDK, renamed Sep 2025) exposing the Claude Code agent loop, subagents, hooks, sessions, and orchestration tools programmatically in Python/TypeScript.

**Cost** — A scalar per action; the planner minimizes total plan cost. Orkin's first deviation from STRIPS; what makes A\* applicable.

**Effects** — The world-state changes an action produces. In execution you should confirm the **real** effect via a ground-truth check, not trust the declared effect.

**Forward / progressive search** — Planning search from the **current state** applying applicable actions toward the goal. Easier to debug; used by later AAA GOAP and by `goal.ruv.io`.

**GOAP (Goal-Oriented Action Planning)** — A STRIPS-derived planning architecture: goals + actions (pre/effects/cost) + an A\* planner that chains actions to reach a goal, with replanning. Orkin / F.E.A.R. (2005).

**Goal** — A desired world-state condition (a predicate). Contains no embedded plan; the planner figures out how to satisfy it. Codex's `/goal` "definition of done" is the closest LLM-agent equivalent.

**Ground truth / grounding** — Real signals from the environment (tool results, exit codes, test output) that tell the agent whether an action actually worked. The external oracle LLMs lack on their own.

**Heuristic h(n)** — Estimated cost from a node to the goal. GOAP standard: number of unsatisfied goal predicates.

**HTN (Hierarchical Task Network)** — A planner that decomposes high-level tasks into subtasks via designer-authored "methods"; forward-directed; scales to large action sets but less emergent than GOAP.

**Hooks** — Deterministic callbacks (shell/HTTP/prompt) fired at lifecycle points in Claude Code (e.g., `PreToolUse` can block a tool). The deterministic guard layer around the stochastic agent loop.

**LLM+P** — Liu et al. 2023; converts an NL problem to **PDDL**, solves with a classical planner, translates the plan back to NL. The canonical "LLM-as-translator, classical-planner-as-solver" hybrid.

**Lovable** — An AI app-builder used to scaffold `goal.ruv.io`; its AI gateway (`ai.gateway.lovable.dev`) is what the demo calls for Gemini 2.5 Flash. RuFlo's roadmap Phase 1 is to decouple from it.

**MCP (Model Context Protocol)** — An open protocol for connecting agents to tools/data sources. RuFlo exposes its orchestration via an MCP server; action nodes can map to MCP tool calls.

**OODA loop** — Observe–Orient–Decide–Act; the execution-monitoring/replanning loop in RuFlo's documented GOAP methodology.

**Orchestrator-worker** — A lead agent decomposes a task, delegates to worker subagents (often in parallel, in isolated contexts), and synthesizes results. The dominant multi-agent pattern in Claude Code and Codex.

**PDDL (Planning Domain Definition Language)** — The standard academic language for classical planning domains; the bridge format in LLM+symbolic-planner hybrids.

**Plan-and-Execute** — An agent pattern: a planner LLM produces a full plan, an executor runs steps, the planner replans with results. The closest LLM-native analogue to GOAP.

**Plan Mode** — A read-only mode (Claude Code `Shift+Tab`; Codex `/plan`) where the agent proposes a plan without editing source.

**Preconditions** — What must be true in the world state for an action to be applicable. "Procedural/context preconditions" are arbitrary checks the planner won't try to satisfy.

**ReAct** — Reason+Act interleaving (`Thought → Action → Observation → …`); the default emergent-planning loop of most production agents.

**Reflexion** — Verbal self-reflection stored in episodic memory to improve across attempts; the academic basis for self-critique/replanning.

**Replanning** — Re-running the planner from the current state when an action fails or the world changes — instead of restarting. GOAP does this deterministically; LLM agents approximate it via reflection.

**RuFlo / claude-flow** — Reuven Cohen's MIT-licensed multi-agent orchestration meta-harness on top of Claude Code (claude-flow renamed to RuFlo). Contains the `ruflo-goals` GOAP plugin and powers `goal.ruv.io`.

**RuVector** — ruvnet's Rust real-time vector + graph neural DB; the engine behind RuFlo's AgentDB memory.

**STRIPS** — Stanford Research Institute Problem Solver (Fikes & Nilsson, 1971); the action representation (preconditions + add/delete lists) GOAP descends from.

**SONA / ReasoningBank** — RuFlo's self-learning / trajectory-learning components (roadmap-level in the `goal.ruv.io` demo).

**Tool (LLM agent)** — A callable capability (function, API, shell, MCP tool); the LLM-agent analogue of a GOAP action.

**Utility AI** — Decision-making by scoring options with utility curves and picking the max; graded but non-sequential (no multi-step planning).

**World state** — The set of facts the planner reasons over (key/value or bitfield in GOAP; context/memory/files in an LLM agent).

---

## Master reference list

### Classic GOAP & automated planning
- Orkin, *Three States and a Plan: The A.I. of F.E.A.R.* (GDC 2006) — https://www.gamedevs.org/uploads/three-states-plan-ai-of-fear.pdf
- Orkin, *Applying Goal-Oriented Action Planning to Games* (AI Game Programming Wisdom 2) — https://scispace.com/pdf/applying-goal-oriented-action-planning-to-games-34ea1slk48.pdf
- Fikes & Nilsson, *STRIPS* (1971) — https://www.sciencedirect.com/science/article/abs/pii/0004370271900105
- Wikipedia, *STRIPS* — https://en.wikipedia.org/wiki/Stanford_Research_Institute_Problem_Solver
- Russell & Norvig, *AIMA* ch.11 "Planning" — https://aima.cs.berkeley.edu/2nd-ed/newchap11.pdf
- Jacopin, *Optimizing Practical Planning for Game AI* (Game AI Pro 2, ch.13) — https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter13_Optimizing_Practical_Planning_for_Game_AI.pdf
- Conway/Higley/Jacopin, *GOAP: Ten Years Old and No Fear!* (GDC 2015) — https://media.gdcvault.com/gdc2015/presentations/Higley_Peter_Goal-Oriented_Action_Planning.pdf
- Dill et al., *Behavior Selection Algorithms: An Overview* (Game AI Pro, ch.4) — https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter04_Behavior_Selection_Algorithms.pdf
- Excalibur.js, *NPC AI planning with GOAP* — https://excaliburjs.com/blog/goal-oriented-action-planning/

### GOAP open-source implementations
- GPGOAP (C) — https://github.com/stolk/GPGOAP
- crashkonijn/GOAP (C#/Unity) — https://github.com/crashkonijn/GOAP
- ReGoap (C#) — https://github.com/luxkun/ReGoap
- dogoap (Rust) — https://github.com/victorb/dogoap

### LLM-agent planning patterns
- ReAct — https://arxiv.org/abs/2210.03629
- Plan-and-Solve — https://arxiv.org/abs/2305.04091
- Tree-of-Thoughts — https://arxiv.org/abs/2305.10601
- Least-to-Most — https://arxiv.org/abs/2205.10625
- Reflexion — https://arxiv.org/abs/2303.11366
- Weng, *LLM Powered Autonomous Agents* — https://lilianweng.github.io/posts/2023-06-23-agent/
- AutoGPT — https://github.com/Significant-Gravitas/AutoGPT · https://en.wikipedia.org/wiki/AutoGPT
- BabyAGI — https://github.com/yoheinakajima/babyagi · https://yoheinakajima.com/birth-of-babyagi/

### Anthropic / Claude Code / Agent SDK
- Building Effective Agents — https://www.anthropic.com/engineering/building-effective-agents
- How we built our multi-agent research system — https://www.anthropic.com/engineering/multi-agent-research-system
- Building agents with the Claude Agent SDK — https://claude.com/blog/building-agents-with-the-claude-agent-sdk
- Run Claude Code programmatically (headless) — https://code.claude.com/docs/en/headless
- Permission modes — https://code.claude.com/docs/en/permission-modes · Subagents — https://code.claude.com/docs/en/sub-agents · Hooks — https://code.claude.com/docs/en/hooks · Skills — https://code.claude.com/docs/en/skills · Tools — https://code.claude.com/docs/en/tools-reference
- Agent SDK — https://platform.claude.com/docs/en/agent-sdk/overview

### OpenAI Codex
- Introducing Codex — https://openai.com/index/introducing-codex/
- Codex CLI — https://developers.openai.com/codex/cli · Auth — https://developers.openai.com/codex/auth · Prompting (goal/plan/loop) — https://developers.openai.com/codex/prompting
- Using Codex with your ChatGPT plan — https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- AGENTS.md — https://agents.md

### Google Antigravity / Gemini CLI
- Transitioning Gemini CLI to Antigravity CLI — https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- Choosing Antigravity or Gemini CLI — https://cloud.google.com/blog/topics/developers-practitioners/choosing-antigravity-or-gemini-cli
- Antigravity 2.0 launch (TechCrunch) — https://techcrunch.com/2026/05/19/google-launches-antigravity-2-0-with-an-updated-desktop-app-and-cli-tool-at-io-2026/
- gemini-cli repo — https://github.com/google-gemini/gemini-cli

### Multi-agent frameworks
- LangGraph — https://langchain-ai.github.io/langgraph/ · plan-and-execute — https://langchain-ai.github.io/langgraph/tutorials/plan-and-execute/plan-and-execute/
- AutoGen — https://github.com/microsoft/autogen · CrewAI — https://github.com/crewAIInc/crewAI · OpenAI Agents SDK — https://openai.github.io/openai-agents-python/ · smolagents — https://github.com/huggingface/smolagents

### GOAP + LLM hybrids
- LLM+P — https://arxiv.org/abs/2304.11477 · code https://github.com/Cranial-XIX/llm-pddl
- Generative AI with GOAP (IEEE CoG 2024) — https://ieeexplore.ieee.org/document/10645549
- GOAP for adaptive agents (engineering overview) — https://notes.muthu.co/2025/10/goal-oriented-action-planning-for-dynamic-problem-solving-in-adaptive-agents/

### ruv.io / ruvnet
- goal.ruv.io — https://goal.ruv.io/ · /agents — https://goal.ruv.io/agents
- RuFlo repo — https://github.com/ruvnet/ruflo · README — https://raw.githubusercontent.com/ruvnet/ruflo/main/README.md · Wiki — https://github.com/ruvnet/ruflo/wiki
- goal_ui — https://github.com/ruvnet/ruflo/tree/main/v3/goal_ui · planner — https://raw.githubusercontent.com/ruvnet/ruflo/main/v3/goal_ui/src/lib/goapPlanner.ts
- ruflo-goals plugin — https://raw.githubusercontent.com/ruvnet/ruflo/main/plugins/ruflo-goals/README.md
- Integration roadmap — https://github.com/ruvnet/ruflo/issues/1692
- npm claude-flow — https://registry.npmjs.org/claude-flow/latest · goalie — https://registry.npmjs.org/goalie/latest
- RuVector — https://github.com/ruvnet/RuVector · flow-nexus (proprietary) — https://github.com/ruvnet/flow-nexus
- Maintainer — https://github.com/ruvnet

> **Caveats on ruvnet sources:** star counts and version numbers are self-reported and inconsistent across pages; benchmark claims are unaudited. Verify anything load-bearing. See [doc 04 §0](04-ruvnet-ecosystem-evaluation.md).
