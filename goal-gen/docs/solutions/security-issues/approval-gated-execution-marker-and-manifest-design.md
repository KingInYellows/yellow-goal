---
title: 'Approval-Gated Execution: Single-Use Markers, Consume-Time Expiry, and One Manifest Mapping'
date: 2026-09-28
category: security-issues
track: knowledge
problem: 'an approve-then-execute gate can be replayed, spent after expiry, or fail to reproduce the approved manifest unless marker keying, expiry and manifest construction are designed deliberately'
tags: [goal-gen, approval, consent-gate, single-use, manifest, adr, spec-drift]
components: [goal-gen/backend/src/cli/run-approval-verifier.ts, goal-gen/backend/src/cli/run-manifest.ts]
source: 'review of the approval foundation (PR #55, ADR-0020)'
---

# Approval-Gated Execution: Marker and Manifest Design

## Context

Lessons from reviewing the approval foundation (`run manifest` / `run approve`, verifier and
single-use consumption; `docs/decisions/0020-approval-gated-real-execution.md`). They apply to any
consent gate where a human approves a manifest and a later step acts on it.

## Guidance

1. **Key single-use markers by approval id, not by path.** A marker beside the approval file
   (`<file>.consumed`) is evaded by copying or renaming the file. Create the marker with
   `O_EXCL` under an engine-owned state dir, keyed by the (lower-cased) id. Document that the
   engine now owns that state, and decide whether callers may redirect it — any redirect
   (`--state-dir`, `XDG_STATE_HOME`) weakens single use the same way.
2. **Re-check expiry at consume time.** Other refusals run between verify and consume; an approval
   that lapses in that window must not be spent. Refuse `APPROVAL_EXPIRED` before creating the
   marker.
3. **Rebuild the approved manifest from one pure mapping.** Every path that turns an invocation
   into a manifest (render, approve, the later real run) must call the same builder, which owns
   all defaults (`RUN_MANIFEST_DEFAULTS` in `run-manifest.ts`). Decide explicitly how the run
   sources approval-only fields such as `expiresInMinutes` — still open for the real-run slice.
4. **Fail closed with a named code on state I/O.** A marker directory that cannot be read or
   created must refuse (`APPROVAL_STATE_UNAVAILABLE`), not be treated as "not consumed" and not
   surface as a generic `UNEXPECTED_ERROR`.
5. **Treat the approval record as consent evidence, not a credential.** Anything running as the
   operator can forge a self-consistent record or drive a pty; the real control against a
   misbehaving agent is a harness-level deny. Say so in the ADR.
6. **Amend the spec in place when an ADR deviates.** Spec AGX-R5 kept saying "sibling marker"
   after the ADR chose an id-keyed marker; a stale requirement is read as current. Edit the
   requirement text (ids stay stable) and link the ADR.

## When to Apply

Any approve-then-execute flow: minting, verifying or consuming approvals, or editing a spec after
an ADR changes a requirement's mechanism.

---

## Update — 2026-09-29 (executor hardening, shell 02, PR #60)

7. **A fake worker cannot prove Claude Code enforces permission rules.** CI can only prove that the
   engine refuses an unconfined allowlist before spawning. Enforcement proof has to come from a
   human-run probe, and the plan should make that probe the exit gate.
8. **Only worktree-relative specifiers count as path-scoped.** In Claude Code rules, a leading `/`
   is settings-relative, `//` is absolute and `~` is home. Only `./x` or `x` is worktree-scoped.
   `Bash` can never be path-scoped, so a confinement check must treat it as unconfined. Path-scoped
   rules were chosen over an OS sandbox (bwrap) for filesystem confinement.
9. **Keep the manifest-to-executor-options mapping in `executors/`.**
   `tests/cli/run-approval-isolation.test.ts` forbids the approval modules from importing
   `executors/`, `child_process` or `bypassPermissions`.
10. **Do not trust envelopes the spike never recorded.** `tests/spikes/executor-spike-findings.md`
    only captured the success envelope, so budget, max-turns and permission-denial envelopes are
    synthetic until the probe records them. The legacy path records a missing `total_cost_usd` as
    0; the real-run path must fail as `failureClass: cost-unmetered`, and now does.
11. **Fix doc examples the new check will refuse.** `docs/operator-real-run.md` used an unscoped
    `--allowed-tool Edit`, which the confinement check refuses; it now uses scoped rules.
12. **Allow rules add approvals; they do not remove tools.** Claude Code auto-approves read-only
    Bash commands such as `cat`, so a scoped-filesystem allowlist alone still lets a worker read
    host files. Restrict the available set with `--tools` and deny `Bash`/`WebFetch`/`WebSearch`.
13. **Every engine git call in an agent-written worktree must be pinned.** A worker can rewrite the
    `.git` gitfile to a planted repo whose config sets `core.fsmonitor`; plain `git status` or
    `git add -N` then runs it in the engine. Record the git dir at worktree creation, pass it as
    `RunContext.gitDir`, and run git with `GIT_DIR` pinned and `-c core.fsmonitor=false
    -c core.hooksPath=/dev/null` (`pinnedGit`) on every path, legacy included.
14. **Pinning setting sources to `project` makes the worktree's own config the only source.**
    Deny writes to `.claude/`, `.mcp.json`, `CLAUDE.local.md` and `.git` at any depth, and refuse a
    worktree that already contains them.

