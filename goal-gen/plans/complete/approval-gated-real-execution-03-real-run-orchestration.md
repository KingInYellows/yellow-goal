# Feature: Real-run orchestration and verification

## Overview

With approval (shell 01) and a hardened executor (shell 02) in place, this shell composes the
real run: verify and consume the approval, seed a scratch worktree from the profile, make exactly
one worker attempt on a fixed goal, meter it, extract a candidate from allowed paths only, and
judge it with the existing `acceptance verify-candidate`. The worker's narrative never decides
success; nothing is accepted, committed or published.

Scope boundary: this slice delivers the real-run **engine** as an in-process module plus the
test-only harness that drives it with the fake worker. The production CLI surface
(`run --protocol v2 --executor agx-claude-code`, `run.start`/spend/outcome events, v2
capabilities) is shell 04 (AGX-R22–R27). The engine returns a structured outcome that shell 04
maps onto events. `run manifest`/`run approve` do gain the evidence-destination flags and the
`<id>@<version>` profile selector here, because AGX-R8a binds those destinations into the
approved manifest.

## Origin

- Spec: `plans/specs/approval-gated-real-execution.md` (cite as AGX-R<n> outside the spec)
- Covers: AGX-R8, AGX-R8a, AGX-R9, AGX-R10, AGX-R14, AGX-R16, AGX-R17, AGX-R18, AGX-R19, AGX-R20,
  AGX-R21
  - Completes the shell 02 partials: AGX-R12 "rejected before the approval is consumed" and AGX-R13
    "guard before consumption" are realized by the engine's fixed order (Step B1).
  - AGX-R5's deferred `starting`/`spawned` marker question is decided here (Step B1: no extra
    marker states).
- Shell: approval-gated-real-execution-03-real-run-orchestration
  (depends_on: approval-gated-real-execution-01-approval-foundation,
  approval-gated-real-execution-02-executor-hardening, both archived)
- Expansion decisions (operator, 2026-09-29):
  - **Spec drift:** the shell's `spec-r-ids` frontmatter omits R8a, which has been in the spec
    since #53. This was a decomposer omission, not drift: the shell already covers R8a. Proceed.
  - **Probe inputs** (`tests/spikes/permission-probe-findings.md`, "Decisions for shell 03"):
    - Per-action cap $0.50, action timeout 120000 ms, run wall-clock 600000 ms.
    - No engine-owned `--settings`.
    - Out-of-scope in-worktree changes are evidence only.
    - Allowlist not widened.
    - A budget stop overshoots its cap by up to one turn.

## Pattern Survey

**Approval foundation (shell 01), consumed as-is:**
- `RunManifestSchema` / `buildRunManifest` / `computeManifestHash` (`backend/src/cli/run-manifest.ts`,
  :38/:140/:123).
  - `RUN_MANIFEST_DEFAULTS` (:105) is the only home for defaults.
  - `resolveProfile` (:132) resolves by id only (version '1'), so `config-repair@2` is not yet
    selectable.
- `manifestFromFlags` (`backend/src/cli/run-manifest-command.ts:65`) is the shared flag → manifest
  builder that `run approve` reuses. `RUN_MANIFEST_OPTIONS` is at :21.
- `verifyRunApproval` / `consumeRunApproval` (`backend/src/cli/run-approval-verifier.ts:82/:135`).
  The marker is exclusive-create under `<state>/consumed/<approvalId>`.
- `writeFileExclusive` (`backend/src/cli/run-approval.ts:97`) does `O_EXCL|O_NOFOLLOW` 0600 with
  fsync. `RunApprovalError` and `RUN_APPROVAL_ERROR_CODES` are at `backend/src/cli/errors.ts:68/:49`.
- `tests/cli/run-approval-isolation.test.ts` forbids approval modules from importing executors or
  the orchestrator. The new engine must import them, never the reverse.

**Executor hardening (shell 02), consumed as-is:**
- `createRealRunExecutor(manifest, {workerCommand?})` (`backend/src/executors/real-run-executor.ts:19`).
- `assertAuthModeMatchesEnv` / `assertFilesystemToolsConfined`
  (`backend/src/executors/real-run-guards.ts:16/:117`).
