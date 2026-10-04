---
status: accepted
date: 2026-10-01
decision-makers: KingInYellow
---

# 0021. Fresh per-ceremony approval challenge; no `--state-dir` on the real run

## Context and problem statement

ADR-0020 locked two points that later work had to change. The approval challenge was the first
8 hex characters of `manifestHash`, and `run manifest` already printed that hash, so a session
that had seen the manifest output could relay the answer before the operator reviewed anything.
The consequences section also left `--state-dir` as an open question "decided when the run path
is wired." Editing accepted ADR-0020 in place is forbidden (`CLAUDE.md`: supersede rather than
edit; `docs/decisions/README.md`: accepted ADRs are immutable).

## Decision

ADR-0020 remains the historical decision for single-use, TTY-minted, hash-bound approvals,
Protocol v2, and the consumption-marker directory. This ADR replaces two of its clauses:

1. **Challenge derivation.** `run approve` shows a cryptographically random challenge, fresh
   per ceremony, only on the controlling terminal and directly under the manifest it approves.
   The code is never stored; the approval-record format is unchanged. `run manifest` does not
   print a challenge.
2. **`--state-dir`.** The real run accepts no `--state-dir` flag (one would weaken single use
   the same way an `XDG_STATE_HOME` redirect does). `stateDir` is an in-process test seam only.
   Production consumption stays in `$XDG_STATE_HOME/yellow-goal/consumed/` (default
   `~/.local/state/yellow-goal/consumed/`).

## Alternatives considered

- **Edit ADR-0020 in place** — rejected; accepted ADRs are immutable.
- **Keep the hash-derived challenge and stop printing it from `run manifest`** — rejected; any
  session that had already seen the hash could still relay the answer before the approval
  screen is shown.
- **Expose `--state-dir` on the real run** — rejected; it would let a caller point consumption
  markers at a fresh directory and replay an approval.

## Consequences

- 👍 A session that has only seen `run manifest` cannot satisfy the approval ceremony.
- 👍 The open `--state-dir` question is closed: production has no such flag.
- 👎 Operators must type the challenge shown on the approval screen, not a prefix of
  `manifestHash`.
- ADR-0020 is superseded for challenge derivation and `--state-dir`; its other clauses stay
  historical.

## Confirmation

- Fresh-challenge ceremony: `tests/cli/run-approval.test.ts`,
  `tests/cli/run-approval-main.test.ts` (challenge is `XXXX-XXXX`, not a `manifestHash` prefix;
  `run manifest` JSON has no `challenge` field).
- No `--state-dir` on the production real-run argv: `tests/harness/real-run-harness.ts` splits
  that flag off as harness-only; the engine takes `stateDir` only as an in-process option.

## Links

- ADR-0020 (historical approval-gated real execution)
- Spec `plans/specs/approval-gated-real-execution.md` (AGX-R2)
- Runbook `docs/operator-real-run.md`
