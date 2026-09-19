---
status: proposed
date: 2026-09-19
decision-makers: KingInYellow
---

# 0018. Verified single-milestone execution is a harness outcome, not a protocol expansion

## Context and problem statement

M1 is recorded complete. Yellow Harness now needs a named next outcome: coordinate one
approved milestone on one repository at one immutable revision, then return a reviewable
patch with independent evidence or a blocker. Existing seams (request/run-event, protocol
v1 stub, packet compiler, plugin bridge) must not be silently stretched into a general
repository executor.

## Decision

Name **verified single-milestone execution** as a post-M1 Yellow Harness outcome. Four
layers, without authorizing real execution in this increment:

1. **Eventual product outcome:** one approved milestone, one repo, one immutable **base**
   revision, one bounded implementation worker → independently verified patch (against a
   recorded discriminated **candidate** identity) or evidence-backed blocker. Merge and
   deployment are never automatic.
2. **Documentation increment (landed in #34):** PRD FR-14–FR-17, this ADR (`proposed`),
   and the VS spec. Establishes semantics only.
3. **First code increment (next, separate authorization):** fixture-only
   acceptance-evidence recording through an existing engine process seam; disposable git
   fixture; deterministic local checks.
4. **Still deferred:** live target-bound execution, Protocol v1 real-run capabilities,
   promoting scratch/`bypassPermissions`, and yellow-plugins host/provider integration.

yellow-goal owns canonical acceptance/evidence semantics; yellow-plugins owns host/provider
integration. A read-only **review** role is distinct from the **verification** process,
which may write disposable test artifacts. The proposed fixture-only acceptance-evidence
recorder (VS spec) is a third, narrower role still: it validates and aggregates
already-observed check evidence into a record and does not execute any check itself. A
successful recording is not itself acceptance — independent verification still decides.
Provider Protocol v1 stays stub-only today. `target.repository` stays non-selecting for
execution. Compiler isolation is unchanged. Worker claims are not world state.

## Alternatives considered

- **Treat M2 as the next named outcome** — wrong capability (multi-executor/dashboard), not what was asked.
- **Expand Protocol v1 to real/target-bound runs now** — contradicts ADR-0017; scratch/`bypassPermissions` must not be the advertised path.
- **Make a PR-readiness report the outcome** — useful prerequisite later; not the named outcome.
- **Skip the PRD and only add Cursor `.cursor` agents** — host bootstrap is not a product requirement and is not independently reviewable from this VM.

## Consequences

- 👍 Product direction is nameable without reopening M1 or protocol v1.
- 👎 First land is documentation; executable independent-evidence emission is a later slice.

## Confirmation

Pending acceptance — all must be true before this ADR moves from `proposed` to `accepted`:

- PRD §7 (FR-14–FR-17) and §12 phasing text exist in `goal-gen/docs/prd.md` and match
  the four-layer model above.
- This ADR file and
  `goal-gen/plans/specs/verified-single-milestone-execution.md` are merged on `main`.
- No protocol `capabilities` array change is bundled with the documentation acceptance.
- Brad explicitly accepts ADR-0018 (documentation-only acceptance does not authorize the
  first code increment).

## Links

- [PRD §12](../prd.md), [verified single-milestone execution spec](../../plans/specs/verified-single-milestone-execution.md)
- [Provider Protocol v1](../../plans/specs/provider-protocol-v1.md), [ADR-0017](0017-provider-protocol-v1-stdio.md)
- [Request-to-run pipeline](../../plans/specs/request-to-run-pipeline.md) (RR13–RR16)
