# Claude Code handoff — M0 (the planner)

This repo was scaffolded in a planning session (specs, ADRs, and the planner eval harness). The next phase — implementing components against the specs and the eval gate — is a Claude Code job. M0 needs neither the coding-agent CLIs nor a database.

**Setup:** `git init` at the project root (see CONTRIBUTING.md), then open Claude Code in the repo and run commands from `goal-gen/`. Paste the block below into a fresh Claude Code session.

---

You are building the **GOAL Generator**, a spec-driven TypeScript project. Read these first, in order — absorb, don't summarize:

- `CLAUDE.md` (constitution) and `AGENTS.md`
- `docs/prd.md` (scope; we are at M0 → M1, see §6/§12)
- `.claude/specs/planner.md` (the component you're implementing) and `.claude/specs/goal-extractor.md`
- `docs/decisions/0004-deterministic-planner.md`, `0007-hybrid-replanning.md`, `0012-metrics-gate-vs-observed.md`, `0013-eval-tooling.md`
- `tests/evals/planner/README.md`, then skim the fixtures under `tests/evals/planner/fixtures/`

## Task — M0 part 1: implement the planner
Implement `backend/src/planner/plan.ts` — a deterministic **forward A\*** GOAP planner — per `.claude/specs/planner.md`, until the eval gate passes.

**Done =**
- `npm run eval:planner` passes the gate: **plan-validity ≥ 98%** (≥ 51/52 fixtures; aim for 52/52).
- The determinism / validity / no-plan **property tests** (`tests/evals/planner/properties.test.ts`) pass — they auto-enable once `plan()` is implemented.
- `npm run typecheck` is clean.

**Rules:**
- The planner is **pure and deterministic** — no LLM, no I/O.
- **Do not modify** the fixtures, the oracle (`simulate.ts`), or any test to make things pass. If you believe a fixture is wrong, stop and flag it. If behavior must change, update `planner.md` (and add/supersede an ADR) first.
- The `multi-effect` fixtures expose the heuristic-admissibility edge (h = unmet-predicate count is inadmissible when one action satisfies several goal predicates) — use **BFS mode** there per `planner.md`, or document any relaxation of those cost bounds.
- Derive the `dependsOn` dependency graph from precondition/effect chains so the orchestrator can later parallelize.

**Workflow:** Plan Mode first (sketch the A\* search, closed-set state keying, and dependency-graph derivation), then implement, then run the evals, then commit. Review the final diff in a fresh subagent. Keep `CLAUDE.md` commands current as you wire up scripts.

## Task — M0 part 2: the goal-extractor (needs `claude` logged in on the host)
Per `.claude/specs/goal-extractor.md`: drive **`claude -p`** for extraction (no API key — ADR-0006), zod-validate with one bounded repair round, and recommend a `completionPolicy`. Add a **promptfoo** config under `tests/evals/extractor/` measuring schema-conformance (first-try vs post-repair) per ADR-0013.

## Stay in scope
M0 = planner + dynamic extraction + dry-run executors. **Do not** build real executors, the orchestrator loop, or the dashboard yet — those are M1/M2 (`docs/prd.md` §12). When M0 is green, the M1 handoff is: implement `ClaudeCodeExecutor` + ground-truth verify + the orchestrator replan/re-extraction loop, on the host.
