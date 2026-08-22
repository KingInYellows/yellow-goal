# PRD — GOAL Generator (self-hosted)

**Status:** Draft v0.2 · **Owner:** KingInYellow · **Last updated:** 2026-06-23
**Source of truth.** This PRD governs scope. Component contracts live in [`.claude/specs/`](../.claude/specs/); architecture in [`../../docs/05-self-hosted-build-blueprint.md`](../../docs/05-self-hosted-build-blueprint.md); rationale in [`../../docs/06-fork-vs-build-decision.md`](../../docs/06-fork-vs-build-decision.md).

---

## 1. Summary

A self-hosted web application that turns a plain-English goal into an inspectable **GOAP plan** and **executes it with a real coding agent**. An LLM extracts a structured action graph; a deterministic A\* planner orders it into a valid, lowest-cost plan; an orchestrator dispatches each action node to a headless coding-agent CLI running on the user's own subscription; results feed back as ground-truth world state and trigger replanning on failure; a live view shows real agent telemetry.

This is the capability `goal.ruv.io` markets but does not ship — its planner is real (~150 LOC, MIT) but its "live agent swarm" is a mock ([`../../docs/03-goal-ruv-io-analysis.md`](../../docs/03-goal-ruv-io-analysis.md)). We build the two missing pieces: **dynamic LLM action-graph extraction** and a **real execution + telemetry layer**.

**v1 scope (M1).** v1 ships this core with a **single executor (Claude Code) run serially** on a **local, single-user host**: extract → plan → confirm definition of done → execute → ground-truth verify → replan. Multi-executor routing, dependency-graph parallelism, and the full multi-agent dashboard are **fast-follow (M2)**; memory is **M3**. See §6 and §12.

## 2. Problem

Coding-agent CLIs (Claude Code, Codex, Antigravity) are powerful but operate per-invocation with no durable, inspectable plan: you hand them a task and hope. There's no shared, legible plan tree, no deterministic ordering/optimization of steps, no automatic replanning across a multi-step goal, and no single pane to coordinate multiple agents across subscriptions. The result is opaque, hard to steer, and easy to send into loops.

## 3. Goals & non-goals

**Goals**
- Turn a plain-English goal into a **structured, inspectable plan** (no JSON/DSL authoring by the user).
- **Deterministically order** actions via A\* (validity + lowest cost), not LLM guesswork.
- Let the operator **confirm the definition of done** (success criteria + per-action verify checks) before a run — the system never grades itself unchecked.
- **Execute** plan nodes with the user's real subscription via a headless CLI; **v1 uses Claude Code, serially**, with multi-executor routing and dependency-graph parallelism as fast-follow.
- **Replan** automatically from real outcomes when an action fails or new info arrives — including **bounded re-extraction** of new actions when the existing pool can't reach the goal.
- Provide **live, real telemetry** (status, current action, tokens/cost) and human controls (approve, pause, kill).
- Be **fully self-hosted** on the user's Proxmox infrastructure; the user owns the code and data.

**Non-goals (v1)**
- Not a hosted SaaS / multi-tenant product — a **local, single-user tool**.
- **Multi-executor execution (Codex, Antigravity), dependency-graph parallelism, and the full multi-agent dashboard are post-v1 (M2 fast-follow), not v1.**
- Not a replacement for the coding agents — it *orchestrates* them.
- No marketplace, billing, or credit economy (cf. flow-nexus, [`../../docs/04-ruvnet-ecosystem-evaluation.md`](../../docs/04-ruvnet-ecosystem-evaluation.md)).
- No fine-tuning / training of models.
- No mobile app.

## 4. Users & personas

- **Primary — the Operator (you):** a technical power-user who holds a Claude Code subscription (and later Codex/Antigravity) and wants to drive multi-step coding/research goals from one place, with full visibility and control.
- **Out of scope — teams / multi-user.** This is a **local, single-user tool**; no team roles or multi-tenant access in v1 or planned scope. Auth is a single-admin login; revisit only if this assumption changes.

## 5. Use cases / user stories

1. *"Ship the auth refactor with tests and a PR"* → plan (analyze repo → change code → add tests → run suite → open PR), executed by Claude Code, with a replan if tests fail.
2. *"Research the latest on X and produce a brief"* → research-style plan executed with web-grounded steps (the `goal.ruv.io` use case), now with real outputs persisted.
3. *Operator watches the live view*, sees an agent stuck, **kills** it, edits the goal/constraints, and **replans**.
4. *Operator reviews the definition of done* the extractor proposes (goalState + verify checks + completion policy), tweaks a verify command, then approves the run.

*(Post-v1, M2: parallel branches per repo, and routing a step to a specific executor or letting the router choose.)*

## 6. Scope — v1 = M1 (single-executor core)

