# Review instructions

These rules apply to every pull request review in this repository: the
yellow-review `review-gate` workflow, `/review:pr`, and any other reviewer
that reads this file. They add to `CLAUDE.md`, `goal-gen/CLAUDE.md` and the
component specs under `goal-gen/.claude/specs/`. Reviewers must read this
file from the base branch, not the pull request's head, so a pull request
cannot change how it is reviewed. The yellow-review `review-gate` workflow
does this; any other reviewer should too.

## What Important means here

Mark a finding Important (P0 or P1) when it would break one of the core
invariants in `goal-gen/CLAUDE.md`, spend money or run an agent without
approval, or corrupt a run's evidence. In this repository that includes:

- Anything that lets a real-spend path (`run --executor claude-code`,
  `agx-claude-code`, `run approve`, `npm run runner`) start from CI, a test or
  an autonomous session, or weakens `.claude/hooks/guard-live-executor.mjs`.
- A change to approval, budget, spend-ledger or guardrail code (max replans,
  budget, wall-clock, retries, loop detection) that can let a run exceed its
  approved limits.
- An LLM call inside the planner, or world state set from an action's
  declared effect instead of ground truth (exit codes, test output, diffs).
- An action that can execute without a `verify` check.
- The packet compiler mutating a target repository or importing executor or
  orchestrator mutation code.
- A test, fixture or `verify` edited to make it pass instead of fixing the
  behavior.

Style, naming, wording and refactoring suggestions are Nit at most.

## Cap the Nits

Report at most five Nits per review. Pick the five that matter most.

## Do not report

- Failures CI already reports: type errors (`npm run typecheck`), failing
  tests (`npm test`), eval regressions (`npm run eval`), the install smoke and
  the operator recipe. A green run does not cover a test, fixture or `verify`
  weakened to pass; that is still Important.
- Vendored JSON Schemas under `goal-gen/schemas/` except where the
  corrections log says they were changed on purpose.
- The content of `docs/01`–`08`, `goal-gen/docs/brainstorms/` and
  `HANDOFF-PROMPT.md`.

## Always check

- A change to a component checks its spec in `goal-gen/.claude/specs/`; a
  change to a locked decision comes with a new ADR in
  `goal-gen/docs/decisions/` instead of an edit to an accepted one.
- A planner or extraction prompt change says how `npm run eval` moved.
- Tests and evals use `--executor stub` only.

## Evidence

Every finding about behavior cites the `file:line` that shows it. A finding
inferred from a name, a comment or a guess about a caller is not reported
until the code confirms it.
