---
title: 'Adding a New Non-Protocol CLI Verb to goal-gen: Dispatch, Error Codes, Capabilities, and File-Write Gotchas'
date: 2026-09-28
category: code-quality
track: knowledge
problem: 'new goal-gen verbs such as `run <sub>` get mis-parsed by the run parser, collapse to UNEXPECTED_ERROR, or break install-smoke unless wired through four non-obvious seams'
tags: [goal-gen, cli, dispatch, error-classes, capabilities, install-smoke, exclusive-create, sha256, planning]
components: [goal-gen/backend/src/cli, goal-gen/scripts/install-smoke.sh]
source: 'planning of approval-gated-real-execution-01-approval-foundation (PR #53)'
---

# Adding a New Non-Protocol CLI Verb to goal-gen

## Context

Found while planning the approval foundation (shell 01 of
approval-gated-real-execution). Each item is a seam that is easy to miss
because nothing in the code announces it. Paths are relative to `goal-gen/`;
line numbers were accurate at planning time and will drift, so grep for the
symbol.

## Guidance

1. **`run` has no subcommand parsing.** `case 'run'` in
   `backend/src/cli/index.ts` hands all argv to `runRunCommand`, and
   `parseRunInvocation` (`cli/protocol-run-options.ts`) demands exactly one
   positional plus `--executor`. `run manifest` or `run approve` would be
   parsed as a request path. Peek `rest[0]` in the dispatcher and dynamically
   `import()` a separate module BEFORE `./run-command` is loaded. This also
   satisfies the isolation-test pattern: new verbs must not transitively load
   executors or the orchestrator.

2. **There is no error-code registry.** Each error family is a class in
   `cli/errors.ts` (shape: `code`, `message`, `details`, see
   `AcceptanceEvidenceError`, `ObservedFixtureError`) AND needs an explicit
   `instanceof` branch in `main()` in `cli/index.ts`. A class without its
   branch falls through to `UNEXPECTED_ERROR` exit 1, silently discarding the
   intended code. Add a test that asserts the emitted code per error class.

3. **Do not add non-protocol verbs to `capabilities.operations`.** It is
   hard-coded in `cli/provider-capabilities.ts`, and
   `scripts/install-smoke.sh` asserts that non-protocol (acceptance-style)
   verbs are absent. Discovery is for the protocol surface only.

4. **No exclusive-create / 0600 helper exists.** `writeJsonFile` in
   `commands.ts` overwrites. Closest precedent is
   `persistWriteFileFlags` in `committed-source-bundle.ts`
   (`O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`, fd-relative). `mode` on open is
   subject to umask, so add `fchmod(fd, 0o600)` for a umask-proof result.

5. **No request hash exists; pin the hash-input form.** `canonicalJson`
   (`packs/canonical-json.ts`) emits 2-space indent plus a trailing newline,
   so what you hash is byte-sensitive. Pin the exact input in a golden test.
   Two `sha256Hex` copies exist (`packets/checksums.ts`,
   `cli/implementation-revision.ts`); do not add a third.
   `candidateProfileDigest` relies on literal `JSON.stringify` key order, not
   canonicalization, so do not treat it as a canonical-hash precedent.

6. **Engine identity is `readArtifactVersion()`** (`cli/artifact-version.ts`).
   The packet compiler `ENGINE_VERSION` is a different thing.

7. **Prompts:** there are no `isTTY` checks in `backend/src`. Existing prompts
   (orchestrator `stdinConfirm`) use `readline/promises` on stdin with output to
   stderr so stdout stays JSONL. Follow that, and add any TTY gating
   deliberately.

## Why This Matters

Items 1-3 fail quietly: a mis-parsed verb yields a confusing request-path
error, a missing `instanceof` yields a generic exit 1, and a capabilities
addition only fails in the `install-smoke` CI job, not in `npm test`.

## When to Apply

Any change that adds a verb, an error family, or a persisted approval or
manifest artifact to the goal-gen CLI.

Sibling runbook docs are safe: `scripts/operator-committed-source-paths.sh`
pins `docs/operator-committed-source.md` by exact path only.

## Update — 2026-09-28 (review of PR #55)

