# Brainstorm — Next Work Item: Executor De-Risk Spike

- **Date:** 2026-06-23
- **Status:** Decided — ready for `/workflows:plan`
- **Topic:** The next logical work item to finish in the next session
- **Decision constraint:** De-risk first (tackle the highest-unknown component before building production code around it)

## Context

M0 is complete: the deterministic A\* GOAP planner ships green at the 52/52 eval
gate (`backend/src/planner/{plan,simulate,types}.ts`, `tests/evals/planner/`).
The M1 critical path (per `docs/prd.md` §6/§12) is the single-executor core:
extract → plan → confirm DoD → execute → verify → replan, `claude -p` only,
serial.

The highest-uncertainty seam on that path is the **executor + ground-truth
verification** boundary: can headless `claude -p` actually be driven to make a
change inside an isolated git worktree, and can its real result (exit code,
diff, test outcome, cost) be captured as ground truth rather than a declared
effect? Designing the production `Executor` interface before answering this
risks baking in a wrong contract.

## Decision — the work item

**A throwaway de-risk spike: `tests/spikes/executor-spike.ts`.**

A single TypeScript/Node script that proves the executor mechanics end-to-end
against the host `claude` CLI, in full isolation, and freezes the learnings into
a findings doc that becomes the spec input for the later production `Executor`
session.

### Flow

1. Create a throwaway `git init` repo in a temp dir, make an initial commit, and
   create a **git worktree** off it. (Exercises ADR 0009 worktree
   create/teardown; zero contact with the goal-gen repo or its history.)
2. Spawn `claude -p --output-format json` in the worktree with the prompt:
   *"add a pure `add(a, b)` function and a passing unit test."*
3. Capture **exit code, stdout, stderr, and cost/usage** from the JSON envelope.
4. Assert a **non-empty `git diff`** in the worktree — ground truth (invariant
   #2: state from real output, never a declared effect).
5. Run the added test as the **`verify`** step (invariant #3: no verify → not
   executable).
6. Tear down the worktree + temp dir.
7. Write `tests/spikes/executor-spike-findings.md` capturing the concrete
   learnings.

### Target task

Trivial synthetic — "add a pure `add(a, b)` function + a passing unit test."
Fully controlled, instantly verifiable, no real-repo risk.

### Sandbox

Completely isolated scratch `git init` repo in a temp dir (cleanest blast
radius), with the trivial task run *inside* it.

## Scope

**In scope:** the spike script, a real `claude -p` headless run in an isolated
worktree, ground-truth capture (exit/diff/test/cost), worktree teardown, and the
findings doc.

**Out of scope (explicitly):** production `Executor` interface, goal-extractor,
orchestrator loop, persistence/API, frontend. Learnings *inform* the design of
these later rather than committing to it now.

## Approach (chosen: A — focused spike script)

- **A — Focused spike script (chosen):** throwaway script, zero
  production-interface commitment, all unknowns answered, findings doc feeds the
  design. Matches "de-risk first" exactly.
- **B — Spike + thin interface sketch (rejected):** shapes the `Executor`
  signature before seeing real `claude -p` output → premature.
- **C — Spike + extractor JSON probe (rejected):** two high-risk probes in one
  session dilutes a clean single-unknown spike and risks running out of time if
  headless `claude -p` surprises.

## Definition of Done

- Spike runs end-to-end against the host `claude` CLI (logged in, headless).
- `tests/spikes/executor-spike-findings.md` records, concretely:
  - exact `claude -p` flags used;
  - the `--output-format json` envelope shape;
  - exit-code semantics (success vs. partial vs. failure);
  - where cost/usage lives in the JSON;
  - worktree setup/teardown commands that worked;
  - any auth/headless gotchas.
- Those learnings are sufficient to seed the production `Executor` interface
  design session.

## Risks / open questions to resolve during the spike

- `claude -p` headless reliability — does it actually complete the change, and
  how are partial completions surfaced?
- Output format stability — text vs. `--output-format json`/`stream-json`; exact
  field names for result, cost, and usage.
- Worktree teardown correctness — clean removal without leaking refs/temp dirs.
- Auth in headless mode on the host (subscription `claude -p`, no API key).

## Next step

Run `/workflows:plan` against this brainstorm to produce the implementation plan
for `tests/spikes/executor-spike.ts` + the findings doc.
