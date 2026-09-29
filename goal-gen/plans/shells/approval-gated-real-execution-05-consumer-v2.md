---
spec: plans/specs/approval-gated-real-execution.md
spec-r-ids: [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R21, R22, R23, R24, R25, R26, R27, R28, R29, R30, R31, R32, R33, R34, R35]
depends_on: [approval-gated-real-execution-04-protocol-v2-and-release]
---

# Plan: Consumer v2 (yellow-plugins)

## Context
The paired half of step 6. The yellow-plugins consumer spawns the released engine across a
process boundary and today always runs `--executor stub --protocol v1`. This shell pins the v2
release, moves all consumer commands to protocol v2, validates the real-run stream, and adds a
user-only command that displays the engine-rendered manifest and forwards an operator-supplied
approval path, with no way to mint one.

**Location:** this plan is expanded and archived in yellow-goal (so dependency tracking works);
the code PR lands in yellow-plugins, and archival cites that PR by number via the
`/plan:complete` override.

## Produces
- Pin to the released v2 engine; blocking compatibility gate green on it
- v2 discovery for all consumer commands (stub and real); existing stub command's user-visible behaviour unchanged
- Validators for v2 capabilities, real-run `run.start`, spend events and terminal agreement (reject missing `approvalId`, `simulation: true`, `targetRepositoryHonored: true`); accept the phase-dependent evidence of R24 (no spend/bundle on pre-spawn failures, structured refusal errors without `run.start`)
- User-only real-run command (`disable-model-invocation: true`): manifest display, approval-path forwarding, no `--yes`, spend and bundle-path reporting
- Fake-engine tests only; stub command still refuses user-selected executor or protocol

## Consumes
- Released v2 engine tarball, v2 capabilities and event shapes, `run manifest` verb — from Shell approval-gated-real-execution-04-protocol-v2-and-release
- yellow-plugins consumer runtime, pin, validators, command conventions — from existing codebase (yellow-plugins)

## Covers Spec Requirements
- R28
- R29
- R30
- R31

## Implementation Steps (High-Level)
1. **Pin** — bump to the v2 release; compatibility gate on the new pin.
2. **Discovery and validators** — v2 for all commands; real-run start, spend and terminal validation.
3. **Stub command** — keep behaviour unchanged under v2; keep refusing user executor/protocol flags.
4. **Real-run command** — user-only command; manifest display; approval forwarding; reporting; fake-engine tests.

## Open Questions
- None
