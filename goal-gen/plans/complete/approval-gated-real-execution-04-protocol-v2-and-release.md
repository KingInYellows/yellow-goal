# Feature: Protocol v2 and release

## Overview

Protocol v1 promises zero spend, so real runs get a new `yellow-goal/provider-protocol/v2` that is
a superset of v1: v2 stub runs equal v1 stub runs, and a real run is a distinct, explicitly
selected capability. v1 stays byte-identical. This shell exposes the real-run engine through v2,
proves the operator runbook in CI against the fake worker, and releases the tarball the consumer
will pin.

Human-control constraint (spec header, `CLAUDE.md`): everything here is zero-spend code. No step
runs `run approve`, a real `claude`, `npm run runner`, or `run --executor claude-code`, and no
autonomous session cuts the release tag — the final release step is operator-executed.

## Origin

- Spec: `plans/specs/approval-gated-real-execution.md` (cite requirements as `AGX-R<n>` outside the spec)
- Covers: AGX-R22, AGX-R23, AGX-R24, AGX-R25, AGX-R26, AGX-R27, AGX-R33 (acceptance rows A7, A8 engine half, A10 recipe half)
- Shell: approval-gated-real-execution-04-protocol-v2-and-release
- Depends on (archived): `plans/complete/approval-gated-real-execution-0{1,2,3}-*.md`

## Pattern Survey

**Protocol v1 surface (to extend, not rewrite)**
- `backend/src/cli/provider-capabilities.ts:13-59` — `ProviderProtocolVersion`, `ProviderCapabilities`
  (literal-tuple `operations`/`capabilities`), `runCapabilities(argv)`; `parseArgs` is strict and only
  knows `--json`, so `--protocol v2` currently throws `CliUsageError`. The module must not import
  run/executor code (pinned by `tests/cli/capabilities-isolation.test.ts`).
- `backend/src/cli/run-manifest.ts:31` already exports `RealRunProtocolId = 'yellow-goal/provider-protocol/v2'`
  ("not advertised until v2 lands"); shell 01 said shell 04 moves/re-exports it. Test fixtures in
  `tests/executors/fake-worker.test.ts:26`, `tests/executors/real-run-executor.test.ts:38`,
  `tests/harness/real-run-harness.test.ts:32` already use that exact string — do not rename.
- `backend/src/cli/protocol-run-options.ts:24-76` — `parseRunInvocation` → `ParsedRunInvocation`
  (`legacy` | `provider-v1`). `:48` restricts `--executor` to `stub|claude-code`; `:58` rejects any
  protocol but `v1`; `:59` "provider protocol v1 requires --executor stub" (must stay verbatim).
- `backend/src/cli/provider-run-v1.ts:123` — `runProviderV1(inputs, request, invocation, options)`
  with seams `{writerFactory, signals, engineFactory, confirmFactory}`; `run.start` payload at
  `:203-207` hard-codes `protocolVersion: ProviderProtocolVersion`, `executor: 'stub'`,
  `simulation: true`. Consent at `:188-200` (`--yes` → `gate.autoConfirm`, else `gate.required` →
  `RUN_GATE_REQUIRED`). Stderr codes via `summaryError` (`:110`) and `RUN_STDOUT_TRANSPORT_FAILED` (`:248`).
- Event plumbing to reuse: `createProtocolStdoutWriter` (`events/protocol-stdout-writer`),
  `RunEventEmitter` (`events/run-event-emitter.ts:47-50`, envelope `yellow-goal/run-event/v1`).
  `RunEventSchema` (`contracts/run-event.ts`) is `.passthrough()` with `type: z.string()`, so new
  event types/payload keys validate under run-event/v1 — v2 keeps run-event/v1 (no compat-schema change).
- `backend/src/cli/run-command.ts:139` — `runRunCommand` dispatches `provider-v1` at `:149`, else the
  legacy path whose `claudeCodeEngine` (`:79-93`) hardcodes `bypassPermissions` at `:88`.
  `backend/src/cli/index.ts:92-109` intercepts `run manifest`/`run approve` on the first positional,
  so `run <request> --protocol v2 …` reaches `runRunCommand`.