8. **Type the error code.** A bare `code: string` on a `cli/errors.ts` class lets a typo at a
   throw site compile and only fail in the emitted-code test. Declare the family's codes as a
   `const` tuple and type `code` (and any `refuse(code, …)` helper) with its union — see
   `RUN_APPROVAL_ERROR_CODES` in `cli/errors.ts`.
9. **Derive flag-value types from the `parseArgs` options.** A hand-written mirror of the options
   object drifts when a flag is added. Use
   `ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values']`.
10. **Keep defaults out of the command module.** If another code path must reproduce the same
    output (here: the real run recomputing an approved manifest), put every default in the pure
    builder, not in flag parsing — otherwise the two paths drift silently.

## Update — 2026-09-29 (executor hardening, shell 02, PR #60)

11. **Digest key order is load-bearing.** `candidateProfileDigest`
    (`cli/candidate-offline-profiles.ts`) hashes literal `JSON.stringify` key order. Emit a new
    profile field only when present. Capture a pinned v1 digest constant BEFORE the change, because
    no golden bundles exist (bundles are made in tmpdirs). Reproduce (`candidate-offline-command.ts`)
    originally looked up by id only, ignoring `stored.profile.version`; a versioned registry must
    resolve the recorded version (AGX-R7), and it now fails closed when a bundle has no version.
12. **`package.json` `files` is a positive allowlist.** It lists `bin/`, `backend/src/`, `packs/`,
    `policies/` and `schemas/`, and there is no `.npmignore`. Anything under `backend/src` ships in
    the tarball, so test-only harnesses and fake workers must live under `tests/`.

## Update — 2026-10-01 (planning shell 04, protocol v2 and release)

13. **An outcome-only engine API needs observer hooks before a protocol layer can stream events.**
    `runRealRun` (`backend/src/real-run/real-run-engine.ts`) returns only a final outcome, so a
    protocol layer that must emit `run.start` before the worker spawns has nothing to hook. Add
    optional observer callbacks at the approval-consume point and at the ledger-write points
    (the `writeLedger` helper). Hooks are observers: wrap them so a hook throw cannot skip
    cleanup or the ledger write. `RunEventSchema` is passthrough, so new event types fit
    `run-event/v1` without a schema bump.
14. **Capture byte goldens BEFORE changing protocol code.** v1 "byte-identical" was only pinned by
    field-level `toEqual` assertions, which pass when key order or whitespace drifts. Commit the
    exact stdout bytes of `capabilities --json`, the stub event streams and the error envelopes
    first (`tests/golden/provider-v1/`), then change code with a byte-compare test that
    regenerates them. Related: `capabilities` is strict (`--json` only) and must not import run
    code (`capabilities-isolation.test.ts`), and `provider-run-v1.ts` hard-codes its
    `protocolVersion`, so the protocol id must be carried on the parsed invocation and threaded
    into the start payload.
15. **CI can never run `run approve`, so rehearsals mint approvals through a test-only harness
    mode.** `run approve` is a human-only TTY ceremony. Wrap the existing injected-TTY seam
    (`runRunApprove(..., {terminal})`, as `mintApproval` in `tests/real-run/support.ts` does) in a
    mode of `tests/harness/real-run-harness.ts`. Keep it under `tests/`, outside `files`, and keep
    `harness-isolation.test.ts` green so the shipped bin never reaches it. The harness exit codes
    (0 / failed 1 / usage 2 / refused 3) differ from the CLI contract (0/1/2), so map them
    deliberately.
16. **Add a recipe as a second step in the existing operator-recipe job, not a new CI job.**
    ADR-0016/0019 fix the job inventory (`engine`, `install-smoke`, `operator-recipe`), so a new
    job would need a superseding ADR. The recipe script extracts `<!-- recipe:NAME -->` fenced
    bash blocks and evals them, so a new section plus a second script step in the same job gives
    the coverage with no ADR change.
17. **Version bumps touch more than `package.json`.** The last bump (09bcd16) changed
    `package.json`, `package-lock.json`, `CLAUDE.md`, `AGENTS.md` and the release-asset test, and
    literal `engineVersion: '0.2.0'` fixtures exist in three tests. Replace those literals with
    `readArtifactVersion()` where they are compared against the live engine. The packet
    compiler's `ENGINE_VERSION` is packet-format identity and is never bumped with the package.