- `ClaudeCodeExecutor.run` (`backend/src/executors/claude-code-executor.ts:562`) has a per-action
  timeout timer and `ctx.signal` → `killReason 'cancel'`, and uses stdin for the prompt.
  - `spawnClaude` (:143) is **not detached** and signals only the child (`SIGKILL_GRACE_MS` 5000,
    :41/:193). Process-group kill (AGX-R14) is left to this shell.
- `AgentRun` / `AgentRunFailureClass` (`backend/src/types.ts:74`) carry cost and exit code but
  **not** turns or duration.
- `createWorktree({seedFiles})` (`backend/src/executors/worktree.ts:135`) seeds UTF-8 text into a
  tmpdir scratch repo. `WorktreeHandle.cleanup()` is idempotent, and `pinnedGit` is at :53.
- The executor already parses `git status --porcelain -z` NUL-delimited output, which is reusable
  for listing changed files.
- `config-repair` v2 (`configRepairProfileV2`, `backend/src/cli/candidate-offline-profiles.ts`) has
  base `site.json`/`SITE`/`keep.txt`, allowed paths `site.json`,`SITE`, `maxFileBytes` 16384, and
  `milestoneText`. Lookup is `getCandidateOfflineProfile(id, version)`.
- Fake worker: `tests/fixtures/claude-worker/fake-claude.mjs`. Its scenarios are success,
  error-result, budget-stop, max-turns, permission-denial, malformed-output, missing-cost,
  gitfile-rewrite and noise-only. The envelopes are recorded where the probe captured them.
- Test-only harness: `tests/harness/real-run-harness.ts`. Its header says "Shell 03 extends this
  entry point".
- Static guards:
  - `tests/harness/harness-isolation.test.ts`: no `backend/src` file except the two executor
    modules may mention `workerCommand`, and the bin never reaches `tests/`.
  - `tests/executors/real-run-bypass-static.test.ts`: the `REAL_RUN_MODULES` list.

**Verifier (existing):**
- `runCandidateOfflineVerify` (`backend/src/cli/candidate-offline-command.ts:262`) wraps the
  module-private `verifyWithProfile(profile, candidate, unauthorized)` (:201).
- `parseCandidateDocument` / `unauthorizedCandidatePaths` are at :54/:112.
- `buildCandidateBundle` / `persistCandidateBundle` (`backend/src/cli/candidate-offline-bundle.ts:52/:106`).
  Persistence uses plain `writeFileSync` with tmp+rename, so it is **not** no-follow or exclusive.
- `yellow-goal/candidate-file-content/v1` is `{schemaVersion, files: Record<path,string>}`.

**Reusable safe-IO and process patterns:**
- `persistFileFlags` / `persistWriteFileFlags` / `persistDirectoryFlags` and the open → `fstat` →
  bounded-read sequence (`backend/src/cli/committed-source-bundle.ts:496-516, ~1149-1175`). These
  are module-private, so extract or copy.
- Process-group kill templates: `backend/src/executors/shell-verifier.ts:32-66` (detached,
  `process.kill(-pgid)`) and `backend/src/cli/observed-fixture-child.ts:140-190`.
- `AbortController` plus deadline plus signal-handler pattern: `backend/src/cli/run-command.ts:189-198`.

**Conventions:**
- Guardrail values come from `backend/src/orchestrator/guardrails.ts`, never literals.
- Verbs are `backend/src/cli/*-command.ts`, dynamically imported from `index.ts`.
- Refusals are typed errors mapped to one stderr JSON envelope.
- Injectable `clock?` / `stateDir?` are the norm.
- No JSONL ledger writer exists yet.

## Implementation

### A. Manifest: evidence destinations and profile version (AGX-R8a)

