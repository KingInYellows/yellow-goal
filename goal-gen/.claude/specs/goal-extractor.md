# Spec — Goal Extractor (LLM → GoalSpec)

**Component:** `backend/src/extractors/` · **Depends on:** headless **`claude -p`** (subscription auth; no API key) behind a thin LLM interface — swappable to an API/OpenAI-compatible client later. **Consumed by:** api → planner.
**Principle:** the LLM authors the action graph here; everything downstream is deterministic.

## Purpose
Turn a plain-English goal (+ optional config) into a schema-valid `GoalSpec` (see `planner.md`): success criteria as `goalState`, `constraints`, and a **dynamic candidate action pool** with preconditions, effects, costs, recommended executor, and a `verify` check per action. This is the capability the `goal.ruv.io` demo mocks with a fixed 7-step template — here it is dynamic.

## Input
```ts
interface ExtractRequest {
  goalText: string;
  config?: {
    depth?: 'surface'|'moderate'|'deep';
    constraints?: string[];               // operator-supplied (budget, "open a PR not push", allowed paths)
    preferredExecutor?: ExecutorKind;     // optional global hint
    repoPath?: string;
  };
}
```

## Output
A `GoalSpec` (see `planner.md`), including a recommended `completionPolicy` (`verify-only | verify+signoff | operator-defined`). Must pass **zod** validation before returning. The operator can review/edit `goalState`, each `verify`, and `completionPolicy` before planning (see `api.md` confirm-criteria step).

## Behavior
- Single structured LLM call via **`claude -p --output-format json`**. Note: `claude -p` has **no server-side forced tool-use** like the Claude API, so strict JSON is **prompt-enforced**, then parsed from the result and **zod-validated** — the repair round (below) is load-bearing, not a rare path.
- Prompt instructs the model to: (1) restate the goal as `goalState` predicates (definition of done); (2) list `constraints`; (3) propose a **minimal sufficient** action pool, each with `preconditions`, `effects`, integer `cost`, a recommended `executor`, and a concrete `verify` check (a shell/test command or a success predicate); (4) keep `initialState` to goal-relevant facts only; (5) recommend a `completionPolicy` (use `verify-only` when verify checks are unambiguous, `verify+signoff` when human judgement matters, `operator-defined` when criteria are unclear).
- **Validation + repair:** validate against the `GoalSpec` schema; on failure, do one bounded repair round (feed the validation errors back); if still invalid, return a structured error. Track first-try vs post-repair conformance (PRD §8).
- **Re-extraction (`expand`):** `expand(goalText, currentState, failureEvidence, existingPool)` is called by the orchestrator when re-planning over the existing pool yields no plan (or after N failed replans on a subgoal). It authors **additional** actions only (append to the pool — never discard prior actions, to keep runs repeatable), grounded in the **real failure evidence** (stderr / failing verify output / diff) so it adds the *right* action (e.g. sees `ModuleNotFoundError` → adds an install step). Bounded by the per-run re-extraction cap (PRD §11).
- **Caps:** reject/repair specs exceeding a max action count; require every action to have a `verify`.
- **Memory (M3, optional):** retrieve top-K similar past `GoalSpec`+outcome from pgvector and include as few-shot context so plans improve over time.

## Error / edge cases
- Vague/empty goal → ask for clarification upstream (api returns a needs-clarification state) rather than hallucinating actions.
- Model returns prose / invalid JSON → repair round → structured error if still bad (never pass junk to the planner).
- Over-broad goal (e.g., "build me a startup") → cap actions and surface a "goal too broad / please scope" result.
- LLM provider error/timeout → retry with backoff; surface failure; never fabricate a spec.

## Acceptance criteria
- ≥ 95% schema conformance on the extractor eval set (PRD §8), with first-try vs post-repair tracked separately (the `claude -p` path leans on repair).
- Every returned action has preconditions, effects, cost > 0, an executor, and a verify check; every `GoalSpec` carries a `completionPolicy`.
- Produces distinct action graphs for distinct goals (not a fixed template).
- `expand` adds only new actions grounded in the supplied failure evidence; never mutates or drops existing ones.
- Deterministic enough to test: with temperature pinned + a fixed prompt, snapshot key fields on the eval set.

## Out of scope
Planning/ordering (planner), execution (orchestrator/executors), UI.
