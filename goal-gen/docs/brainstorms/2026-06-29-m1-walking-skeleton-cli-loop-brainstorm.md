# Brainstorm — Next Goal: M1 Walking-Skeleton CLI Loop

- **Date:** 2026-06-29
- **Status:** Decided — ready for `/workflows:plan`
- **Topic:** The next goal of the project now that M0 (planner) and the executor de-risk spike are both merged to `main`
- **Decision constraints (from the user):** (1) **walking skeleton first** — get a thin end-to-end loop running, then harden each component; (2) **pure Node CLI shell** — a single `runner.ts`, stdout-only, no HTTP server / DB / frontend in this slice

## Context

Two milestones just landed on `main`:

- **M0 — deterministic planner (done):** `backend/src/planner/{plan,simulate,types}.ts`, green at the **70/70** eval gate (`npm run eval:planner`, `tests/evals/planner/`). A\* over symbolic state, no LLM inside.
- **M1 de-risk spike (done):** `tests/spikes/executor-spike.ts` + `tests/spikes/executor-spike-findings.md` proved the headless `claude -p` execution mechanics end-to-end inside an isolated git worktree.

The M1 critical path (per `docs/prd.md` §6/§12) is the single-executor core: **extract → plan → confirm DoD → execute → verify → replan**, `claude -p` only, serial. With the planner built and the executor mechanics proven, the remaining work is mostly **wiring the loop together plus a minimal extractor** — exactly the kind of integration risk a walking skeleton surfaces earliest.

### Spike learnings that constrain this slice (from `executor-spike-findings.md`)

- **Ground-truth detection must use `git status --porcelain` (non-empty) OR a moved HEAD — NOT `git diff <initialSHA>`.** The agent creates new *untracked* files and does not commit; plain `git diff`/`--quiet` ignore untracked files and yield a false "no change". (This corrects the assumption in the 2026-06-23 brainstorm, which assumed a non-empty `git diff` would suffice.)
- `tsc`-green ≠ `node --experimental-strip-types`-runnable (TS parameter properties are rejected by the strip-types runtime).
- A trivial non-`--bare` `claude -p` action costs **~$0.08**, dominated by context cache-creation, not the task.
- The real `--output-format json` envelope has **20 top-level keys** (`total_cost_usd`, camelCase `modelUsage`, …).
- `claude -p` has **no server-side forced tool-use**, so strict JSON from the extractor is prompt-enforced + **zod-repaired**, never guaranteed.

## Decision — the goal

**Build a thin CLI walking skeleton of the M1 loop.**

A single `runner.ts` invoked as `npx tsx backend/src/runner.ts "<goal>"` that wires the full **extract → plan → confirm-DoD → execute → verify → replan** cycle with structured stdout and zero server / DB / UI. The script is the demo *and* the integration-test harness; every invocation is a real end-to-end probe.

### Built for real in this slice

- **Minimal `claude -p` extractor** — strict-JSON prompt → **zod** validation → one repair round. Authors the action graph (`Action[]` with `verify`); the LLM only *authors*, never plans.
- **Serial single-executor in a per-run git worktree** — drives `claude -p` per action; ground truth via `git status --porcelain` / moved HEAD (per spike findings), never a declared effect.
- **Reuse the existing planner directly** — the runner calls `plan()`; no changes to M0.
- **Confirm-DoD gate (FR-2a)** — a simple stdin **y/n** prompt before execution. No UI needed.
- **Replan trigger** — on verify-fail, re-run the deterministic planner over the existing action pool; on no-plan, call the extractor to author **additional** actions (append-only), **capped at 2 re-extractions**. The *decision* to re-extract stays deterministic (no-plan / N failures).
- **Minimal guardrails** — per-run iteration cap + a rough USD budget ceiling, so a runaway loop self-terminates.

### Stubbed / deferred (explicitly out of scope)

