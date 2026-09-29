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