- `backend/src/cli/run-manifest-command.ts:21-38` — `RUN_MANIFEST_OPTIONS` (profile, model, max-turns,
  per-action-usd, total-usd, action-timeout-ms, run-wall-clock-ms, auth-mode, allowed-tool,
  disallowed-tool, expires-in-minutes, bundle-dir, spend-ledger); `manifestFromFlags` (`:68`) is
  offline and idempotent. `--approval` exists nowhere yet.

**Real-run engine (consumed from shell 03)**
- `backend/src/real-run/real-run-engine.ts:157` — `runRealRun(input: RealRunInput): Promise<RealRunOutcome>`;
  `RealRunInput` (`:54-71`) = `requestPath, manifestFlags, approvalPath, executorFactory?, env?, clock?, stateDir?, signal?`.
  No progress hooks today: consumption at `:131` (inside `prepare`), ledger writes at `:228`
  (executor threw → unknown spend) and `:253` (one entry per spawn). It installs its own
  SIGHUP/SIGINT/SIGTERM handlers after consumption (`:199`). Usage/request errors throw before the
  approval is read; pre-consumption refusals throw `RunApprovalError`.
- `backend/src/real-run/outcome.ts:46-70` — `refused {code, message, approvalId?, details?}`,
  `worker-failed {approvalId, targetRepositoryHonored:false, reason, evidence, spend?}`,
  `verification-rejected {bundleDir, reasons, spend, outOfScopeChanges}`, `verified {bundleDir, spend, outOfScopeChanges}`;
  `RealRunSpend = {costUsd|null, turns|null, durationMs, exitClass}`. Refusal codes: `cli/errors.ts:49-67`.
- Worker injection: `RealRunInput.executorFactory` → `createRealRunExecutor(manifest, {workerCommand})`
  (`executors/real-run-executor.ts`). Production passes no factory; `harness-isolation.test.ts`
  allows the string `workerCommand` only in the two executor modules.

**Test-only harness + fake worker (consumed from shell 02/03)**
- `tests/harness/real-run-harness.ts` — run as `node node_modules/tsx/dist/cli.mjs tests/harness/real-run-harness.ts`;
  engine mode `--request --approval --state-dir --scenario --record` + every `RUN_MANIFEST_OPTIONS`
  flag; prints one `RealRunOutcome` JSON line; exits verified 0 / failed|rejected 1 / usage 2 / refused 3.
  Executor mode `--manifest --scenario --record`.
- `tests/fixtures/claude-worker/fake-claude.mjs` — scenarios incl. `success`, `error-result`,
  `budget-stop`, `max-turns`, `permission-denial`, `malformed-output`, `missing-cost`, `hang`,
  `wrong-repair`, `out-of-scope-write`; envelopes under `envelopes/`.
- Approvals in tests are minted by `mintApproval` (`tests/real-run/support.ts`) through the injected
  TTY seam `runRunApprove(…, {terminal})`. `tests/harness/real-run-harness.process.test.ts` strips
  `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_OAUTH_TOKEN` from the child env.
- Exclusion: `package.json` `files` = `bin/ backend/src/ packs/ policies/ schemas/`;
  `tests/harness/harness-isolation.test.ts` statically proves the bin graph never reaches `tests/`.

