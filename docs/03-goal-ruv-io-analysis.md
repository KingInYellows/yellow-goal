# 03 — How `goal.ruv.io` Actually Works (Reverse-Engineered from Source)

> This is the doc that determines your build strategy. It's built from reading the **actual source** in `github.com/ruvnet/ruflo` (path `v3/goal_ui/`), not the marketing copy. Where something is quoted, it's verbatim from the repo.

**Related:** [`04-ruvnet-ecosystem-evaluation.md`](04-ruvnet-ecosystem-evaluation.md) · [`06-fork-vs-build-decision.md`](06-fork-vs-build-decision.md)

---

## 0. The headline finding (the thing to internalize before anything else)

`goal.ruv.io` ("RuFlo Research") is a **client-side React demo**. Reading the source:

- The **GOAP "A\* planner" runs entirely in the browser** — ~150 lines of TypeScript (`src/lib/goapPlanner.ts`). It's a clean, textbook implementation.
- The **only real backend** is a single Supabase Edge Function (`research-step`) that calls **Google Gemini 2.5 Flash** (via Lovable's AI gateway) with Google-Search grounding.
- The **`/agents` "live agent swarm dashboard" is a scripted mock-up** — hard-coded agent arrays animated with `setTimeout`, **no backend, no real agents, randomized telemetry** (confirmed: `Agents.tsx` makes **zero** network calls; an author comment literally reads `// Mock state for Goal Assessment`).
- The README's grander claims — **dispatch to real coder/tester/reviewer swarms, AgentDB/SONA learning, ~210 MCP tools wired in** — describe the **aspirational integration roadmap** ([ruflo issue #1692](https://github.com/ruvnet/ruflo/issues/1692)), **not** what the deployed site does.

**Implication:** the impressive part you saw in the marketing is the part that *isn't built*. The clone-worthy core is small and fully open. The "real agents executing your work" layer is yours to build no matter what.

---

## 1. The actual end-to-end flow (from `src/pages/Index.tsx`)

1. **Goal entry.** User types a goal (default example: *"Research the latest advancements in quantum computing"*) or picks a category preset. Optional config: depth, perspective, focus areas, source filters, GOAP execution mode.
2. **Plan generation — local, no network.** On submit: a fake 1.5s "planning" spinner, then `parseGoal(goal)` extracts a coarse `{domain, action, keywords}`; `createGOAPActions` builds a **7-action** set; `new GOAPPlanner(actions).plan(currentState, goalState, goal)` runs **in-browser A\*** and returns an ordered `Step[]`. **It does not auto-run** — the user must click **Start Research** (a deliberate "observable and reversible" UX choice).
3. **State + config display.** Two cards render: `StateAssessmentCard` (live boolean world-state vs. goal-state + "state gaps") and `GOAPConfigDisplay` (execution mode, replanning toggle/triggers, cost optimization, parallel flags).
4. **Step-by-step execution.** `executeResearch()` loops the 7 steps sequentially. For each step it flips world-state booleans, marks the step active, and (if AI enabled) calls the **`research-step` edge function**, passing the goal, step metadata, model, config, and **all previously accumulated findings** (so each step builds on prior context). `setTimeout(2000)` between steps.
5. **Final report.** An 8th `research-step` call with `stepType:"final-report"` produces 3–5 recommendations, shown in a `ResearchReportModal` (with a hard-coded "94% Confidence" and a computed duration ≈ `steps × 3.5s`).

---

## 2. The GOAP planner internals (confirmed code, not marketing)

The entire planner is `src/lib/goapPlanner.ts` — a textbook GOAP/A\* implementation.

**World state** = a flat, fixed struct of 8 booleans:
```ts
interface WorldState {
  goalDefined; goalParsed; stateAssessed; informationGathered;
  documentsAnalyzed; knowledgeSynthesized; insightsGenerated; verified;
}
```

**Actions** carry `name`, integer `cost`, partial-state `preconditions`, partial-state `effects`, and a `stepGenerator(goal) => Step` factory (builds the UI card). The shipped action set is a strictly **linear chain** (each effect is the next action's precondition):

| # | action | cost | precondition → effect | UI step |
|---|--------|------|----------------------|---------|
| 1 | analyzeGoal | 1 | goalDefined → goalParsed | Goal Analysis |
| 2 | assessState | 1 | goalParsed → stateAssessed | State Assessment |
| 3 | gatherInformation | 2 | stateAssessed → informationGathered | Web Search |
| 4 | analyzeDocuments | 2 | informationGathered → documentsAnalyzed | Document Analysis |
| 5 | synthesizeKnowledge | 2 | documentsAnalyzed → knowledgeSynthesized | Knowledge Synthesis |
| 6 | generateInsights | 2 | knowledgeSynthesized → insightsGenerated | Insight Generation |
| 7 | verify | 1 | insightsGenerated → verified | Verification |

**A\* search (`plan()`):** open/closed lists; nodes `{state, actions[], cost, heuristic}`; state key = `JSON.stringify(state)`. **g(n)** = sum of action cost. **h(n)** = number of unmet goal conditions (classic GOAP heuristic; here it's admissible because each action satisfies at most one new goal predicate, so A\* returns the optimal plan). Frontier re-sorted each iteration by `cost + heuristic`. Goal test: `heuristic === 0`. Returns `[]` on failure (UI shows a "Planning Failed" toast).

**Goal parsing (`parseGoal`)** is deliberately lightweight heuristic NLP, **no LLM**: keyword-match a `domain` and `action`, take the first 5 words >4 chars as `keywords`.

**Replanning** in the *shipped* UI is **cosmetic**: on an edge-function error, if replanning is enabled and triggers include "Action failure," the UI fires a "Replanning Triggered" toast — but **no A\* re-run actually executes**. (Real OODA-loop replanning is in the documented methodology/roadmap, not the live demo.)

> **The single most important architectural fact for a cloner:** the A\* planner orders a **fixed, hand-authored 7-action template** — the same chain for *every* goal; only the card text is interpolated. The LLM is **not** currently used to extract a custom set of actions/preconditions to feed into A\*. A *better* clone (what the roadmap targets) would have the LLM emit `{successCriteria, constraints, actions[{name,cost,preconditions,effects}]}` and run A\* over *that*. The present demo doesn't do dynamic action extraction.

---

## 3. The "GOAL generation" pipeline — two distinct layers

**Layer A — classical, deterministic, in-browser (no LLM):** `parseGoal()` + fixed 7-action set + A* `plan()` → an ordered plan. The "structured goal + action graph" is **template-driven**, not LLM-extracted.

**Layer B — LLM-driven content & config (Gemini 2.5 Flash via Lovable gateway):** four Supabase Edge Functions (Deno), all calling `https://ai.gateway.lovable.dev/v1/chat/completions` with `model: "google/gemini-2.5-flash"` and **OpenAI-style forced tool-calling** (so the LLM returns strict JSON):

1. **`generate-research-goal`** — suggests 3 goal titles for a category (finance, business, marketing, medical, education, technical, coding, ai-ml, custom).
2. **`optimize-research-config`** — converts a preset into a full structured `ResearchConfig`, **including the `goapConfig`** (`executionMode ∈ {focused, closed, open}`, `enableReplanning`, `costOptimization`, `parallelExecution`), research guidance (focus/exclude/depth/perspective/timeframe), and parameters (maxSources, minConfidence, maxSteps, parallelAgents, timeout). **This is where GOAP config is generated by the LLM.**
3. **`research-step`** — the **core executor**, called ~8×/run. Assembles a system prompt from config + accumulated findings, then calls Gemini with **two tools**: Google Search grounding (`google_search_retrieval`, dynamic) for real web results, and a forced `generate_research_data` function returning `{title, content, source(required), confidence 0.7–0.95}`. Extracts `grounding_metadata` to enrich citations. **The only function the live UI actually calls.**
4. **`generate-action-items`** — turns research context into a structured action plan (title, timeline, priority, resources, metrics, risks, references).

(There's also a referenced `research-api` edge function, not exercised by the live UI.)

**Direct answer to "is an LLM used?":** Yes — Gemini 2.5 Flash does the *language* tasks (suggest goals, generate config, do web-grounded research, write the action plan). A *classical A\* GOAP planner* orders the steps. But in the shipped version, A\* orders a **fixed template**, and the LLM does **not** emit a custom action graph for the planner. **That gap is exactly the opportunity for your build.**

---

## 4. Tech stack & architecture (confirmed)

- **Frontend:** React 18 · TypeScript 5 · **Vite 5** · Tailwind 3 · **shadcn/ui + Radix** · TanStack Query · React Router · lucide-react.
- **"Planner backend":** none — the GOAP/A\* planner is **client-side TS**. The only server code is **Supabase Edge Functions** (Deno).
- **LLM execution:** Gemini 2.5 Flash via the **Lovable AI gateway** (server-side `LOVABLE_API_KEY`). Web research = Gemini's Google-Search grounding. **No Claude Code / Codex / MCP tools are invoked by the live site** — that's roadmap.
- **Auth:** browser uses only the Supabase anon key; no user login required; edge functions set permissive CORS.
- **Real-time telemetry:** **none.** No WebSockets, no Supabase Realtime, no SSE, no polling. "Progress" is `setTimeout` ladders; agent metrics are `Math.random()`. The only network I/O is `supabase.functions.invoke('research-step', …)`.
- **Persistence:** no app DB tables used by the demo; plans are **not** persisted (AgentDB storage is a future roadmap item). Stateless per session.
- **Provenance:** scaffolded with **Lovable** (an AI app builder), imported/rebranded into RuFlo in PR #1693. Roadmap Phase 1 is literally "decouple from Lovable infra" (swap the gateway to OpenRouter, etc.).
- **Hosting:** Netlify (`netlify.toml`). Ships an **embeddable widget** (`<script src="https://goal.ruv.io/widget.js">`).

---

## 5. The `/agents` dashboard — definitively a mock-up

`src/pages/Agents.tsx` presents a three-stage **research → review → development** workflow, each with 5 tabs (Dashboard / Tasks / Execution / Quality / Logs), six hard-coded agent roles (Architecture, Implementation, Testing, Code Review, Documentation, DevOps), a `swarmMode` that's never actually switched, a kanban `TaskBoard`, a `DependencyGraph`, a `PlanVisualization` node graph (a hard-coded 5-action build plan), `QualityGates` with literal numbers (`testCoverage: 85–100`, `securityScore: 92–95`), and a `RealTimeEventLog` fed a **static array literal** with frozen timestamps.

**Definitive:** the page makes **zero** network calls; everything is driven by `setTimeout` (phases advance at 1/8/16/24/32/40s); all LOC counts, file names, and "99.9% uptime / <200ms" are string literals. **It is a convincing animated demo of a coding swarm, not a live telemetry view.** The README's per-agent "role, current step, memory namespace, token budget; click in to inspect trajectories, kill/reassign" describes intended capability the shipped page fabricates.

---

## 6. Self-hosting facts

- **It is open source (MIT).** It lives in the public RuFlo monorepo at `v3/goal_ui/`. License = MIT (same as parent RuFlo).
- **Run it locally:**
  ```bash
  # clone the repo (the goal_ui app), then:
  cd v3/goal_ui
  npm install
  npm run dev            # app at http://localhost:8080
  npm run build:widget   # -> dist/widget.js + dist/widget.css
  ```
  Env (`example.env` → `.env`, all browser-safe `VITE_*`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_PUBLISHABLE_KEY`.
- **To actually make it function you supply:** a **Supabase project** (hosts the Deno edge functions) and an **LLM key**. Shipped functions expect `LOVABLE_API_KEY` (→ Gemini 2.5 Flash). The roadmap recommends swapping to **OpenRouter** or your own bridge — trivial because the gateway speaks OpenAI chat-completions + tool-calling, so any OpenAI-compatible endpoint works.
- **Not included / not needed for the standalone clone:** AgentDB/SONA/MCP/real-swarm wiring (all roadmap). The `/agents` dashboard needs no backend at all unless you choose to make it real.

---

## 7. What's confirmed vs. inferred

**Confirmed (read directly from source):** the ~150-line client-side A\* planner and its exact world-state/actions/cost/heuristic; the 7-action linear chain and costs; the four edge functions and that `research-step` is the only one the live UI calls; the stack, env vars, Netlify hosting, MIT license, embeddable widget; that `/agents` is a `setTimeout`-driven mock with no network calls; the Lovable origin and that AgentDB/MCP/real-swarm are unbuilt roadmap (issue #1692).

**Inferred / not directly verified:** internals of some child components; `research-api`'s exact behavior; live runtime behavior of the deployed SPA (findings are from the source that powers it, which is authoritative for "how it works"); star/version counts (from README badges / a third-party article; they fluctuate).

---

## 8. Bottom line for your build

The clone-worthy core is **small and fully open**: a ~150-line client-side A\* GOAP planner + one LLM edge function doing web-grounded research with structured tool-calling. The impressive "live agent swarm" is a mock-up. To get what the marketing *implies* — and what you actually want — the real work is:

1. Have an **LLM extract a *dynamic* action/precondition graph** to feed A\* (instead of the fixed 7-step template).
2. Make `/agents` **real** by wiring action nodes to **actual executors** (your Claude Code / Codex / Antigravity subscriptions) plus a realtime channel for telemetry.

Both are exactly the unbuilt items in ruvnet's own roadmap. See [`05-self-hosted-build-blueprint.md`](05-self-hosted-build-blueprint.md) for how to do it and [`06-fork-vs-build-decision.md`](06-fork-vs-build-decision.md) for whether to fork or build clean.

---

## Key sources

- Repo (MIT): [`github.com/ruvnet/ruflo`](https://github.com/ruvnet/ruflo) · app [`v3/goal_ui/`](https://github.com/ruvnet/ruflo/tree/main/v3/goal_ui) · [goal_ui README](https://raw.githubusercontent.com/ruvnet/ruflo/main/v3/goal_ui/README.md)
- Planner source: [`goapPlanner.ts`](https://raw.githubusercontent.com/ruvnet/ruflo/main/v3/goal_ui/src/lib/goapPlanner.ts)
- Pages: [`Index.tsx`](https://github.com/ruvnet/ruflo/blob/main/v3/goal_ui/src/pages/Index.tsx) · [`Agents.tsx`](https://github.com/ruvnet/ruflo/blob/main/v3/goal_ui/src/pages/Agents.tsx)
- Edge functions: [`research-step`](https://raw.githubusercontent.com/ruvnet/ruflo/main/v3/goal_ui/supabase/functions/research-step/index.ts) · [`optimize-research-config`](https://raw.githubusercontent.com/ruvnet/ruflo/main/v3/goal_ui/supabase/functions/optimize-research-config/index.ts) · [`generate-research-goal`](https://raw.githubusercontent.com/ruvnet/ruflo/main/v3/goal_ui/supabase/functions/generate-research-goal/index.ts) · [`generate-action-items`](https://raw.githubusercontent.com/ruvnet/ruflo/main/v3/goal_ui/supabase/functions/generate-action-items/index.ts)
- Integration roadmap & provenance: [issue #1692](https://github.com/ruvnet/ruflo/issues/1692)
- GOAP methodology skill: [`agent-goal-planner/SKILL.md`](https://raw.githubusercontent.com/ruvnet/ruflo/main/.agents/skills/agent-goal-planner/SKILL.md)
- Third-party write-up: [Augment Code — "Ruflo ships v3.10…"](https://www.augmentcode.com/learn/ruflo-v3-10-graph-intelligence-claude-code)
