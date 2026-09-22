---
status: accepted
date: 2026-09-21
decision-makers: KingInYellow
---

# 0019. Operator Path A/B recipe is a third CI gate

## Context and problem statement

ADR-0016 locked two CI jobs (`engine` and `install-smoke`) plus the npm-tarball install
story. `install-smoke.sh` section 11 is fixture capture-source, not the documented operator
Path A / Path B fences. After `#43` landed, Pack→Install and those fences had no CI-wired
execution of the runbook blocks themselves. Editing accepted ADR-0016 in place is forbidden
(`CLAUDE.md`: supersede rather than edit).

## Decision

Add a third CI job `operator-recipe` that runs
`scripts/operator-committed-source-paths.sh`. That helper is what
`docs/operator-committed-source.md` invokes. It extracts and executes the documented
Path A / Path B fences plus the Pack→Install state analog. Temporary fixtures only.
Does not `npm run runner`. Does not pack recorded `6ac355f` as the recorded artifact.

ADR-0016 remains the historical decision for the original two jobs, the tarball install
story, and probe-safety (`*.probe.ts` stays outside `npm test`). This ADR adds the
operator-recipe gate only.

## Alternatives considered

- **Edit ADR-0016 in place** — rejected; accepted ADRs are immutable.
- **Fold Path A/B into `install-smoke.sh`** — rejected; that script is the pack → install
  → spawn contract, not the operator runbook.

## Consequences

- 👍 CI now executes the documented operator fences, not a rewritten smoke approximation.
- 👎 One more GitHub Actions job (and the same job on Release before publish).
- ADR-0016 is superseded for CI job inventory; its install-story and probe-safety text
  stay historical.

## Confirmation

`.github/workflows/ci.yml` job `operator-recipe` and
`.github/workflows/release.yml` job `operator-recipe` run
`bash scripts/operator-committed-source-paths.sh`.

## Links

- ADR-0016 (historical two-job CI + tarball install)
- `docs/operator-committed-source.md`
- `scripts/operator-committed-source-paths.sh`
