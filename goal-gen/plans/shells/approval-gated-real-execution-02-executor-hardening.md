---
spec: plans/specs/approval-gated-real-execution.md
spec-r-ids: [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R21, R22, R23, R24, R25, R26, R27, R28, R29, R30, R31, R32, R33, R34, R35]
depends_on: []
---

# Plan: Executor hardening and permission probe

## Context
The existing `ClaudeCodeExecutor` builds `claude -p` argv without budget or tool-allowlist flags,
hardcodes the `claude` command, and passes the full parent environment (so `ANTHROPIC_API_KEY`
silently switches billing). The `config-repair` profile has no worker prompt. This shell adds
those controls, a new profile version carrying milestone text, and a fake worker so CI never
spends. It ends with the human-run permission probe, which decides whether `acceptEdits` plus an
allowlist is viable before orchestration is built on it.

## Produces
- New `config-repair` profile version with milestone text and its own digest; existing version byte-identical (reproduce regression test)
- Executor options: `--allowedTools`/`--disallowedTools` from caller, `--max-budget-usd`, auth-mode env guard in both directions (`AUTH_MODE_MISMATCH` before spawn: key present without `api-key` mode, or `api-key` mode without the key), injectable worker command (constructor option, never env/argv/`PATH`), missing-cost reported as a distinct failure class
- Real-run permission resolution that can only yield `acceptEdits` (unit + static regression test against `bypassPermissions`)
- Filesystem confinement for the worker (R11): the chosen mechanism — path-scoped permission rules limiting filesystem tools to the scratch worktree, or an OS sandbox — plus a pre-spawn refusal for manifests whose filesystem tools are not path-scoped, and a negative fixture proving a host path outside the worktree cannot be read or written
- Fake worker replaying recorded envelopes: success, error result, budget stop, max turns, permission denial, malformed output, missing cost
- Test-only process harness entry point (outside the packaged `bin`, excluded from the tarball) that runs the engine with the fake worker injected, plus a static test that the production bin never imports it (R15/R33)
- Probe procedure and a recorded probe result (human-run)

## Consumes
- `ClaudeCodeExecutor`, ADR-0015 narrowing, spawn/timeout handling — from existing codebase
- Candidate-offline profiles and digest — from existing codebase
- ADR-0010 guardrail defaults — from existing codebase
- Executor spike findings (envelope shapes) — from existing codebase

## Covers Spec Requirements
- R7
- R11
- R12
- R13
- R15
- R32
- R34

## Implementation Steps (High-Level)
1. **Profile version** — add the new `config-repair` version with milestone text; prove old bundles still reproduce and the new digest covers the text.
2. **Executor flags** — allowlist, budget flag, caps at or below ADR-0010 defaults, cost recording and missing-cost class.
3. **Environment and command** — two-way auth-mode guard (tests for both mismatch directions); injectable command as a constructor option only.
4. **Bypass unreachability** — resolution function plus unit and static tests.
4a. **Filesystem confinement** — select path-scoped rules or an OS sandbox (the probe in step 6 confirms it works headless); refuse unscoped filesystem tools before spawn; negative fixture: the fake worker's attempted read/write outside the worktree is denied. Shell 03 consumes only the confined executor.
5. **Fake worker** — recorded-envelope fixture suite covering every listed variant, and the test-only harness entry point that injects it for process-level tests.
6. **Probe (human-run exit gate)** — write the probe procedure; the operator runs it and records whether `acceptEdits` plus allowlist can edit the allowed paths headless. On failure widen the allowlist once; on a second failure stop and redesign (never a bypass fallback). Shell 03 must not start until the probe result is recorded.

## Open Questions
- Per-action cap and action/run timeouts inside the $5 envelope — set from the probe's measured sonnet cost on `config-repair`; results feed shell 03 defaults and the shell 04 runbook.
- Whether the worker child gets a minimal engine-owned `--settings` to suppress hook/plugin side effects — decided by the probe.
