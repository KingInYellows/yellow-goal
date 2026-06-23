# Planner eval set

The regression + gate suite for the deterministic A\* GOAP planner.
Source of truth for behavior: [`.claude/specs/planner.md`](../../../.claude/specs/planner.md); decisions: [ADR-0004](../../../docs/decisions/0004-deterministic-planner.md), [ADR-0012](../../../docs/decisions/0012-metrics-gate-vs-observed.md), [ADR-0013](../../../docs/decisions/0013-eval-tooling.md); metrics: PRD §8.

## Why it's shaped this way

A deterministic planner can produce **several equally-optimal plans**, so exact-matching one "golden" plan over-fits. Instead we validate plans against **structural properties** with a native `simulatePlan()` oracle (`backend/src/planner/simulate.ts`) — the same idea as the classical-planning validator VAL, reimplemented in TS rather than taken as a dependency. We assert: goal reached, preconditions hold at each step, cost ≤ a known bound, partial-order/dependency correctness, acyclic `dependsOn`, and a clean `null` for unsatisfiable goals.

## Eval-driven status

The planner does not exist yet (`backend/src/planner/plan.ts` is a stub). So:

- **Run now (green):** the oracle unit tests (`simulate.test.ts`) and the fixture-integrity checks in `planner.eval.test.ts`.
- **Auto-skipped until `plan()` is implemented (M0):** the per-fixture planner suite and the `fast-check` property suite. They light up automatically once `isPlannerImplemented()` returns true — no test edits needed.

## Run

```bash
npm install          # first time
npm run eval:planner # just this suite
npm test             # everything
```

Current state: **15 passed, 56 skipped** (planner unimplemented).

## Fixtures

One YAML file per tier under `fixtures/`, each a list of cases. Cases use a **minimal action shape** (`id`, `cost`, `preconditions?`, `effects?`) because the planner only reasons over those; `toGoalSpec()` (`fixtures.ts`) hydrates `executor`/`payload`/`verify`/`completionPolicy` defaults into a schema-valid `GoalSpec`.

```yaml
- id: linear-clone-install-build
  tier: linear
  goalText: "Build the project"
  goalState: { build_pass: true }
  actions:
    - { id: clone, cost: 1, effects: { repo_cloned: true } }
    - { id: install, cost: 2, preconditions: { repo_cloned: true }, effects: { deps_installed: true } }
    - { id: build, cost: 2, preconditions: { deps_installed: true }, effects: { build_pass: true } }
  expect:
    hasPlan: true            # false ⇒ planner must return null
    costUpperBound: 5        # optional: optimal cost (sub-optimal plans fail)
    requiredOrder: [[clone, install], [install, build]]  # optional causal partial order
```

## Composition (52 cases — ≥50 floor per ADR-0012; grow toward ~70)

| Tier | Cases | What it stresses |
|---|---|---|
| trivial | 6 | baseline effect application; already-satisfied (empty plan); distractor actions |
| linear | 8 | precondition-chain ordering |
| branching | 8 | independent branches joining; many valid interleavings (partial-order asserts) |
| parallel | 6 | fully independent branches (no inter-branch deps) |
| multi-effect | 6 | actions with >1 effect; heuristic-inadmissibility edge (needs BFS mode for optimal) |
| min-cost | 6 | multiple paths; must pick the cheapest |
| unsatisfiable | 8 | no plan exists ⇒ clean `null` (missing producer, deadlock, cycle, wrong value…) |
| stress | 4 | long chains, wide goals, many distractors, deep two-branch join |

Every case is independently checked (a separate solver confirmed each solvable case is reachable within its bound and each unsatisfiable case truly has none).

## When you implement the planner (M0)

1. Implement `plan()` in `backend/src/planner/plan.ts` per `planner.md`.
2. The skipped suites activate automatically. Target: **plan-validity GATE ≥ 98%** (PRD §8) — i.e. ≥ 51/52 cases pass.
3. For `multi-effect` cases, the unmet-predicate heuristic is inadmissible — use BFS mode (or accept non-optimal and relax those bounds, documenting the choice).
4. Add an `npm run eval` step to CI as the regression gate on planner/extractor changes (ADR-0013).