v1 ships the smallest thing that delivers the capability `goal.ruv.io` only mocks: a goal that is planned **and actually executed** by a real agent, with ground-truth verification and replanning (doc-05 Phases 1–2):

- **Goal intake** with optional config (depth, constraints, repo path).
- **LLM goal-extraction** (via headless `claude -p`) → validated `GoalSpec`: success criteria, constraints, dynamic action graph, a required per-action `verify` check, and a recommended `completionPolicy`.
- **A\* planner** → ordered plan + dependency graph, rendered as a **plan tree**.
- **Confirm-criteria gate**: the operator reviews/edits the definition of done (`goalState` + verify checks + `completionPolicy`) before running.
- **Single executor**: Claude Code (`claude -p`), run **serially**, in a per-run git worktree.
- **Ground-truth verification** (run the verify checks; set world state from real exit codes/output) and **automatic replanning** with **bounded re-extraction** (§7, FR-7).
- **Minimal live view**: real run status, current action, streamed output, per-run tokens/cost, event log; **controls** (approve, pause, kill).
- **Persistence**: goals, GoalSpecs, plans, runs, outcomes (Postgres).
- **Guardrails**: cost/iteration/replan caps + loop detection (§8, FR-11).

**Fast-follow (M2, not v1):** Codex + Antigravity executors and per-step routing; dependency-graph parallelism with per-run container isolation; the full multi-agent dashboard with reassign. **M3:** pgvector memory + retrieval-augmented extraction; historical cost dashboards. See §12.

## 7. Functional requirements

| ID | Requirement |
|---|---|
| FR-1 | Accept a free-text goal + optional config; suggest goals by category (optional). |
| FR-2 | Goal-extractor returns a schema-valid `GoalSpec` (criteria, constraints, actions w/ preconditions, effects, cost, recommended executor, **required `verify` check**, recommended `completionPolicy`). Invalid output is rejected/repaired before planning. |
| FR-2a | Before running, the operator can **review and edit the definition of done** — `goalState`, each action's `verify` check, and the `completionPolicy` — and the run uses the confirmed criteria. |
| FR-3 | Planner produces a valid, lowest-cost (or shortest) ordered plan + dependency graph; returns a clear "no plan" state if unsatisfiable. |
| FR-4 | Orchestrator executes nodes respecting dependencies. *v1: serial.* **(M2)** runs independent branches in parallel up to a configured concurrency limit. |
| FR-5 | Each executor adapter invokes its CLI headlessly and captures stdout, exit code, diffs, tokens, and cost. *v1 implements the Claude Code adapter; Codex + Antigravity are M2.* |
| FR-6 | Verification runs the action's `verify` check; world state is updated from **real** results, not declared effects. |
| FR-7 | On failure/changed state, the planner re-runs from current state over the existing action pool; if no plan exists (or after a capped number of failed replans on a subgoal), the **extractor is re-invoked with the real failure evidence to author additional actions (append-only)**, bounded by caps. Replans and re-extractions are recorded and shown as blocked→replanned branches. |
| FR-8 | The live view streams real events over a realtime channel; reflects live status, plan-tree progress, and per-run metrics. |
| FR-9 | Operator controls: approve a plan before run, pause/resume, kill a run (SIGTERM to subprocess). **Reassign executor = M2.** |
| FR-10 | Persist goals, GoalSpecs, plans, steps, runs, and outcomes; list/replay past runs. |
| FR-11 | Enforce guardrails on every run: max replans, max budget (USD), wall-clock, per-action retries, max re-extractions, loop detection. Defaults in §8/§11. On a cap trip: stop dispatching, mark the run paused/blocked, and surface to the operator to raise the cap, resume, or cancel. |
| FR-12 | **(M2)** Executor routing: explicit per-step override or automatic selection. *v1: Claude Code only.* |
| FR-13 | When a goal's `completionPolicy` requires sign-off, on `goalState` satisfaction the run enters an **awaiting-acceptance** state; the operator accepts (→ succeeded) or rejects (→ continue/replan) before the run is marked done. |

## 8. AI-specific requirements & success metrics

AI systems need targets traditional PRDs don't ([source](https://medium.com/@haberlah/how-to-write-prds-for-ai-coding-agents-d60d72efb797)). Split the metrics: **gates** measure what *our system* controls and block release; **observed** metrics measure the *underlying agents'* competence and are reported on a fixed eval set, not gated. All numbers are starting points to calibrate against the eval set once it exists.

**Gate metrics (block release):**

