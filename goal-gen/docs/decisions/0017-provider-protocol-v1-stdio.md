---
status: accepted
date: 2026-09-04
decision-makers: KingInYellow
---

# 0017. Provider Protocol v1 over installed stdio

## Context and problem statement

The engine now ships an installable 0.1.0 tarball and Yellow Plugins consumes
version/request operations as an external process. Artifact identity does not
advertise protocol capabilities, and legacy run transport/gate behavior is
insufficient for a strict non-interactive consumer. Older REST/SSE plans do not
establish a need for a server between these two local processes.

## Decision

Define [Provider Protocol v1](../../plans/specs/provider-protocol-v1.md) with
offline discovery and an explicitly selected non-interactive stub run mode.
Preserve the canonical request and run-event/v1 envelope. Bind success to a
complete, ordered stream plus terminal/stderr/exit agreement; make output and
cancellation waits bounded. Keep artifact, protocol and packet identities
independent. Verify consumers against GitHub Release assets.

This adds a stdio consumer contract alongside ADR-0016; it does not replace
ADR-0008 consent or ADR-0015 permission boundaries. Protocol runs decline gates
that need unavailable human input. The milestone advertises only zero-spend
stub execution and never treats request targets as execution selectors.

## Alternatives considered

- Infer protocol support from artifact version — cannot discover missing capabilities.
- Copy engine schemas into Plugins — creates a second contract source and masks process failures.
- Add HTTP/SSE now — no current local-consumer requirement justifies server/auth/persistence work.
- Expose arbitrary serialized test factories — increases input authority instead of using named stub scenarios.
- Reuse interactive prompts as machine stderr — violates structured error framing and can hang consumers.

## Consequences

- A small local process boundary remains independently releasable and testable.
- Existing interactive CLI and compiler behavior stay outside the new v1 mode.
- Transport failures may prevent a terminal from arriving; consumers must wait for close and fail closed.
- Remote gates, persistence, live providers and real execution require later explicit milestones.

## Confirmation

Provider Protocol acceptance A01–A14, engine unit/contract/package smoke tests,
public release install/rerun evidence and the Plugins released-artifact CI job.
These checks are required by the specification; implementation is not claimed
by this specification-only decision.
