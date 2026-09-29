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
