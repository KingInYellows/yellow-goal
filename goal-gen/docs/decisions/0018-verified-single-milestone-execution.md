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

Name **verified single-milestone execution** as a post-M1 Yellow Harness outcome owned by
yellow-goal documentation and later engine-owned evidence records. Keep Provider Protocol
v1 stub-only. Keep `target.repository` as non-selecting for execution. Keep compiler
isolation. Independent verification is mandatory; worker claims are not world state. Do
not merge or deploy as part of the outcome.

## Alternatives considered

- **Treat M2 as the next named outcome** — wrong capability (multi-executor/dashboard), not what was asked.
- **Expand Protocol v1 to real/target-bound runs now** — contradicts ADR-0017; scratch/`bypassPermissions` must not be the advertised path.
- **Make a PR-readiness report the outcome** — useful prerequisite later; not the named outcome.
- **Skip the PRD and only add Cursor `.cursor` agents** — host bootstrap is not a product requirement and is not independently reviewable from this VM.

## Consequences

- 👍 Product direction is nameable without reopening M1 or protocol v1.
- 👎 First land is documentation; executable independent-evidence emission is a later slice.

## Confirmation

TBD — PRD §12/§7 IDs exist in `goal-gen/docs/prd.md`; this ADR file is accepted; no
protocol `capabilities` array change in the same PR.

## Links

- [PRD §12](../../docs/prd.md), [verified single-milestone execution spec](../../plans/specs/verified-single-milestone-execution.md)
- [Provider Protocol v1](../../plans/specs/provider-protocol-v1.md), [ADR-0017](0017-provider-protocol-v1-stdio.md)
- [Request-to-run pipeline](../../plans/specs/request-to-run-pipeline.md) (RR13–RR16)