| Metric | Target (v1) | How measured |
|---|---|---|
| **Plan validity rate** | ≥ 98% of generated plans are structurally valid (preconditions satisfiable, reaches `goalState`) | planner unit tests + eval set |
| **GoalSpec schema-conformance** | ≥ 95% pass schema validation (first-try tracked separately — via `claude -p` there is **no server-side forced tool-use**, so the zod **repair round** is load-bearing; measure both first-try and post-repair) | extractor eval set |
| **No-runaway guarantee** | 100% of runs terminate within caps (replan / re-extraction / iteration / budget / wall-clock) | guardrail tests |
| **Plan latency** | < 10s for typical goals (**includes the `claude -p` extraction call**; A\* itself is sub-ms) | timing |

**Observed metrics (reported on the eval set, not gated — depend on the underlying agent):**

| Metric | Reference | How measured |
|---|---|---|
| **Executor success rate** | ~80% of dispatched actions complete with the intended verified effect (varies by goal difficulty + agent) | run logs over a fixed eval set |
| **Replan effectiveness** | ~70% of failed actions recover within ≤ 2 replans/re-extractions | run logs over a fixed eval set |
| **Cost per goal** | tracked + capped; default cap **$20/run** (overridable) | `--output-format json` cost parsing |

**Prerequisite:** a fixed eval set of goals (with expected plans, plus a subset with injected failures for replan scoring) must exist before the observed metrics mean anything — build it alongside the planner (doc 08).

## 9. Non-functional requirements

- **Self-hosted on Proxmox** (see §11 host recommendation). Single binary/service + Postgres; reproducible setup.
- **Security:** secrets server-side only; agents run in **per-run git worktrees — collision-avoidance, not a security sandbox** (the host LXC/VM is the blast radius in v1; per-run containers arrive at M2); least-privilege CLI permissions; no destructive git ops without approval.
- **Observability:** structured logs + the realtime event stream; live per-run cost/usage (historical cost dashboards = M3).
- **Performance:** live-view updates < 1s end-to-end; concurrency bounded and configurable (v1: serial).
- **Portability:** executor layer abstracts CLIs behind one interface; the extraction LLM sits behind a thin interface (v1: `claude -p`; swappable later).

## 10. Acceptance criteria (v1 "done")

- From a cold start, an operator enters a goal and sees a valid plan tree within the latency target.
- The operator can **review and edit the definition of done** (`goalState` + verify checks + `completionPolicy`) before approving.
- Approving the plan executes it with **Claude Code, serially**, in a per-run worktree, with live telemetry that matches reality (spot-checked against raw CLI logs).
- A deliberately failing action triggers a real replan; a failure the existing pool can't resolve triggers a visible **re-extraction** that adds the needed action.
- When `completionPolicy` requires it, the run waits for operator **sign-off** before being marked succeeded.
- Operator can pause and kill during a run; kills actually terminate subprocesses.
- All runs respect guardrail caps in a forced-loop test (no runaway).
- Goals/plans/runs persist and are replayable after a restart.
- **Gate** metrics (§8) pass; **observed** metrics are reported on the eval set.

## 11. Host recommendation (Proxmox)

Because the orchestrator **executes arbitrary code via agents**, isolation matters. Recommended: a dedicated **unprivileged LXC or VM** on your Proxmox host for the orchestrator + Postgres, with the Claude Code CLI installed and logged in once inside it. Each agent run gets its own **git worktree** — this prevents two runs from writing the same files; it is **not** a security sandbox (an agent running arbitrary, possibly prompt-injected code in a worktree still has the whole host, the logged-in CLI, and any keys). In v1 the **host LXC/VM is the blast radius**: only mount repos/dirs you're willing to expose, and snapshot before risky runs. **At M2**, when parallel + multi-executor execution arrives, add a **per-run container** for real in-host isolation — note that nested containers inside an *unprivileged* LXC need extra config, so a **VM is the cleaner choice if you plan to run containers**.

The instance is **single-user**: reachable only on your own network (or via Tailscale/VPN) behind a **simple admin login** — no LAN-wide or public exposure. Keep the LLM/CLI credentials inside this host only; expose just the web UI/API (behind the admin login). This host is the **auth + execution boundary** described in [`../../docs/06-fork-vs-build-decision.md`](../../docs/06-fork-vs-build-decision.md) §3.

**Guardrail defaults (v1, overridable per-run):** $20/run budget · 5 max replans · ≤ 2 re-extractions/run · 60-min wall-clock · 3 retries/action · concurrency 1 (serial) · loop detection = same action failing the same way twice → stop and escalate.

## 12. Milestones (internal phasing)