- Persistence / resume (no Postgres yet — a crashed run is gone)
- HTTP API + React frontend / live-view streaming
- The full guardrail suite (wall-clock, loop detection, per-action retry, max-replans tuning)
- Multi-executor (Codex, Antigravity) and per-step routing — `claude -p` only

### Module layout (promotes cleanly to M1 production)

`extractor`, `executor`, and `orchestrator` live as clean importable modules under `backend/src/` — **no business logic leaks into `runner.ts` itself**, which is a thin entry point. The later HTTP API wraps the same modules without a rewrite. Types-first: `GoalSpec` / `Action` / `WorldState` / `Plan` per `.claude/specs/planner.md`, with extractor output zod-validated.

## Approach (chosen: A — inline CLI runner)

- **A — Inline CLI runner (chosen):** one self-contained script wires extractor + executor + minimal orchestrator inline, calling the existing planner. Zero infra; each seam (extractor JSON repair, verify oracle, replan trigger) is exercised and observable immediately; modules stay importable for the future API. Matches "walking skeleton first" + "pure Node CLI" exactly.
- **B — Modular components, no runner (rejected):** build each component fully with unit tests before wiring. Hides integration bugs — the riskiest kind here — until all three are done, and yields no demoable loop. Contradicts "walking skeleton first."
- **C — Thin API first, runner second (rejected):** stand up Hono + `POST /run` before the loop is proven. Adds HTTP boilerplate ahead of the actual risk and slows the first observable run. Can always wrap Approach A's runner later.

## Riskiest wiring seams (resolve during the slice)

- **Extractor JSON reliability + zod-repair rate** — `claude -p` has no forced tool-use; how often does the strict-JSON prompt need repair, and does one repair round suffice?
- **The verify → replan boundary** — precisely what trips a *plain replan* (re-run planner over existing pool) vs. a *re-extraction* (author additional actions). The decision must stay deterministic.
- **Worktree lifecycle / cleanup** — clean create/teardown per run with no leaked refs or temp dirs (ADR 0009), and correct ground-truth read inside the worktree.
- **Per-action cost** — ~$0.08 floor per trivial `claude -p` action; the budget ceiling must account for the context-cache-creation cost, not just task size.

## Rough slice breakdown

1. **`runner.ts` skeleton + types** — CLI entry, arg parsing, structured stdout log; import `plan()`; stub extractor/executor returning fixtures so the loop shape runs end-to-end first.
2. **Extractor** — `claude -p` strict-JSON prompt → zod schema → one repair round; emits a validated `Action[]` / `GoalSpec`.
3. **Executor** — per-run worktree create/teardown; drive `claude -p` per action; ground-truth read via `git status --porcelain` / moved HEAD; run each action's `verify`.
4. **Orchestrator loop** — extract → plan → confirm-DoD (stdin y/n) → execute → verify → replan, with the iteration cap, budget ceiling, and capped re-extraction wired in.
5. **End-to-end probe** — run against a trivial real goal in a scratch repo; confirm the loop completes, replans on an injected verify-fail, and self-terminates at the caps.

## Risks / open questions

- Does a single zod-repair round give acceptable extractor reliability, or is a second pass / few-shot needed?
- What's the right *minimal* `WorldState` ↔ ground-truth mapping for the first slice (exit code + porcelain status + verify outcome) without over-building?
- How is the confirm-DoD criterion represented — free text echoed back, or a structured checklist — given there's no UI yet?
- Budget/iteration cap defaults for the skeleton (CLAUDE.md v1 defaults are $20/run · 5 replans · ≤2 re-extractions · 3 retries/action — which subset is worth enforcing in slice one)?
- Does `runner.ts` run under `tsx` cleanly given the strip-types caveat from the spike (use `tsx`, not `node --experimental-strip-types`)?

## Next step

Run `/workflows:plan` against this brainstorm to produce the implementation plan for the `runner.ts` walking skeleton and its `extractor` / `executor` / `orchestrator` modules. Consider seeding `.claude/specs/executor-router.md` from the spike findings as part of that plan.
