---
spec: plans/specs/approval-gated-real-execution.md
spec-r-ids: [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R21, R22, R23, R24, R25, R26, R27, R28, R29, R30, R31, R32, R33, R34, R35]
depends_on: [approval-gated-real-execution-01-approval-foundation, approval-gated-real-execution-02-executor-hardening, approval-gated-real-execution-03-real-run-orchestration]
---

# Plan: Protocol v2 and release

## Context
Protocol v1 promises zero spend, so real runs get a new `yellow-goal/provider-protocol/v2` that is
a superset of v1: v2 stub runs equal v1 stub runs, and a real run is a distinct, explicitly
selected capability. v1 stays byte-identical. This shell exposes the real-run engine through v2,
proves the operator runbook in CI against the fake worker, and releases the tarball the consumer
will pin.

## Produces
- `provider-protocol/v2` identity; `capabilities --json --protocol v2` lists supported protocol ids and the real-run capability (unselected `capabilities --json` stays byte-identical, R22)
- v2 stub parity with v1; v1 golden tests unchanged
- v2 real-run invocation (dedicated `agx-claude-code` executor, profile, approval path, bundle directory); `--yes` rejected on real runs; approval replaces the DoD confirm
- v2 `run.start` for real runs (executor, `simulation: false`, `targetRepositoryHonored: false`, `approvalId`, profile digest, caps); phase-dependent evidence per R24 (spend event only after a spawn, bundle path only on `verification-rejected`/`verified`, pre-start refusals as structured errors with no `run.start`)
- `--protocol v1` still requires `--executor stub`; legacy `--executor claude-code` neither advertised nor reachable from v2 (rejected without spawn under `--protocol v2`)
- Completed operator runbook and an operator-recipe-style CI job running it against the fake worker through the shell 02 test-only harness entry point, never the production bin with an env/`PATH` override (ADR-0019 pattern)
- Engine version bump and released tarball (ADR-0016)

## Consumes
- Approval verbs and verifier — from Shell approval-gated-real-execution-01-approval-foundation
- Fake worker — from Shell approval-gated-real-execution-02-executor-hardening
- Real-run engine and outcome model — from Shell approval-gated-real-execution-03-real-run-orchestration
- Provider Protocol v1 CLI, capabilities, event writer — from existing codebase
- Release workflow and tarball install smoke — from existing codebase

## Covers Spec Requirements
- R22
- R23
- R24
- R25
- R26
- R27
- R33

## Implementation Steps (High-Level)
1. **Identity and discovery** — v2 id, supported-protocols only in `capabilities --json --protocol v2`, v1 goldens (incl. unselected `capabilities --json`) pinned.
2. **Stub parity** — v2 stub runs mirror v1.
3. **Real-run surface** — invocation, start payload, spend and outcome events, gate behaviour, `--yes` rejection.
4. **Legacy isolation** — v1 executor rule kept; legacy path unadvertised and unreachable from v2.
5. **Runbook and CI** — finish the runbook; operator-recipe job exercises it end-to-end against the fake worker via the test-only harness.
6. **Release** — version bump, gates, released tarball with hash evidence.

## Open Questions
- None
