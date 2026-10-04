---
status: superseded by ADR-0021
date: 2026-09-28
decision-makers: KingInYellow
---

# 0020. Approval-gated real execution (VS layer 4a)

## Context and problem statement

Steps 1–5 of the Yellow Harness program and VS layers 3–3e are stub-only or offline: Provider
Protocol v1 cannot select a real executor (ADR-0017), and the candidate verifier judges bytes
without any worker producing them (ADR-0018). The legacy `run --executor claude-code` path
hardcodes `bypassPermissions` and has no prior human consent step. VS layer 4a needs one real
`claude -p` worker whose spend is approved in advance by a human, bounded, metered, and judged by
the existing verifier. The question: what makes a real run authorized, and how is that authority
kept from agents and scripts?

## Decision

A real run is authorized only by a **single-use, terminal-minted, hash-bound approval** of a
deterministic run manifest:

- The engine renders a `yellow-goal/run-manifest/v1` offline (`run manifest`, zero spend, no
  spawn). Its `manifestHash` covers engine version, protocol id, profile id/version/digest,
  request hash, model, permission mode, tool allow/deny lists, max turns, USD caps, timeouts,
  auth mode, attempt count (always 1) and expiry.
- `run approve` mints a `yellow-goal/run-approval/v1` record only after the operator types a
  hash-derived challenge at a controlling terminal (stdin and stderr are TTYs). No flag,
  environment variable or piped input can mint one (`APPROVAL_TTY_REQUIRED`). The record is
  written with exclusive create and owner-only permissions; default expiry is 60 minutes and a
  manifest may shorten but never lengthen it.
- Before any spawn the engine recomputes the manifest from the actual invocation and refuses
  unless hash, engine version and expiry all match, each with a distinct code
  (`APPROVAL_MISSING`, `APPROVAL_INVALID`, `APPROVAL_HASH_MISMATCH`, `APPROVAL_EXPIRED`,
  `APPROVAL_ENGINE_MISMATCH`).
- An approval is consumed exactly once by atomically creating a marker file before the worker
  spawns (`APPROVAL_CONSUMED` otherwise); consumption is final whatever the outcome. The marker
  is keyed by `approvalId` in an engine state directory (`$XDG_STATE_HOME/yellow-goal/consumed/`,
  default `~/.local/state/yellow-goal/consumed/`), not placed beside the approval file as the
  spec's AGX-R5 wording suggests: a path-keyed marker let a copied approval file run again.
- The worker runs with `acceptEdits` plus the approved allowlist — `bypassPermissions` is
  unreachable from this path — makes one attempt, and is judged by `acceptance
  verify-candidate`, never by its own narrative. Real runs are exposed through a new
  `yellow-goal/provider-protocol/v2`; v1 stays byte-identical and stub-only.

Requirements are cited outside the spec as `AGX-R<n>` (spec
`plans/specs/approval-gated-real-execution.md`).

## Alternatives considered

- **Signed approvals / a daemon or database holding approval state** — rejected; a filesystem
  exclusive-create marker is atomic locally and fits the single-admin trust model (ADR-0011).
- **Approval via a flag or environment variable** — rejected; any agent session can set one.
- **Reuse the DoD `--yes` confirmation** — rejected; `--yes` is scriptable and is rejected on
  real runs (AGX-R25). The approval replaces the DoD confirmation.
- **Promote the legacy `--executor claude-code` path** — rejected; it hardcodes
  `bypassPermissions` and has no consent step. It stays unadvertised and is retired after the
  live acceptance run (AGX-R35).

## Consequences

- 👍 No real spend is reachable without a prior human decision bound to the exact invocation.
- 👍 Everything up to the live run is provable with zero spend in CI (fake worker, TTY seam).
- 👎 The approval record is **consent evidence, not a credential**. Nothing on disk can resist a
  process running as the operator: such a process (including an agent session) can hand-write a
  self-consistent `run-approval/v1` record or drive `run approve` through a pseudo-terminal
  (`script`, `expect`, a pty library), and can point `XDG_STATE_HOME` at a fresh directory. The
  engine-side controls stop honest mistakes, piped input and flag/env shortcuts; the control
  against a misbehaving agent is harness-level. **Follow-up (workspace, not this repo):** a
  PreToolUse deny on `run approve`, on pty wrappers around it, and on writing approval files or
  the consumption directory from agent sessions.
- 👎 Approval, bundle and ledger paths are operator-supplied arguments; the engine owns no
  `runtime/` concept. The one exception is the consumption-marker directory
  (`$XDG_STATE_HOME/yellow-goal/consumed/`, default `~/.local/state/yellow-goal/`): single use
  must hold across wherever an approval file is copied, so markers live in engine-owned per-user
  state rather than beside the file. Whether the real run also accepts an explicit `--state-dir`
  (which would weaken single use the same way an `XDG_STATE_HOME` redirect does) is decided when
  the run path is wired.

## Confirmation

- Approval foundation tests: `tests/cli/run-manifest.test.ts`, `tests/cli/run-approval.test.ts`,
  `tests/cli/run-approval-verifier.test.ts`, `tests/cli/run-approval-isolation.test.ts`
  (manifest determinism, TTY-only mint, each refusal code, single-winner concurrent consumption,
  zero `claude` invocations).
- Later slices: spec acceptance matrix rows A3–A11 (fake-worker suite, `bypassPermissions`
  unreachability, v1 goldens, operator-recipe job, human-run live acceptance evidence).

## Links

- Spec `plans/specs/approval-gated-real-execution.md` (AGX-R1..R35)
- Brainstorm `docs/brainstorms/2026-09-28-approval-gated-real-claude-execution-brainstorm.md`
- Runbook `docs/operator-real-run.md`
- ADR-0010 (guardrail defaults), ADR-0011 (single-admin trust), ADR-0015 (fail-closed
  permissions), ADR-0017 (Protocol v1 stub-only), ADR-0018 (verified single-milestone
  execution), ADR-0019 (operator-recipe CI gate)
- Superseded by [ADR-0021](0021-fresh-approval-challenge-and-no-state-dir.md) for challenge
  derivation and `--state-dir`
