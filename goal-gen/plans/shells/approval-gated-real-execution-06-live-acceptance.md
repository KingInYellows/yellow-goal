---
spec: plans/specs/approval-gated-real-execution.md
spec-r-ids: [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R21, R22, R23, R24, R25, R26, R27, R28, R29, R30, R31, R32, R33, R34, R35]
depends_on: [approval-gated-real-execution-04-protocol-v2-and-release]
---

# Plan: Live acceptance run (human-run)

## Context
The single spend-incurring proof of step 6. A human operator runs the released engine once on the
`config-repair` profile with sonnet, subscription auth and a $5 total cap, following the runbook,
then reproduces the bundle in a fresh process and makes the accept call. An autonomous session
may prepare the evidence template and the docs PR, but never runs the worker.

## Produces
- Recorded approval, spend ledger, bundle, `acceptance reproduce` result and measured cost under the workspace `runtime/`
- Docs PR capturing the results, the observed `acceptEdits` behaviour, and the operator's accept decision
- Follow-up note for retiring the legacy `--executor claude-code` path

## Consumes
- Released v2 engine, runbook, approval verbs, real-run surface — from Shell approval-gated-real-execution-04-protocol-v2-and-release

## Covers Spec Requirements
- R35

## Implementation Steps (High-Level)
1. **Prepare** — evidence template and pre-run checklist from the runbook (no spend).
2. **Operator run** — the human approves at a terminal and runs the real run once within the approved caps.
3. **Reproduce and decide** — the human runs `acceptance reproduce` in a fresh process and records the accept decision.
4. **Record** — docs PR with the evidence and measured cost; open the legacy-path retirement follow-up.

## Open Questions
- None