**Operator recipe (ADR-0019) and release (ADR-0016)**
- `scripts/operator-committed-source-paths.sh` — `extract_recipe` (awk: `<!-- recipe:NAME -->` marker,
  next ```` ```bash ```` fence) + `run_recipe` (`eval`), `mktemp -d` + trap, plain `test`/`cmp`
  assertions, final "… passed" line. Hard-wired to `docs/operator-committed-source.md`.
- `docs/operator-real-run.md` — steps 1–2 and step-3 engine semantics + refusal table complete;
  status line `:9-11`, step-3 heading `:79-82` (future tense, "command lands with shell 04"), step 4
  `:125-129` is a placeholder. No `recipe:` markers yet.
- `.github/workflows/ci.yml` jobs `engine`, `install-smoke`, `operator-recipe`;
  `.github/workflows/release.yml` re-runs the same three on the verified tag and `publish` has
  `needs: [engine, install-smoke, operator-recipe]`.
- `scripts/install-smoke.sh` → `scripts/installed-protocol-smoke.mjs`: asserts v1 `capabilities`
  (`:24`, `:201-202`) and v1 stub runs; must keep passing unchanged (AGX-R22) plus gain v2 checks.
- Version: tags `v0.1.0`, `v0.2.0`; `package.json` is `0.2.0`; last bump `09bcd16`
  ("chore: prepare goal-gen 0.2.0 protocol release (#33)") touched `package.json`,
  `package-lock.json` (two fields), `CLAUDE.md`, `AGENTS.md`, release-workflow comments, and
  `tests/release/release-asset.test.ts`. Version is derived via `readArtifactVersion`
  (`cli/artifact-version.ts`) into `version --json`, capabilities, and manifest `engineVersion`
  (so approvals bind to it: `APPROVAL_ENGINE_MISMATCH`). Literal `'0.2.0'` fixture manifests:
  `tests/executors/fake-worker.test.ts:25`, `tests/executors/real-run-executor.test.ts:37`,
  `tests/harness/real-run-harness.test.ts:31`. `packets/compiler.ts:27` `ENGINE_VERSION = '0.1.0'`
  is the packet-format identity — never bump it.
- Learnings: `docs/solutions/security-issues/approval-gated-execution-marker-and-manifest-design.md`,
  `docs/solutions/code-quality/adding-a-non-protocol-cli-verb-to-goal-gen.md`.

**Design decisions taken in this expansion (not spec-level; pinned by tests below)**
- Capability id for the real run: `run.executor.agx-claude-code` (mirrors `run.executor.stub`). The
  legacy `run.executor.claude-code` is never advertised.
- v2 capabilities = the v1 body with `protocolVersion` set to v2, `capabilities` extended by
  `run.executor.agx-claude-code`, plus `supportedProtocols: [v1, v2]`; `schemaVersion` stays
  `provider-capabilities/v1` (the response object is additive; v1 output is untouched).
- Event names: spend event `run.spend`; the real-run terminal event is `run.summary` (same type v1
  consumers already treat as terminal) with an `outcome` discriminator.
- Real-run exit/error mapping keeps the ADR-0016 contract (0/1/2): `verified` → 0 (awaiting human,
  AGX-R20); `worker-failed` → 1 + `RUN_WORKER_FAILED`; `verification-rejected` → 1 +
  `RUN_VERIFICATION_REJECTED`; `refused` → 1 + the refusal code, no events; flag misuse → 2 `USAGE_ERROR`.
- CI never runs `run approve` (human-only per `CLAUDE.md`). The recipe mints approvals through a
  new test-only harness mode that wraps the existing injected-TTY seam — outside `files`, never
  reachable from the bin.
- The recipe runs as a second step of the existing `operator-recipe` job (no new job, so the
  ADR-0016/0019 job inventory is unchanged and no superseding ADR is needed).

## Implementation

### 1. Identity, discovery, and v1 goldens (AGX-R22)
- [x] Step 1.1: **Before any protocol change**, add byte goldens for v1 in
  `tests/golden/provider-v1/`: `capabilities.json` (exact stdout bytes of `capabilities --json`),
  per-scenario normalized v1 stub streams (`success`, `failed`, `budget-exhausted`, `await-cancel`;
  normalize only `runId`, `timestamp`, durations) and the stderr error envelopes for
  `RUN_GATE_REQUIRED`, `--protocol v1 --executor claude-code`, unknown protocol. Add
  `tests/cli/provider-v1-golden.test.ts` that regenerates and byte-compares them. Commit goldens
  generated from current `main`.
- [x] Step 1.2: In `backend/src/cli/provider-capabilities.ts` add `ProviderProtocolV2 =
  'yellow-goal/provider-protocol/v2'`, `SupportedProtocols = [v1, v2] as const`, a
  `ProviderCapabilitiesV2` type, and the `run.executor.agx-claude-code` capability literal. Make
  `backend/src/cli/run-manifest.ts` re-export `RealRunProtocolId` from it (direction:
  run-manifest → capabilities, so `capabilities-isolation` stays green).
- [x] Step 1.3: Extend `runCapabilities(argv)` with an optional `--protocol v1|v2` string option.
  No selector → unchanged v1 object (golden). `--protocol v1` → same v1 object. `--protocol v2` →
  v2 object (decision above). Any other value → `CliUsageError` (exit 2).
- [x] Step 1.4: Tests in `tests/cli/capabilities-verb.test.ts`: v2 lists `supportedProtocols` equal
  to `[v1, v2]` and includes `run.executor.agx-claude-code`, never `run.executor.claude-code`;
  no-selector output unchanged (golden from 1.1); bad selector → exit 2. Keep
  `tests/cli/capabilities-isolation.test.ts` green.

### 2. Stub parity (AGX-R23)
- [x] Step 2.1: In `backend/src/cli/protocol-run-options.ts` generalize `provider-v1` to
  `{mode: 'provider', protocol: 'v1' | 'v2', executor: 'stub', …}` (or add a `protocol` field to
  the existing shape). Accept `--protocol v2` with `--executor stub` and every v1 stub flag
  (`--yes`, `--timeout-ms`, `--stub-scenario`, `--allow-guardrail-override`) with identical rules.
  Keep the `v1` message at `:59` verbatim.
- [x] Step 2.2: In `backend/src/cli/provider-run-v1.ts` replace the hard-coded
  `protocolVersion: ProviderProtocolVersion` at `:206` with the invocation's protocol id; nothing
  else in the stub path changes. Update `run-command.ts:149` dispatch for the renamed mode.
- [x] Step 2.3: `tests/cli/provider-run-v2-stub.test.ts`: for every stub scenario (with/without
  `--yes`, `await-cancel` + `--timeout-ms`), run v1 and v2 through `runRunCommand` with the same
  seams, normalize, replace the protocol id, and assert deep equality of stdout events, stderr
  envelope and exit code. Golden test from 1.1 still byte-passes.

### 3. Real-run surface (AGX-R24, AGX-R25)
- [x] Step 3.1: Engine hooks in `backend/src/real-run/real-run-engine.ts`: add optional
  `onStarted?(info: {approvalId, manifestHash, manifest, targetRepository})` to `RealRunInput`,
  called once immediately after `consumeRunApproval` succeeds (i.e. only when every pre-spawn
  refusal passed), and `onSpend?(spend: RealRunSpend)` called exactly where a ledger entry is
  recorded (`:228` executor-threw path and `:253` per-spawn path), regardless of whether the ledger
  write succeeded. Hooks are observers: a hook throw must not skip cleanup (wrap and surface as
  `worker-failed` `engine-error` evidence). Unit tests in `tests/real-run/` (fake worker): refused
  → neither hook; NOT_SPAWNED classes and pre-spawn cancel → `onStarted` only; every spawned
  scenario → exactly one `onSpend`, before the outcome resolves.
- [x] Step 3.2: Parser: in `protocol-run-options.ts` add mode `provider-v2-real` selected only by
  `--protocol v2 --executor agx-claude-code`. It requires the positional request, `--approval <path>`,
  and the `RUN_MANIFEST_OPTIONS` flags (reuse that table; `manifestFromFlags` validates values).
  Usage errors (exit 2, no spawn): `--yes`/`-y` on a real run (AGX-R25), `--stub-scenario`,
  `--timeout-ms`, `--allow-guardrail-override` with `agx-claude-code`; `agx-claude-code` without
  `--protocol v2`; manifest flags or `--approval` on stub/legacy runs. Extend
  `tests/cli/protocol-run-options.test.ts` with each case.
- [x] Step 3.3: New `backend/src/cli/provider-run-v2-real.ts` exporting
  `runProviderV2Real(invocation, options?: {executorFactory?, writerFactory?, signals?, stateDir?, env?, clock?})`.
  It calls `runRealRun` (never the Orchestrator, `ClaudeCodeExecutor`, or `run-command.ts`
  engines) with `onStarted`/`onSpend` wired to a `RunEventEmitter` over `createProtocolStdoutWriter`:
  - `run.start` payload: `protocolVersion` (v2), `executor: 'agx-claude-code'`, `simulation: false`,
    `targetRepository`, `targetRepositoryHonored: false`, `approvalId`, `manifestHash`,
    `profile: {id, version, digest}`, `caps` (from the approved manifest). No bundle path.
  - `run.spend` payload: `approvalId` + `RealRunSpend`, one per `onSpend`.
  - Terminal `run.summary` with `outcome` = `worker-failed` (`reason`, `evidence`, no bundle path)
    | `verification-rejected` (`bundleDir`, `reasons`, `outOfScopeChanges`) | `verified`
    (`bundleDir`, `outOfScopeChanges`); spend is carried by the preceding `run.spend` event(s).
  - `refused` outcome and thrown `RunApprovalError` → no events at all; exactly one structured
    stderr error `{"error":{"code","message", approvalId?}}`, exit 1. `CliUsageError` → exit 2.
  - No `gate.*` events (approval replaces DoD confirm, AGX-R25).
  - Stdout transport failure aborts the engine via its `signal` and ends with
    `RUN_STDOUT_TRANSPORT_FAILED` (mirror `provider-run-v1.ts:248`).
  Production passes no `executorFactory`/`stateDir`; the option exists for the test-only harness.
- [x] Step 3.4: Dispatch in `backend/src/cli/run-command.ts`: `provider-v2-real` →
  lazy `import('./provider-run-v2-real')` before `requestToRunInputs`/legacy wiring. Update
  `docs/solutions/code-quality/adding-a-non-protocol-cli-verb-to-goal-gen.md` only if the pattern
  diverges (likely not).
- [x] Step 3.5: `tests/cli/provider-run-v2-real.test.ts` (fake worker via `executorFactory`,
  approvals via `mintApproval`): event order `run.start` → `run.spend` → `run.summary` for
  `success` (verified, exit 0), `wrong-repair` (verification-rejected, bundle path present),
  `budget-stop`/`missing-cost`/`error-result` (worker-failed, spend present, no bundle path),
  pre-spawn cancel after consumption (`run.start`, no `run.spend`, worker-failed); each refusal
  (`APPROVAL_MISSING`, `APPROVAL_HASH_MISMATCH`, `APPROVAL_CONSUMED`, `AUTH_MODE_MISMATCH`, `RUN_CANCELLED`)
  → zero stdout bytes, one stderr error, `approvalId` present exactly per AGX-R6, fake worker
  recorded zero invocations; `--yes` → exit 2, zero invocations; every event validates against
  `RunEventSchema`.

### 4. Legacy isolation (AGX-R26)
- [x] Step 4.1: In `protocol-run-options.ts`, `--protocol v2 --executor claude-code` → `USAGE_ERROR`
  ("provider protocol v2 does not support --executor claude-code; use agx-claude-code with an
  approval") before any request load; keep `--protocol v1` requiring `stub`. Tests assert a fake
  `claude` on `PATH` records zero invocations for this case.
- [x] Step 4.2: Static regression test `tests/cli/provider-v2-isolation.test.ts`:
  `provider-run-v2-real.ts` and its import graph never import `claude-code-executor`,
  `orchestrator/orchestrator`, `llm-extractor`, `run-command`, or `tests/`, and never contain
  `bypassPermissions`; the `agx-claude-code` branch in `run-command.ts` dispatches only to
  `runProviderV2Real`. Keep `run-approval-isolation`, `harness-isolation`, `capabilities-isolation` green.

### 5. Runbook and operator-recipe CI (AGX-R33)
- [x] Step 5.1: Test-only harness modes in `tests/harness/real-run-harness.ts`:
  `--mode mint-approval` (manifest flags + `--out`; mints via the injected-TTY seam the same way
  `tests/real-run/support.ts` `mintApproval` does; prints `{approvalId, path}`) and `--mode protocol-v2`
  (same argv as the production `run <request> --protocol v2 --executor agx-claude-code …` plus
  `--scenario --record --state-dir`; calls `runProviderV2Real` with the fake-worker
  `executorFactory`, so the stdout JSONL stream is the production one). Extend
  `tests/harness/real-run-harness.process.test.ts` to cover both modes as processes;
  `harness-isolation.test.ts` stays green (the bin still never reaches `tests/`).
- [x] Step 5.2: Finish `docs/operator-real-run.md`: status line `:9-11` and step 3 `:79-123` in
  present tense with the real command `goal-gen run <request.json> --protocol v2 --executor
  agx-claude-code <same flags as step 1> --approval <path>`, the v2 event stream (`run.start`,
  `run.spend`, `run.summary` outcomes), exit codes, `--yes` rejection, and v2 refusal/usage codes
  added to the table (`:131-152`); step 4 `:125-129` replaced with `acceptance reproduce <bundle-dir>`
  in a fresh process + the operator's accept decision (AGX-R20). Add a "Rehearsal (fake worker,
  zero spend)" section with `<!-- recipe:NAME -->`-marked ```` ```bash ```` fences that drive
  only the harness (`mint-approval`, `protocol-v2` for `success`, `wrong-repair`, `budget-stop`,
  and a reused approval → `APPROVAL_CONSUMED`) and `acceptance reproduce` on the produced bundle.
  State in the doc that the production command is never exercised in CI.
- [x] Step 5.3: New `scripts/operator-real-run-recipe.sh` modeled on
  `operator-committed-source-paths.sh` (`extract_recipe`/`run_recipe`, `mktemp -d` + trap, scrubbed
  `ANTHROPIC_*`/`CLAUDE_CODE_*` env, plain `test` assertions on exit codes, event order and
  outcome kinds, fake-worker record line counts). It must fail if any extracted fence invokes
  `run approve`, `--executor claude-code`, or the production bin's real-run path, and must never set
  `PATH`/env to select a worker. Add `npm run test:operator-recipe:real-run`.
- [x] Step 5.4: Add `bash scripts/operator-real-run-recipe.sh` as a second step of the
  `operator-recipe` job in `.github/workflows/ci.yml` and in `.github/workflows/release.yml`
  (same job, so `publish.needs` and the tag-verify block are unchanged).

### 6. Release (AGX-R27)
- [x] Step 6.1: Extend `scripts/installed-protocol-smoke.mjs` (called by `install-smoke.sh`): keep
  all v1 assertions byte-for-byte; add: `capabilities --json --protocol v2` lists
  `supportedProtocols` and `run.executor.agx-claude-code`; a v2 stub `success` run matches v1 apart
  from the protocol id; `run --protocol v2 --executor agx-claude-code … --approval <missing>` from
  the installed bin exits 1 with `APPROVAL_MISSING`, zero stdout bytes (refusal precedes any
  spawn); `--protocol v2 --executor claude-code` exits 2. Update `tests/release/installed-protocol-smoke.test.ts`
  for the new checks.
- [x] Step 6.2: Version bump `0.2.0` → `0.3.0` following `09bcd16`: `package.json`,
  `package-lock.json` (both fields). Replace literal `engineVersion: '0.2.0'` in
  `tests/executors/fake-worker.test.ts:25`, `tests/executors/real-run-executor.test.ts:37`,
  `tests/harness/real-run-harness.test.ts:31` with `readArtifactVersion()` where the value is
  compared against the live engine (leave pure fixtures as-is if not). Do not touch
  `packets/compiler.ts` `ENGINE_VERSION` or `docs/operator-committed-source.md` example versions.
- [x] Step 6.3: Docs: `CLAUDE.md` — replace "has no CLI verb until shell 04" (Commands) with the v2
  command; add v2 to "Provider Protocol commands" (`capabilities --json --protocol v2`, v2 stub
  parity, real run via `agx-claude-code` + `--approval`, `--yes` rejected). Mirror in `AGENTS.md`.
  Note in `plans/specs/provider-protocol-v1.md` (or its README pointer) that v2 is specified by
  ADR-0020 / the AGX spec; do not edit accepted ADRs.
- [x] Step 6.4: Gates locally: `npm run typecheck && npm test && npm run eval && bash scripts/install-smoke.sh && npm run test:operator-recipe && npm run test:operator-recipe:real-run`.
- [x] Step 6.5 (**operator-executed, not an autonomous session**): after the PR(s) merge, the
  operator runs `git tag -a v0.3.0 -m v0.3.0` on the bump commit and pushes the tag; the Release
  workflow attaches `goal-gen-0.3.0.tgz` (no `.sha256` sidecar — `release.yml` publishes the tarball
  only). Hash evidence: download the asset, check `sha256sum` equals GitHub's asset digest
  (`gh release view v0.3.0 --json assets`), and record the release URL + SHA-256 in the PR/handoff
  that shell 05 (consumer pin) consumes. Mark this box only after the release is public.
  Evidence (2026-10-01): annotated tag `v0.3.0` -> `2f336d5` (PR #71); Release run 36896070768 succeeded;
  https://github.com/KingInYellows/yellow-goal/releases/tag/v0.3.0 ; `goal-gen-0.3.0.tgz` SHA-256
  `16e9d4b84f8b771ca1c368c886da70ef0d29c5e2af5ba68a51094c20f0a5db23` (downloaded asset equals GitHub's asset digest;
  no separate `.sha256` asset was published).

## Verification

- `npm test -- tests/cli/provider-v1-golden.test.ts` -> v1 `capabilities --json`, stub streams and error envelopes byte-equal to goldens captured before the change (AGX-R22).
- `npm run cli -- capabilities --json --protocol v2` -> JSON with `protocolVersion` v2, `supportedProtocols` `[v1, v2]`, `run.executor.agx-claude-code`, no `run.executor.claude-code`.
- `npm test -- tests/cli/provider-run-v2-stub.test.ts` -> v2 stub == v1 stub modulo protocol id for every scenario (AGX-R23).
- `npm test -- tests/cli/provider-run-v2-real.test.ts tests/real-run` -> event order/payloads per AGX-R24; refusals emit zero events and one stderr error; `--yes` exits 2 (AGX-R25).
- `npm run cli -- run <request.json> --protocol v2 --executor claude-code` -> exit 2 `USAGE_ERROR`, no spawn (AGX-R26); `--protocol v1 --executor claude-code` still exit 2 with the v1 message.
- `npm test -- tests/cli/provider-v2-isolation.test.ts tests/harness/harness-isolation.test.ts tests/cli/run-approval-isolation.test.ts tests/cli/capabilities-isolation.test.ts` -> all green.
- `npm run test:operator-recipe:real-run` -> "operator-real-run-recipe: … passed", all fences run against the harness + fake worker, zero real `claude` (AGX-R33).
- `bash scripts/install-smoke.sh` -> installed 0.3.0 tarball passes v1 and v2 checks (A8 engine half).
- `npm run typecheck && npm test && npm run eval` -> green on Node 22.22.3 (`nvm exec 22.22.3 …`).
- After operator tag: GitHub Release `v0.3.0` has `goal-gen-0.3.0.tgz` whose downloaded SHA-256 matches GitHub's asset digest (AGX-R27).

## Context Files

- `plans/specs/approval-gated-real-execution.md` — AGX-R22–R27, R33, Design/Decisions, acceptance rows A7/A8/A10.
- `docs/decisions/0020-approval-gated-real-execution.md`, `0017-provider-protocol-v1-stdio.md`, `0016-ci-gates-and-tarball-installation.md`, `0019-operator-recipe-ci-gate.md` — locked decisions; supersede, never edit.
- `plans/specs/provider-protocol-v1.md` — v1 contract that must stay byte-identical.
- `backend/src/cli/provider-capabilities.ts`, `protocol-run-options.ts`, `provider-run-v1.ts`, `run-command.ts`, `index.ts`, `run-manifest.ts`, `run-manifest-command.ts`, `run-approval-verifier.ts`, `errors.ts` — protocol + CLI surface.
- `backend/src/real-run/real-run-engine.ts`, `outcome.ts`, `spend-ledger.ts`, `evidence-destinations.ts`; `backend/src/executors/real-run-executor.ts` — engine consumed from shells 02/03.
- `backend/src/events/run-event-emitter.ts`, `events/protocol-stdout-writer.ts`, `contracts/run-event.ts` — event plumbing.
- `tests/harness/real-run-harness.ts`, `tests/fixtures/claude-worker/fake-claude.mjs`, `tests/real-run/support.ts` — test-only harness, fake worker, approval minting seam.
- `tests/cli/capabilities-verb.test.ts`, `provider-run-v1.test.ts`, `protocol-run-options.test.ts`, `capabilities-isolation.test.ts`, `run-approval-isolation.test.ts`; `tests/harness/harness-isolation.test.ts` — existing pins to keep green.
- `docs/operator-real-run.md`, `scripts/operator-committed-source-paths.sh` — runbook and the ADR-0019 recipe pattern.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/install-smoke.sh`, `scripts/installed-protocol-smoke.mjs`, `scripts/prepare-release-asset.sh` — gates and release.
- `docs/solutions/security-issues/approval-gated-execution-marker-and-manifest-design.md` — approval binding to engine version.
