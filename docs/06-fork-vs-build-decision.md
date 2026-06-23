# 06 — Fork, Adopt, or Build? + Wiring In Your Subscriptions

> Directly answers: *"Should I just reuse `goal.ruv.io`, host it myself, and wire in my OAuth subscriptions (Gemini/Antigravity, Claude Code, Codex)? Fork it or borrow its ideas?"*

**Related:** [`03-goal-ruv-io-analysis.md`](03-goal-ruv-io-analysis.md) (what's actually in the fork) · [`04-ruvnet-ecosystem-evaluation.md`](04-ruvnet-ecosystem-evaluation.md) · [`05-self-hosted-build-blueprint.md`](05-self-hosted-build-blueprint.md)

---

## 1. The reframe you need before deciding

You looked at `goal.ruv.io`'s feature list and reasonably concluded "he already built what I want; I just need my own copy." **The research says: the feature list is a roadmap, not the shipped product.** From reading the actual source ([doc 03](03-goal-ruv-io-analysis.md)):

- **Real and reusable:** a polished React UI, a clean **~150-line client-side A\* GOAP planner**, and **one** working edge function that does web-grounded *research* via Gemini 2.5 Flash. All MIT.
- **Mocked (not built):** the "live agent dashboard," "dispatch work to live agents," "wired to ~210 MCP tools," "AgentDB/SONA learning." The `/agents` page makes **zero** network calls — it's hard-coded agents animated with `setTimeout`.

So the specific capability you care about — **a GOAP plan that dispatches real work to your Claude Code / Codex / Antigravity subscriptions** — **is the part that doesn't exist in any forkable form.** That's true of `goal_ui` *and*, in turnkey form, of the bigger RuFlo platform. **You are building the execution layer regardless.** The only question is what you stand on while you build it.

Good news: that execution layer is very achievable, because all three CLIs support headless, subscription-authenticated invocation (§3).

---

## 2. The three options

| | **A. Fork `goal_ui`** | **B. Adopt full RuFlo** (`claude-flow`) | **C. Build clean** |
|---|---|---|---|
| **What you start with** | The MIT React UI + client-side A\* planner + research edge function | The whole meta-harness: `goal-planner` skill, swarms, memory, 314 MCP tools, Claude Code + Codex plugins | Empty repo; ruv.io + RuFlo as reference only |
| **Closest to "real agents on my subscriptions"?** | No — you build execution behind it | **Closest** — it already drives Claude Code (+ Codex plugin) and routes Gemini/GPT/Claude | No (you build it) |
| **Effort to first real run** | Medium (build orchestrator + executors) | Low–medium (configure, then trim) | High |
| **Ownership / understandability** | High (small codebase you control) | **Low** (huge, churny, single-maintainer, heavy footprint) | **Highest** |
| **Footprint / lock-in** | Light | Heavy (daemon, hooks, many files, big dep tree) | Light |
| **License** | MIT ✅ | MIT ✅ | yours |
| **Main risk** | You under-estimate the execution-layer work | Platform churn, bus-factor=1, "lite plugin gives no MCP tools" foot-gun, marketing≫verification | Reinventing the planner/UI ruv.io already nailed |

---

## 3. The subscription-wiring reality (important technical correction)

You framed it as "wire in my **OAuth** subscriptions." These coding agents **don't expose a generic OAuth you embed in a web app.** Each authenticates **locally, via its own login**, and the way to "use your subscription" is to **run the CLI headlessly from a host you've logged into**, with your orchestrator spawning it as a subprocess. The authenticated **CLI on the host is the integration point**, not a browser OAuth flow.

Verified, as of June 2026 (re-check exact flags before shipping):

- **Claude Code** — `claude -p "<prompt>" --output-format json`. Headless "uses the same auth as interactive mode, and your **Max subscription covers it** under the same weekly rate limit"; switch to `ANTHROPIC_API_KEY` for sustained parallel load. `--output-format json` returns `total_cost_usd`. ([Run Claude Code programmatically](https://code.claude.com/docs/en/headless))
- **Codex** — `codex exec "<prompt>"` for scripted/non-interactive runs; **`codex login` uses your ChatGPT Plus/Pro plan**; API key recommended for heavy CI/CD; can read a ChatGPT access token from stdin. ([Codex CLI](https://developers.openai.com/codex/cli) · [auth](https://developers.openai.com/codex/auth))
- **Antigravity (Gemini)** — `agy -p "<prompt>" --output-format <fmt>`; login uses your **Google AI Pro/Ultra** plan. **Time-sensitive:** Google is **retiring Gemini CLI** — "On June 18, 2026, Gemini CLI and Gemini Code Assist IDE extensions will stop serving requests for Google AI Pro and Ultra." **Target Antigravity CLI (`agy`), not `gemini`.** ([transition notice](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) · [Choosing Antigravity or Gemini CLI](https://cloud.google.com/blog/topics/developers-practitioners/choosing-antigravity-or-gemini-cli))

**Operational consequences:**
- Your orchestrator runs on **one host** (your machine, a VPS, or a container) where you've run each CLI's login once. It calls them via `child_process`. That host is your auth + execution boundary.
- For parallelism, respect each plan's **rate limits**; have an **API-key fallback** for sustained fan-out; track cost via the JSON output.
- Don't try to capture/replay subscription OAuth tokens into a multi-tenant web service — it's against the grain of these tools and a ToS/security minefield. Keep execution on a host you own. (This is exactly the model RuFlo/`claude-flow` uses: a meta-harness sitting on top of the logged-in Claude Code CLI.)

---

## 4. Recommendation

**Hybrid: fork the front-end, build the backend, mine the rest for ideas.**

1. **Fork `goal_ui` for the UI + planner shell** (MIT). You get the plan-tree UX, state cards, config panel, and a correct A\* planner for free — the parts ruv.io genuinely nailed. Don't rebuild these.
2. **Build your own thin orchestration backend** (the [doc 05](05-self-hosted-build-blueprint.md) design): a Node service that runs the A\* planner, and an **executor layer** mapping each action node to `claude -p` / `codex exec` / `agy -p` on your host. **This is the valuable part and it doesn't exist to fork.**
3. **Replace the fixed 7-action template with an LLM goal-extractor** that emits a dynamic action graph (the thing the demo only mocks).
4. **Mine, don't depend on, the ruvnet pieces:** read **`goalie`**'s source for a minimal "goal → GOAP → MCP execution" loop; read the **`ruflo-goals`** `goal-planner` skill for its OODA replanning methodology; consider **RuVector** later if you want a fancy memory tier. Keep these as references unless one earns a hard dependency. ([doc 04](04-ruvnet-ecosystem-evaluation.md))

**When to choose differently:**
- **Choose B (adopt RuFlo)** if your priority is *"see real agents on my subscriptions ASAP"* and you're willing to accept a heavy, churny, single-maintainer platform you don't fully control. It's genuinely the closest turnkey thing — but trim it hard and pin `claude-flow@3.10.x`, and run it sandboxed first. A smart middle path: **run RuFlo to learn**, then keep only what you need.
- **Choose C (build clean)** if you value full ownership/understanding over speed, or if you want a small auditable system rather than a 300-tool platform. You'll still use ruv.io's planner as a spec.

**Why not "just fork and host `goal.ruv.io`":** you'd get the research-report demo plus a mock dashboard — not "agents doing your work." You'd then build the execution layer anyway, but now inside someone else's app shape and tied to Supabase Edge Functions, which are an awkward place to spawn long-running CLI agents ([doc 05 §8](05-self-hosted-build-blueprint.md)).

---

## 5. Licensing & attribution

`goal_ui` and `claude-flow`/RuFlo are **MIT** — you may fork, self-host, modify, and use commercially, provided you **retain the MIT license text and copyright notice**. If you lift `goapPlanner.ts` or UI components, keep their headers and add an attribution note (e.g., in your README/NOTICE). `flow-nexus` is **Proprietary** — do **not** reuse its code; reference its patterns only ([doc 04 §4](04-ruvnet-ecosystem-evaluation.md)).

---

## 6. Concrete next steps (a first week)

1. Clone the repo, run `cd v3/goal_ui && npm install && npm run dev`; read `goapPlanner.ts`, `Index.tsx`, and the four edge functions end-to-end ([doc 03 §6](03-goal-ruv-io-analysis.md)).
2. In a sandbox, install RuFlo (`npx claude-flow@3.10.x init wizard`) and try the `goal-planner` skill — purely to see the methodology in action ([doc 04 §1](04-ruvnet-ecosystem-evaluation.md)).
3. On your host, confirm each subscription CLI runs headless: `claude -p "say hi" --output-format json`, `codex exec "say hi"`, `agy -p "say hi"`. This validates the whole premise before you build anything.
4. Stand up the [doc 05](05-self-hosted-build-blueprint.md) Phase 1 (planner + dynamic extraction, dry-run executors), then Phase 2 (one real `claude -p` executor + replanning).

If you want, the next pass can turn [doc 05](05-self-hosted-build-blueprint.md) into an actual scaffold (repo skeleton + a working generalized A\* planner module + executor stubs) per the "research + blueprint + code scaffold" option.
