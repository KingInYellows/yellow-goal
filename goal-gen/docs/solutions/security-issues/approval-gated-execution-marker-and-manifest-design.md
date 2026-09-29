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