- **M0 — Planner core:** generalized A\* + dynamic GoalSpec extraction (incl. `completionPolicy`); plan tree; confirm-criteria gate; dry-run executors. *(doc 05 Phase 1)*
- **M1 — First real executor — *v1 release bar*:** `claude -p` end-to-end with ground-truth verify, real replanning, and bounded re-extraction; serial; per-run worktree; minimal live view + controls (approve/pause/kill); persistence. *(Phase 2)*
- **M2 — Multi-executor + dashboard (fast-follow):** add Codex + Antigravity; per-step routing; dependency-graph parallelism with **per-run container isolation**; full multi-agent dashboard + reassign. *(Phase 3)*
- **M3 — Memory + hardening:** pgvector plan/trajectory memory + retrieval-augmented extraction; historical cost dashboards. *(Phase 4)*

**Status:** M0 and M1 are implemented and green; M2/M3 remain future work.

**Shipped alongside M1 — Universal Repository Goal Packet Compiler (separate subsystem):** a
**read-only** pipeline (`npm run cli`: `request create/validate` → `inspect` → `analyze` →
`compile` → `packet verify`) that takes any supported Git repository (local path or
GitHub-via-`gh`) plus a plain-English goal and emits a schema-valid, tamper-evident, verified
ZIP implementation packet (`repository-goal-packet@1`) containing reports, typed contracts, an
append-only evidence ledger, bounded research records, a tailored master implementation prompt
(default orchestration profile `claude-fable-opus-sonnet@1`: Fable 5 lead, Opus 5
investigation/verification, Sonnet 5 implementation), validation plan, human gates, launch
scripts, manifest, and checksums. Compiler mode never mutates target repositories; unknown
permission/orchestration profiles are rejected fail-closed; actual implementation, push, merge,
deployment, and secret operations remain separate human-approved phases. Contract:
`.claude/specs/packet-compiler.md`; vendored schemas/policies under `schemas/` and `policies/`
(corrections logged in `schemas/README.md`).

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| v1 scope slips | **v1 reduced to single-executor M1** (serial); multi-executor/parallelism/dashboard are M2 fast-follow; cut M3 if needed. |
| **System grades itself** (LLM authors both `goalState` and `verify`) | Operator **confirm-criteria gate** + `completionPolicy` + sign-off (FR-2a, FR-13); verify checks surfaced for review/edit before run. |
| **Agent games the verifier** (edits/deletes its own test to pass) | v1: operator-reviewed `verify` + per-run worktrees. **M2:** hash verify/test files before+after each action, fail on change (verify-integrity gate) + read-only test mounts (ADR-0014). Accepted for v1 (single-user, operator-watched). |
| **Replan can't reach the goal** with the fixed action pool | **Bounded re-extraction** with real failure evidence appends the missing action (FR-7), capped (§8/§11). |
| **`claude -p` JSON not guaranteed** (no forced tool-use) | zod-validate + bounded repair round; track first-try vs post-repair conformance (§8). |
| Runaway loops / cost | Hard caps + loop detection + human approval gates (§8, FR-11). |
| Parallel agents corrupt repos *(M2)* | One worktree/container per run; no shared writers; merge gates. |
| CLI flags / auth behavior change | Abstract behind executor interface; verify flags against current vendor docs; API-key fallback. |
| LLM emits invalid/over-broad actions | Schema validation + repair; action-count cap; mandatory per-action verify. |
| Over-adopting RuFlo footprint | Reuse narrowly (UI + planner); reference only otherwise ([`../../docs/04-ruvnet-ecosystem-evaluation.md`](../../docs/04-ruvnet-ecosystem-evaluation.md)). |

## 14. Resolved decisions

Resolved 2026-06-23 (were open questions):

- **Web-UI auth:** single-admin login on a local LXC/VM; no LAN-wide/public exposure (Tailscale/VPN if remote). §11.
- **Extraction LLM:** headless **`claude -p`** on the user's subscription (no separate API key); strict JSON parsed + zod-repaired; swappable behind a thin interface later. [`.claude/specs/goal-extractor.md`](../.claude/specs/goal-extractor.md)
- **Vendor vs rebuild `goal_ui`:** lift its MIT planner + plan-tree/state-card components liberally where they fit; build the real-event run view fresh; avoid importing mock/Supabase coupling. [`.claude/specs/dashboard.md`](../.claude/specs/dashboard.md), doc 06 §4.
- **Per-run isolation:** git worktrees in v1 (collision-avoidance, not a sandbox); **per-run containers at M2**. §9/§11.
- **Definition of done:** per-goal `completionPolicy` (`verify-only | verify+signoff | operator-defined`) recommended by the extractor, confirmed by the operator. §3, FR-2a/FR-13.
- **Scope:** v1 = M1 single-executor (Claude Code), serial, local single-user. §6/§12.

## 15. References

Internal: [`docs/01`–`08`](../../docs/) (research + blueprint + readiness). External PRD/AI guidance: [PRDs for AI coding agents](https://medium.com/@haberlah/how-to-write-prds-for-ai-coding-agents-d60d72efb797) · [AI PRD template](https://www.productcompass.pm/p/ai-prd-template).