- [x] Step A1: In `backend/src/cli/run-manifest.ts`, add a required strict
  `evidence: { bundleDir: string; spendLedgerPath: string }` to `RunManifestSchema`. Both must be
  absolute and canonical (`path.isAbsolute` and equal to `path.resolve`). Thread optional
  `bundleDir` / `spendLedgerPath` inputs through `RunManifestInputs` and `buildRunManifest`, which
  canonicalizes each via `realpath` of its parent plus the basename. Because the field is required,
  approvals minted before this change fail `APPROVAL_INVALID` (spec: "approvals minted earlier do
  not authorize a real run").
- [x] Step A2: Let `RunManifestInputs.profileId` accept `<id>@<version>`. Split it in
  `resolveProfile` and call `getCandidateOfflineProfile(id, version)`. A bare id keeps version '1'.
  An unknown version is `MANIFEST_INVALID`.
- [x] Step A3: In `backend/src/cli/run-manifest-command.ts`, add the `--bundle-dir` and
  `--spend-ledger` string options to `RUN_MANIFEST_OPTIONS` and thread them through
  `manifestFromFlags` (required: a missing one is a `CliUsageError`). `run approve` inherits them
  unchanged.
- [x] Step A4: Add named real-run defaults to `backend/src/orchestrator/guardrails.ts`, citing the
  probe findings:
  - `REAL_RUN_ACTION_TIMEOUT_MS = 120_000` and `REAL_RUN_WALL_CLOCK_MS = 600_000`, used as the
    `actionTimeoutMs` / `runWallClockMs` defaults in `RUN_MANIFEST_DEFAULTS`. The ADR-0010 values
    stay as the schema ceilings.
  - `REAL_RUN_PER_ACTION_USD_RECOMMENDED = 0.5`, cited in help text and docs only. `perActionUsd`
    and `totalUsd` stay required flags, so spend is always typed explicitly.
- [x] Step A5: Add refusal codes to `RUN_APPROVAL_ERROR_CODES` (`backend/src/cli/errors.ts`):
  `EVIDENCE_DESTINATION_REFUSED` (inside `target.repository` or the worktree, through a symlink,
  or already existing) and `EVIDENCE_WRITE_FAILED`.
- [x] Step A6: Update `tests/cli/run-manifest.test.ts` and `tests/cli/run-approval*.test.ts`:
  - The evidence fields are hashed, so changing either path changes `manifestHash`.
  - `config-repair@2` resolves the v2 digest.
  - A pre-change approval record (no `evidence`) is `APPROVAL_INVALID`.
  - Missing flags are usage errors.
  - `run-approval-isolation.test.ts` stays green, unedited.

### B. Real-run engine skeleton (AGX-R8, R9, R10, R19; AGX-R12/R13 ordering)

- [x] Step B1: Create `backend/src/real-run/real-run-engine.ts` exporting
  `runRealRun(input: RealRunInput): Promise<RealRunOutcome>`.
  - `input` is `{ requestPath, manifestFlags, approvalPath, executorFactory, env, clock?, stateDir?, signal? }`.
    `executorFactory: (manifest) => Executor` is the injection seam, so this module never names
    `workerCommand`.
  - The production default is `createRealRunExecutor(manifest)`.
  - Fixed order, with every refusal before consume except AGX-R5 itself:
    1. Recompute the manifest via `buildRunManifest` from the same inputs as `manifestFromFlags`.
    2. `verifyRunApproval`.
    3. `assertAuthModeMatchesEnv(manifest.authMode, env)` and `assertFilesystemToolsConfined`.
    4. Evidence-destination check (Step E1).
    5. `consumeRunApproval`.
    6. Seed the worktree.
    7. One `executor.run`.
    8. Ledger.
    9. Extract.
    10. Verify.
    11. Outcome.
    12. Cleanup in `finally`.
  - Decision (AGX-R5 deferral): no `starting`/`spawned` marker states. A crash between consume and
    spawn leaves the approval consumed with no spawn, and the operator re-mints.
- [x] Step B2: Create `backend/src/real-run/outcome.ts` with the `RealRunOutcome` discriminated
  union. Every kind carries `approvalId` when a valid approval was read (AGX-R6), and none has an
  "accepted" state (AGX-R20).
  - `refused {code, message, approvalId?}`: no spawn, no ledger.
  - `worker-failed {reason: AgentRunFailureClass | 'unsafe-allowed-path' | 'non-utf8-candidate' | 'wall-clock', evidence, spend?}`.
  - `verification-rejected {bundleDir, reasons, spend, outOfScopeChanges}`.
  - `verified {bundleDir, spend, outOfScopeChanges}`: awaiting human.
- [x] Step B3: Build the fixed one-action goal in `backend/src/real-run/fixed-goal.ts`
  (`buildFixedAction(profile)`): one `Action` whose prompt is `profile.milestoneText`. There is no
  LLM extractor import, and no retries, replans or remediation (AGX-R9, R10). A profile without
  `milestoneText` is refused `MANIFEST_INVALID`.
- [x] Step B4: Seed the worktree via `createWorktree({ seedFiles: profile.baseFiles })`. The engine
  never reads the request's `target.repository` beyond the destination check. Record
  `targetRepositoryHonored: false` on the outcome for shell 04's `run.start`.
- [x] Step B5: Add `backend/src/real-run/*.ts` to `REAL_RUN_MODULES` in
  `tests/executors/real-run-bypass-static.test.ts`. Add a static assertion that the engine never
  imports `extractors/llm-extractor`, `orchestrator/orchestrator`, `cli/run-command` or `runner`.

### C. Execution bounds (AGX-R14)

- [x] Step C1: In `backend/src/executors/claude-code-executor.ts` `spawnClaude`, when a `realRun`
  config is present, spawn `detached: true` and send the SIGTERM → (after `SIGKILL_GRACE_MS`)
  SIGKILL escalation to the process group (`process.kill(-pid, sig)`, pattern from
  `shell-verifier.ts:32-66`). Resolve only after the group is gone. The legacy path is unchanged.
- [x] Step C2: The engine owns an `AbortController` combining the run wall-clock
  (`manifest.runWallClockMs`) and the caller's `signal`. The per-action timeout stays in the
  executor (`manifest.actionTimeoutMs`). Wall-clock expiry maps to `worker-failed {reason: 'wall-clock'}`,
  and cancel to `worker-failed {reason: 'cancel'}`. The approval stays consumed on both.
- [x] Step C3: Add fake-worker scenarios to `tests/fixtures/claude-worker/fake-claude.mjs`:
  - `hang`: never exits.
  - `descendant-ignores-sigterm`: forks a grandchild that traps SIGTERM and writes its pid to the
    record.
- [x] Step C4: Tests in `tests/real-run/real-run-bounds.test.ts`, each using an injected short
  timeout and asserting the approval marker exists afterwards:
  - Timeout kills the whole group (the grandchild pid is gone).
  - Cancel via `signal` kills the whole group.
  - Wall-clock expiry.
  - The legacy `tests/executors/claude-code-executor.permission.test.ts` stays unedited and green.

### D. Spend ledger (AGX-R16)

- [x] Step D1: In `claude-code-executor.ts`, add optional `turns` (`num_turns`) and `durationMs`
  (`duration_ms`) to `AgentRun` (`backend/src/types.ts`), taken from the parsed envelope. Legacy
  consumers ignore them.
- [x] Step D2: Create `backend/src/real-run/spend-ledger.ts` with `appendSpendEntry(ledgerPath, entry)`.
  - The ledger is JSON Lines, schema `yellow-goal/real-run-spend/v1`, with fields `approvalId`,
    `model`, `costUsd | null`, `turns | null`, `durationMs`, `exitClass`, `startedAt`, `endedAt`.
  - The first write creates the file exclusively via `writeFileExclusive`, so a pre-existing file
    is refused.
  - Every spawn, including a failed or cancelled one, gets exactly one entry. The single-attempt
    policy means one entry per run.
- [x] Step D3: Tests in `tests/real-run/spend-ledger.test.ts`:
  - One entry per spawn on success, budget-stop, max-turns, cancel and missing-cost (`costUsd: null`).
  - No ledger file on `refused`.
  - A symlinked or pre-existing ledger path is refused.

### E. Evidence destinations and safe writes (AGX-R8a)

- [x] Step E1: Create `backend/src/real-run/evidence-destinations.ts` with
  `assertEvidenceDestinations(manifest, {targetRepository, worktreeRoot?})`, run pre-consume and
  re-checked post-seed against the actual worktree root. `EVIDENCE_DESTINATION_REFUSED` covers:
  - A destination inside `target.repository` (realpath-compared).
  - A destination inside the scratch worktree root, or inside `os.tmpdir()`'s engine worktree
    prefix.
  - A parent that resolves through a symlink.
  - An existing bundle directory or ledger file.
- [x] Step E2: Harden `persistCandidateBundle` (`backend/src/cli/candidate-offline-bundle.ts:106`):
  - Create the bundle directory with non-recursive `mkdir`.
  - Write `manifest.json` and the `COMPLETE` tmp file with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`
    (pattern `persistWriteFileFlags`), then rename.
  - The existing `acceptance verify-candidate --bundle-dir` and `reproduce` tests pass unchanged.
- [x] Step E3: Tests in `tests/real-run/evidence-destinations.test.ts`: each refusal case refuses
  before consume (marker absent, zero fake-worker invocations).

### F. Candidate extraction and verification (AGX-R17, R18)

- [x] Step F1: Create `backend/src/real-run/candidate-builder.ts` with
  `buildRealRunCandidate(worktreePath, profile, gitDir)`.
  - For each `profile.allowedPaths` entry:
    - Open it descriptor-relative from an `O_DIRECTORY|O_NOFOLLOW` worktree fd, with
      `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`.
    - `fstat`: it must be a regular file with size ≤ `profile.maxFileBytes`.
    - Bounded read, then fatal UTF-8 decode.
  - A symlink, FIFO, device, directory or oversize entry is never read and returns
    `worker-failed {reason: 'unsafe-allowed-path', evidence: {path, kind}}`.
  - A missing allowed path is omitted from the candidate; the verifier decides.
  - `outOfScopeChanges` comes from `pinnedGit(['status','--porcelain','-z','--untracked-files=all'], …)`,
    reusing the executor's NUL parser. It lists changed paths outside the allowed paths, by name
    only, and it is evidence only per the probe decision: it never fails the run.
- [x] Step F2: Export an in-process verifier entry from `backend/src/cli/candidate-offline-command.ts`:
  `verifyCandidateDocument(profile, candidate): Promise<CandidateOfflineBundle>`, a thin wrapper
  over the existing `verifyWithProfile` plus `unauthorizedCandidatePaths`. The CLI verb is
  refactored to call it, with byte-identical output. The engine passes the approved profile id and
  version explicitly (spec Key flows 2).
- [x] Step F3: Engine mapping (AGX-R18, R19):
  - `bundle.decision.accepted === true` → `verified`.
  - `bundle.decision.accepted === false` → `verification-rejected` with the decider reasons.
  - The bundle is persisted to `manifest.evidence.bundleDir` via the hardened
    `persistCandidateBundle`.
  - The worker's exit status and narrative are never consulted for success.
- [x] Step F4: Add fake-worker scenarios:
  - `symlink-allowed-path`: `site.json` becomes a symlink to a file outside the worktree.
  - `fifo-allowed-path`.
  - `oversize-allowed-path`.
  - `out-of-scope-write`: success edits plus `other.txt`.
  - `wrong-repair`: a valid JSON edit that fails the `schema-host`/`site-bind` checks.

### G. Cleanup, harness and outcome tests (AGX-R19, R20, R21)

- [x] Step G1: The engine's `finally` calls `worktree.cleanup()` on every path after creation:
  timeout, cancel, spawn error, malformed output, missing cost, unsafe path and verification
  failure. Candidate bytes live only in the bundle, outside the worktree. There is no git commit,
  push or merge anywhere in `backend/src/real-run/`; add a static test that the module never
  invokes `git commit`/`push`/`merge`.
- [x] Step G2: Extend `tests/harness/real-run-harness.ts` to drive `runRealRun` end to end.
  - New options: `--request --approval --state-dir --scenario --record`, plus the manifest flags.
  - It injects `executorFactory: (m) => createRealRunExecutor(m, { workerCommand: fakeWorker(scenario, record) })`
    and prints the `RealRunOutcome` as JSON.
  - Exit codes: 0 `verified`, 1 `worker-failed`/`verification-rejected`, 3 `refused`, 2 usage.
  - `harness-isolation.test.ts` stays green: the engine never mentions `workerCommand`.
- [x] Step G3: Outcome suite `tests/real-run/real-run-engine.test.ts`, driving the engine in-process
  with a fake-worker factory and a TTY-seam-minted approval (from `tests/cli/run-approval*.test.ts`
  helpers). Every row asserts the invocation count, the marker state, the ledger entry count, the
  bundle presence, and that the worktree is removed.

  | Case | Outcome | Invocations | Marker | Ledger | Bundle |
  |---|---|---|---|---|---|
  | `success` | `verified` | 1 | consumed | 1 | yes |
  | `wrong-repair` | `verification-rejected` | 1 | consumed | 1 | yes |
  | budget-stop, max-turns, error-result, permission-denial, malformed-output, missing-cost | `worker-failed` with the matching reason | 1 | consumed | 1 | none |
  | symlink/FIFO/oversize | `worker-failed` `unsafe-allowed-path` | 1 | consumed | 1 | none; operator file never read |
  | `out-of-scope-write` | `verified` with `outOfScopeChanges: ['other.txt']` | 1 | consumed | 1 | yes |
  | each `refused` code (missing, invalid, hash mismatch, expired, engine mismatch, consumed, `AUTH_MODE_MISMATCH` both directions, `TOOLS_UNCONFINED`, `EVIDENCE_DESTINATION_REFUSED`) | `refused` | 0 | unconsumed, except `APPROVAL_CONSUMED` | none | none |

  Also: two concurrent `runRealRun` calls with one approval produce exactly one invocation.
- [x] Step G4: Process-level harness test `tests/harness/real-run-harness.process.test.ts`: spawn
  the harness as a process for `success` and `refused`, and assert the exit codes and outcome JSON.
- [x] Step G5: Docs:
  - In `docs/operator-real-run.md`, add the manifest `--bundle-dir`/`--spend-ledger` flags, the
    `config-repair@2` selector, the probe-derived defaults, and a note that the command surface
    lands in shell 04.
  - In the spec's `### Decisions` (`plans/specs/approval-gated-real-execution.md`), record the
    AGX-R5 marker decision (no extra states), the evidence-destination canonicalization rule, and
    that out-of-scope changes are evidence only.

## Verification

- `npm run typecheck` → exit 0.
- `npx vitest run tests/real-run` → the full outcome table (G3), bounds (C4), ledger (D3) and
  destinations (E3) pass, with ≤ 1 fake-worker invocation per run and 0 for refusals.
- `npx vitest run tests/cli/run-manifest.test.ts tests/cli/run-approval` → the evidence fields are
  hashed, `@2` resolves, and pre-change approvals are refused.
- `npx vitest run tests/cli/candidate-offline` → the verifier CLI output is byte-identical after the
  F2 refactor, and the hardened bundle persistence passes the existing tests.
- `npx vitest run tests/harness tests/executors` → harness isolation, bypass-static (with the new
  modules), and the legacy executor permission test pass, the last one unedited.
- `npm test && npm run eval` → full suite green.
- `bash scripts/install-smoke.sh` → green, and `npm pack --dry-run` lists no `tests/` paths.
- No step spawns a real `claude`. The AGX-R35 live run is shell 06, human-run.

## Context Files

- `backend/src/cli/run-manifest.ts`, `run-manifest-command.ts` — manifest schema, defaults and flags
  (A1–A4).
- `backend/src/cli/run-approval-verifier.ts`, `run-approval.ts`, `errors.ts` — verify, consume,
  `writeFileExclusive`, refusal codes.
- `backend/src/executors/real-run-executor.ts`, `real-run-guards.ts`, `claude-code-executor.ts` —
  executor seam, guards, `spawnClaude` (C1, D1).
- `backend/src/executors/worktree.ts` — `createWorktree({seedFiles})`, `pinnedGit`, cleanup.
- `backend/src/cli/candidate-offline-profiles.ts`, `candidate-offline-command.ts`,
  `candidate-offline-bundle.ts` — profile v2, the verifier entry, bundle persistence (F2, E2).
- `backend/src/cli/committed-source-bundle.ts:496-516, ~1149-1175` — safe-open flag and `fstat`
  patterns.
- `backend/src/executors/shell-verifier.ts:32-66` — process-group kill template.
- `backend/src/orchestrator/guardrails.ts` — ceilings plus new real-run defaults (A4).
- `tests/fixtures/claude-worker/fake-claude.mjs`, `tests/harness/real-run-harness.ts`,
  `tests/harness/harness-isolation.test.ts`, `tests/executors/real-run-bypass-static.test.ts`,
  `tests/cli/run-approval-isolation.test.ts`.
- `tests/spikes/permission-probe-findings.md` — the probe decisions this plan applies.