---

## Update — 2026-09-29 (AGX-R34 permission probe findings, PR #62)

Recorded results from the real `claude` probe (sonnet, subscription auth,
`--setting-sources project --strict-mcp-config`, total spend $0.079).

- **acceptEdits does not confine in-cwd writes.** Under `acceptEdits`,
  path-scoped allow rules such as `Write(./x)` only add approvals. The probe
  wrote `./other.txt` with no matching rule. What actually constrains a worker
  is deny rules, the cwd boundary, and allowed-paths-only candidate extraction.
  Do not describe allow rules as an allowlist.
- **Denials still exit 0.** The escape probe recorded 5 `permission_denials`
  (secret read, `../escape.txt`, `outside/written.txt`, `.claude/settings.json`,
  `sub/.claude/skills/p/SKILL.md`) with exit 0 and subtype `success`. The
  executor must classify any denial run as failed/permission-denied. With Bash
  absent from `--tools`, a `cat` fallback is impossible.
- **Escape verdict needs all evidence.** A pass on `secretReadDenied` alone was
  too weak. The verdict now requires every `denialEvidence` field (secret read,
  escape write, outside write), otherwise it is inconclusive.
- **Budget stop.** `--max-budget-usd` overshoots by up to one turn ($0.0122
  against a $0.01 cap). Signature: subtype `error_max_budget_usd`,
  `terminal_reason: budget_exhausted`, exit 1. Top-level `usage` is zeroed;
  real usage is only in `modelUsage`. `classifyFailure` matches the subtype
  exactly instead of `/budget/i`.
- **Turn cap.** `--max-turns` is missing from `claude --help` on 2.1.284/2.1.285
  but still honored: subtype `error_max_turns`, `is_error: true`, exit 1,
  `num_turns` 2 with a cap of 1. Feature-detect by behavior, not by help text.
  The `flags` step reports `ok:false` for exactly this.
- **Operator-script hygiene.**
  - Under zsh, `PROBE="node ..."; $PROBE` fails (no word splitting). Use a
    function: `probe() { node ... "$@"; }`.
  - Human-only spend scripts gate on stdin/stderr TTY. Agent sessions must not
    fake a TTY; hand the operator the commands instead.
  - Nested workers inherit `CLAUDECODE`/`CLAUDE_CODE_*` env vars that can skew
    results.

---

## Update — 2026-09-29 (real-run orchestration review, PR #66, fixes in 9f5b16a)

15. **A detached worker needs a bounded lifecycle, not just a kill.** Killing the process group
    does not free the stdio pipes if a descendant outside the group (setsid or double-fork) still
    holds them, so `await close` can hang forever while the run stays open. After the worker exits,
    bound the wait for stdio to drain. On timeout, destroy the streams and report
    `worker-not-terminated`. Never make "the pipes closed" a precondition for finishing.
16. **Engine death must not orphan a spending worker.** Unmapped signals (SIGHUP, SIGINT, SIGTERM)
    kill the engine and leave a detached group running. Map those signals onto the engine's abort
    signal. Also register an exit hook that SIGKILLs any live worker groups, since exit hooks run
    even when the abort path does not.
17. **Hardening a shared helper can silently change a public CLI contract.** The bundle-dir writer
    was made exclusive and non-recursive for real runs, and `verify-candidate --bundle-dir` lost its
    recursive parent creation. Four reviewers caught this independently. Do not tighten a helper
    that has a user-facing caller. Give the strict path its own exclusive writer and keep the CLI
    path on its original behavior, with a test for each contract.
18. **Pin evidence writes to a descriptor, not a path.** Re-checking the parent path and then
    calling `mkdir` or `open` leaves a race, because the parent can be swapped after the last
    check. Open the parent with `O_NOFOLLOW`, create the bundle relative to that held fd, and
    verify the realpath afterward.
19. **Re-check the destination on every write, and ledger spend even when the write is refused.**
    Once the approval is consumed, money may already be spent. A destination refusal after
    consumption is `worker-failed` with `evidence-destination-refused`, not a pre-spend `refused`.
    Re-check each destination just before its own write, so a problem with the bundle path can
    never keep the spend out of the ledger. An executor that throws or rejects after consumption
    must still be metered, as unknown spend (`costUsd: null`, `exitClass: engine-error`). Route all
    ledger records through one `writeLedger` helper so no path can skip it.
20. **Verify the worker's bytes, not a decoded copy.** `TextDecoder` strips a leading UTF-8 BOM by
    default, so the verified text differed from what the worker wrote. Use `ignoreBOM: true`, or
    hash the raw bytes, for byte-exact extraction.
21. **Document the throw contract of an outcome-union API.** `runRealRun` can throw usage errors,
    so state that they are thrown before approval is read and that everything after that point is
    returned as an outcome. A cancel before consumption is its own refusal (`RUN_CANCELLED`) so it
    never burns the approval. Update the runbook (`docs/operator-real-run.md`) whenever a new
    post-consumption outcome appears.
22. **Test the post-consumption failure paths.** The review's P1 was missing coverage for
    candidate-builder branches, executor output caps, and engine failure after consumption. Those
    are the paths where money is already spent. PR #66 added a candidate-builder suite and engine
    failure-path tests.

Left open by choice: the `worker-failed` evidence is still an untyped record, now documented as
diagnostic details.
