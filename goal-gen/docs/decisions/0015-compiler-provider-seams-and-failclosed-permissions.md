# 0015 — Packet-compiler provider seams reuse `claude -p`; permission modes fail closed

- Status: accepted
- Date: 2026-08-22

## Context

The Repository Goal Packet Compiler needs (a) model-dependent analysis (repository assessment,
goal resolution, milestone selection) and (b) bounded external research, while ordinary CI must
stay deterministic — no live network, no paid model calls. Separately, an audit confirmed the M1
executor coerced an absent or unknown action-payload `permissionMode` to `bypassPermissions`
(fail-open), violating the guidance invariant that unknown permission profiles must be rejected.

## Decision

1. **Provider seams, not a provider migration.** Analysis and research are interfaces
   (`AnalysisProvider`, `ResearchProvider`) with two implementations each: a recorded
   fixture-backed provider (the only one tests use) and a `claude -p` CLI provider (argument-array
   spawn, zod-validated/repaired output, fenced and bounded untrusted content) reusing the same
   headless-subscription seam ADR-0006 established for extraction. No SDK/API-key dependency is
   introduced; swapping providers later is a new implementation of the interface.
2. **Deterministic orchestration resolution.** The `claude-fable-opus-sonnet@1` profile
   (Fable 5 lead; Opus 5 architecture/security/complex-debugging/release-review; Sonnet 5
   implementation/unit-tests/documentation/evidence-mapping) is resolved by deterministic code
   from the versioned profile — never by a model and never scattered as raw IDs in templates.
3. **Fail-closed permission modes everywhere.** The executor now takes an explicit
   host-configured mode (unknown values throw at construction; the default is `acceptEdits`);
   an action payload may only narrow within `{plan, acceptEdits}` at or below the configured
   mode; anything unknown or escalating fails the action without spawning. `bypassPermissions`
   is reachable only by explicit host opt-in at a call site (runner/probe, per ADR-0009's
   throwaway-scratch-repo posture). The compiler's intake likewise rejects unknown permission
   and orchestration profiles, and generated launch scripts never use or fall back to
   `bypassPermissions`.

## Consequences

- Ordinary CI runs fully recorded/deterministic; live model use is confined to the explicitly
  invoked runner/probe and the bounded compiler live smoke.
- Regression tests pin the fail-closed matrix (tests/executors/claude-code-executor.permission.test.ts).
- A future provider change (SDK, other vendors) happens behind the existing interfaces without
  contract changes.
