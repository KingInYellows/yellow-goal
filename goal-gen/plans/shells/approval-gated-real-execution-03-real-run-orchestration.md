---
spec: plans/specs/approval-gated-real-execution.md
spec-r-ids: [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R21, R22, R23, R24, R25, R26, R27, R28, R29, R30, R31, R32, R33, R34, R35]
depends_on: [approval-gated-real-execution-01-approval-foundation, approval-gated-real-execution-02-executor-hardening]
---

# Plan: Real-run orchestration and verification

## Context
With approval (shell 01) and a hardened executor (shell 02) in place, this shell composes the
real run: verify and consume the approval, seed a scratch worktree from the profile, make exactly
one worker attempt on a fixed goal, meter it, extract a candidate from allowed paths only, and
judge it with the existing `acceptance verify-candidate`. The worker's narrative never decides
success; nothing is accepted, committed or published.

## Produces
- Real-run engine with the fixed order: recompute manifest, verify approval, env guard, consume, seed worktree, one spawn, ledger, extract, verify, outcome, cleanup
- Profile-seeded scratch worktree (byte-identical base files; no `target.repository` access)
- Fixed one-action goal from milestone text (no extractor; single-attempt, no retries/replans/remediation)
- Timeout, wall-clock and signal handling with SIGTERM to SIGKILL escalation
- Append-only spend ledger (one entry per spawn)
- Bundle and spend-ledger destinations bound into the manifest (R8a): canonical paths in `manifestHash`, pre-spawn refusal of destinations inside `target.repository`/the worktree or through symlinks, no-follow exclusive evidence writes
- Allowed-paths-only candidate builder with `outOfScopeChanges` evidence; each allowed path opened descriptor-relative with no-follow/non-blocking flags, `fstat`-checked as a regular file and byte-capped before reading (symlink, FIFO and oversize fixtures → `worker-failed`)
- Verifier hand-off producing a bundle in an operator-specified directory
- Outcome model: `refused`, `worker-failed`, `verification-rejected`, `verified` (awaiting human)

## Consumes
- Manifest builder, approval verifier, consumption marker, `approvalId` — from Shell approval-gated-real-execution-01-approval-foundation
- Hardened executor options, new profile version, fake worker, probe result (caps and settings decision) — from Shell approval-gated-real-execution-02-executor-hardening
- `createWorktree({seedFiles})` — from existing codebase
- `acceptance verify-candidate` and bundle writer — from existing codebase

## Covers Spec Requirements
- R8a
- R8
- R9
- R10
- R14
- R16
- R17
- R18
- R19
- R20
- R21

## Implementation Steps (High-Level)
1. **Run skeleton** — the fixed step order with refusals before consumption and no spawn before consumption.
2. **Worktree and goal** — profile-seeded scratch worktree; one-action goal from milestone text; single-attempt policy.
3. **Execution bounds** — timeouts, wall-clock, signals; cancelled runs keep the approval consumed.
4. **Ledger** — spend entry per spawn with `approvalId`, model, cost, turns, duration, exit class.
5. **Candidate and verification** — allowed-paths-only extraction with safe opens (no-follow, non-blocking, regular-file and size checks), `outOfScopeChanges`, verifier hand-off, bundle directory.
6. **Outcomes and cleanup** — four outcome kinds with evidence; no accept verb; worktree removal; fake-worker tests for every outcome.

## Open Questions
- None
