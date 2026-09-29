# Feature: Approval foundation

## Overview
Step 6 (VS layer 4a) must never spend money without a prior, verifiable human decision. This
slice records the decision (ADR-0020) and builds the zero-spend approval machinery every later
shell relies on: a deterministic run manifest, a terminal-only approval ceremony, the
`yellow-goal/run-approval/v1` record, and the pre-spawn verifier with single-use consumption. No
`claude` is spawned anywhere in this slice.

Scope boundary: this slice ships the approval **library + two verbs** (`run manifest`,
`run approve`). Wiring the verifier/consumer into an actual real-run path (`run --protocol v2
--executor agx-claude-code --approval …`; the legacy `claude-code` executor stays unreachable from
v2, AGX-R24/R26) is shell 03; carrying `approvalId` into `run.start`, the
spend ledger and the outcome is realized by shells 02–04 using the `VerifiedApproval` type
produced here. `capabilities --json` is **not** changed (the new verbs are not protocol
operations; `scripts/install-smoke.sh:144` asserts non-protocol verbs stay out of it).

## Origin
- Spec: `plans/specs/approval-gated-real-execution.md`
- Covers: AGX-R1, AGX-R2, AGX-R3, AGX-R4, AGX-R5, AGX-R6 (partial: `VerifiedApproval` carries
  `approvalId`; emission in `run.start` / ledger / outcome lands in shells 02–04)
- Shell: approval-gated-real-execution-01-approval-foundation

## Implementation Notes (review outcomes)
- Consumption marker is keyed by `approvalId` under an engine state dir
  (`defaultApprovalStateDir()`: `$XDG_STATE_HOME/yellow-goal`, else `~/.local/state/yellow-goal`;
  `consumed/<approvalId>`), not `${approvalPath}.consumed` as step 12 and AGX-R5 originally said —
  a path-keyed marker allowed copy-replay (operator decision 2026-09-28; recorded in ADR-0020;
  step 12 and AGX-R5 since amended).
  Verifier/consumer take an injectable `stateDir`; when omitted, `defaultApprovalStateDir()`
  applies. Shell 03 only decides the state-dir permission and `--state-dir` policy.
- Security review: approval records are consent evidence, not credentials (forgeable by any
  process running as the operator; pty-drivable). Documented in ADR-0020 Consequences; the
  harness-level PreToolUse deny is follow-up work in the workspace, not this repo.
- Also added from review: future-dated `createdAt` → `APPROVAL_INVALID`; strict ASCII tool-rule
  charset (no leading `-`, no bidi/zero-width); safe-integer flags; ceremony shows sanitized
  request id/mode/goal; partial approval files removed on write failure.
- PR #55 review (`/review:pr`, 16 reviewers) fixes: consume re-checks expiry (`APPROVAL_EXPIRED`);
  state-dir/marker I/O errors → `APPROVAL_STATE_UNAVAILABLE`, `--out` errors →
  `APPROVAL_OUT_UNWRITABLE` (symlink → `APPROVAL_OUT_EXISTS`); `RunApprovalError` codes typed as a
  const union; `writeFileExclusive` closes inside the try and reports failed cleanup; manifest
  defaults live only in `buildRunManifest` (`RUN_MANIFEST_DEFAULTS`) so the real run cannot drift;
  flag-values type derived from `RUN_MANIFEST_OPTIONS`; spec AGX-R5/Decisions/header amended.
- API names differ from the step text above: step 6's `parseRunManifestArgs` is
  `RUN_MANIFEST_OPTIONS` + `manifestFromFlags(values, positionals, verb)` (also returns the
  request); step 7's `writeFileExclusive` takes no `mode` (always 0600); step 11 also refuses a
  future-dated `createdAt` (`APPROVAL_INVALID`).
- Deferred to shells 02/03 (PR #55 review residuals): `--profile id@version` once config-repair v2
  exists (shell 02); how the real run sources approval-only `expiresInMinutes` when recomputing
  the manifest, and the `--state-dir` policy (shell 03); dropping `challenge` from `run manifest`
  output; branding `VerifiedApproval`; re-validating the manifest inside `mintRunApprovalRecord`.
- Review pass 2: goal shown JSON-escaped, length-capped and above the manifest (display-spoofing);
  no nested parentheses in tool specifiers; relative `XDG_STATE_HOME` ignored; marker names
  lower-cased. Deferred P3: an already-existing state dir with loose permissions is not
  tightened or refused (another local user could pre-create markers to block runs) — shell 03
  should decide when it wires the default state dir.

## Pattern Survey

**CLI dispatch** — `backend/src/cli/index.ts` `dispatch(argv)` (lines ~52–160) is a `switch`
with dynamic `await import(...)` per verb; `acceptance` peeks `const [sub, ...subRest] = rest`.
`case 'run'` (~line 90) passes everything to `runRunCommand(rest)`, whose `parseRunInvocation`
(`cli/protocol-run-options.ts:22-76`) demands exactly one positional — so `run manifest|approve`
must be intercepted in the dispatcher **before** `./run-command` is imported (also keeps the new
verbs from loading executor/orchestrator code). A request file literally named `manifest` or
`approve` remains reachable as `./manifest`. Header docstring (`index.ts:3-17`) and the
unknown-verb message list verbs by hand.

**Output / errors** — verbs return `CommandOutput<T> = { json, output }` (`cli/commands.ts:22-25`),
printed by `writeSuccess`. Errors: one-line stderr `{"error":{"code","message","details?"}}` via
`writeError`; no code registry — each family has a class in `cli/errors.ts`
(`AcceptanceEvidenceError` 23-33, `ObservedFixtureError` 36-46, shape `(code, message, details?)`)
plus an explicit `instanceof` branch in `main()` (`index.ts:172-179`, exit 1), else it collapses
to `UNEXPECTED_ERROR`. `CliUsageError` → `USAGE_ERROR`, exit 2.

**Schemas** — `export const XxxSchemaVersion = 'yellow-goal/<kebab>/v1' as const`; strict zod
schemas with `z.literal(...)` and a `fail(code, msg, details?): never` helper
(`cli/acceptance-evidence.ts:7-96`).

**Hashing** — `canonicalJson(value)` (`backend/src/packs/canonical-json.ts:25`, sorted keys,
2-space, trailing `\n`); `sha256Hex` (`backend/src/packets/checksums.ts:8`; CLI copy in
`cli/implementation-revision.ts:8`). `candidateProfileDigest(profile)`
(`cli/candidate-offline-profiles.ts:147`) + `getCandidateOfflineProfile(id)` (line 77) give the
profile id/version/digest. No request hash exists anywhere — define one here.

**Identity** — `readArtifactVersion()` (`cli/artifact-version.ts:4`, async, reads package.json);
do not use the packet compiler's `ENGINE_VERSION`. `ProviderProtocolVersion`
(`cli/provider-capabilities.ts:13`) is v1 only; v2 lands in shell 04.

**Requests** — `loadRunRequest(path)` (`run/request-to-run.ts:152`) → validated
`RepositoryGoalRequest` (throws `IntakeValidationFailure` → `VALIDATION_FAILED`). Imports only
intake + `orchestrator/guardrails` — isolation-safe.

**Guardrails** — `orchestrator/guardrails.ts`: `MAX_BUDGET_USD=20`, `ACTION_TIMEOUT_MS=600_000`,
`RUN_WALL_CLOCK_MS=3_600_000`, `DEFAULT_MODEL='haiku'`. `RunConfig` has no per-action USD cap and
the executor has no `--allowedTools`; those manifest fields are new surface (enforced later).
Permission mode type lives in `executors/claude-code-executor.ts:41` — do **not** import it
(isolation); declare the manifest's mode as the literal `'acceptEdits'`.

**Writes** — no `'wx'`/0600 helper exists. Closest precedent: `persistWriteFileFlags()`
(`cli/committed-source-bundle.ts:515-518`, `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`). `writeJsonFile`
(`commands.ts:32`) overwrites — unsuitable.

**Prompts / seams** — no `isTTY` checks exist. `stdinConfirm` / `stdinAcceptanceGate`
(`orchestrator/orchestrator.ts` ~1215/~1283) use `readline/promises`
`createInterface({ input: process.stdin, output: process.stderr })` — the template for the
challenge prompt (copy the shape, do not import the orchestrator). Injection style: options
objects (`RunCommandOptions.engineFactory`, `run-command.ts:135-138`). Clock: `clock?: () => Date`
(`events/run-event-emitter.ts:34`); ids: `randomUUID` from `node:crypto`.

**Tests** — vitest, `tests/cli/<name>.test.ts`; `main([...])` with `process.stdout/stderr.write`
spies and `mkdtemp(path.join(tmpdir(), 'goal-gen-…-'))` (`tests/cli/dispatch.test.ts:5-29`).
Isolation pattern: `tests/cli/acceptance-record-isolation.test.ts` (source grep for
`node:child_process`, `spawn`, `./run-command`; `vi.doMock` forbidden modules to throw). Zero-spawn
PATH shim: `tests/cli/acceptance-evidence.test.ts:501-540` (sentinel `#!/bin/sh` writing a stamp,
exit 97, prepended to `PATH`, run CLI via `spawnSync(process.execPath, [tsx, cli, …])`).

**Docs** — ADR template `docs/decisions/_template.md` (MADR: status/date/decision-makers;
Context / Decision / Alternatives / Consequences / Confirmation / Links); index row format
`| [0019](0019-operator-recipe-ci-gate.md) | title | accepted |` at the end of
`docs/decisions/README.md`. VS layer table: `plans/specs/verified-single-milestone-execution.md`
lines 14–22 (insert 4a between 3e and 4). Verb docs: `CLAUDE.md` Commands section (~line 70–76)
and its mirror `AGENTS.md:15-18`. Only runbook today: `docs/operator-committed-source.md`, which
`scripts/operator-committed-source-paths.sh` pins by exact path — a sibling runbook is safe.

## Implementation

### A. Decision record and docs (zero code)
- [x] Step 1: Write `docs/decisions/0020-approval-gated-real-execution.md` from `_template.md`
  (`status: accepted`, `date: 2026-09-28`): context (steps 1–5 + VS 3–3e are stub/offline; a
  real worker needs prior human consent), decision (single-use, TTY-minted, hash-bound approval
  of a deterministic manifest; filesystem marker for single use; `acceptEdits` + allowlist, never
  `bypassPermissions`; one attempt; verifier judges; new `provider-protocol/v2`), alternatives
  (signed approvals, daemon/DB state, env/flag approvals, reusing `--yes`), consequences,
  confirmation (the tests in steps 13–17 + later AGX acceptance rows), links (spec, brainstorm,
  ADR-0010/0011/0015/0017/0018/0019). Cite requirements as `AGX-R<n>`.
- [x] Step 2: Append the row `| [0020](0020-approval-gated-real-execution.md) | Approval-gated real execution (VS layer 4a) | accepted |` to `docs/decisions/README.md`.
- [x] Step 3: In `plans/specs/verified-single-milestone-execution.md`, insert a layer-table row
  `| 4a. Approval-gated real execution | … ADR-0020, spec plans/specs/approval-gated-real-execution.md … | In progress (approval foundation) |`
  between the 3e and 4 rows, and narrow row 4's text so it no longer claims all real-run
  capability is deferred (keep target-bound + captured-base real runs deferred).
- [x] Step 4: Create runbook skeleton `docs/operator-real-run.md`: headings for Prerequisites,
  1. Render manifest (`run manifest`), 2. Approve at a terminal (`run approve --out`), 3. Run
  (placeholder — shell 03), 4. Reproduce + accept (placeholder — AGX-R20), Refusal codes table
  (the `APPROVAL_*` codes from step 8), and an explicit "never from CI / an agent session; never
  `bypassPermissions`" banner. Paths are operator-supplied (workspace puts them under `runtime/`).

### B. Manifest (AGX-R1)
- [x] Step 5: Create `backend/src/cli/run-manifest.ts` exporting:
  - `RunManifestSchemaVersion = 'yellow-goal/run-manifest/v1' as const`
  - `RealRunProtocolId = 'yellow-goal/provider-protocol/v2' as const` (the protocol the real run
    will use; **not** advertised in `capabilities` — shell 04 re-exports/moves it)
  - `RUN_APPROVAL_MAX_EXPIRY_MINUTES = 60`
  - `type RunManifest` (strict zod `RunManifestSchema` + type): `schemaVersion`, `engineVersion`,
    `protocolId`, `profile: { id, version, digest }`, `requestHash`, `model`,
    `permissionMode: 'acceptEdits'` (literal — no other value representable), `allowedTools:
    string[]`, `disallowedTools: string[]`, `maxTurns`, `caps: { perActionUsd, totalUsd }`,
    `actionTimeoutMs`, `runWallClockMs`, `authMode: 'subscription' | 'api-key'`, `attemptCount: 1`
    (literal), `expiresInMinutes` (relative, so the hash is time-independent).
  - `type RunManifestInputs` and `buildRunManifest(inputs): RunManifest` — pure; validates:
    positive integers/numbers; `perActionUsd <= totalUsd <= MAX_BUDGET_USD`;
    `actionTimeoutMs <= ACTION_TIMEOUT_MS`; `runWallClockMs <= RUN_WALL_CLOCK_MS`;
    `1 <= expiresInMinutes <= 60` (default 60 — shorten only); tool lists trimmed, non-empty,
    de-duplicated and **sorted** (order-independence); `allowedTools` ∩ `disallowedTools` = ∅.
    Profile block from `getCandidateOfflineProfile(id)` + `candidateProfileDigest`. Violations
    throw `RunApprovalError('MANIFEST_INVALID', …)`.
  - `computeRequestHash(request: RepositoryGoalRequest): string` = `sha256Hex(canonicalJson(request))`.
  - `computeManifestHash(manifest): string` = `sha256Hex(canonicalJson(manifest))`.
  - `approvalChallenge(manifestHash): string` — first 8 hex chars as `xxxx-xxxx`.
  Imports limited to zod, `packs/canonical-json`, `packets/checksums`, `orchestrator/guardrails`,
  `cli/candidate-offline-profiles`, `contracts/request` (type), `cli/errors`.
- [x] Step 6: Create `backend/src/cli/run-manifest-command.ts` exporting
  `parseRunManifestArgs(argv): Promise<{ inputs: RunManifestInputs, … }>` (shared with approve)
  and `runRunManifest(argv): Promise<CommandOutput<{ manifest, manifestHash, challenge }>>`.
  Flags via `parseArgs`: positional `<request.json>` (loaded with `loadRunRequest`),
  `--profile <id>` (required), `--model` (default `DEFAULT_MODEL`), `--max-turns`,
  `--per-action-usd`, `--total-usd` (both required — AGX open question: values come from the R34
  probe), `--action-timeout-ms`, `--run-wall-clock-ms` (defaults = ADR-0010), `--auth-mode`
  (required), repeatable `--allowed-tool` / `--disallowed-tool`, `--expires-in-minutes`, `--json`.
  Engine version from `readArtifactVersion()`. Missing/invalid flags → `CliUsageError`. Header
  comment: dynamically imported; never loads `run-command`, executors, or spawns.

### C. Record (AGX-R3)
- [x] Step 7: Create `backend/src/cli/run-approval.ts` exporting
  `RunApprovalSchemaVersion = 'yellow-goal/run-approval/v1' as const`, strict zod
  `RunApprovalRecordSchema` + `type RunApprovalRecord` (`schemaVersion`, `approvalId` (uuid),
  `manifestHash` (64-hex), `manifest: RunManifest`, `createdAt`, `expiresAt` (ISO),
  `engineVersion`), `mintRunApprovalRecord(manifest, { clock, newId })` (expiresAt = createdAt +
  `manifest.expiresInMinutes`), `parseRunApprovalRecord(raw): RunApprovalRecord` (JSON/schema
  failure → `APPROVAL_INVALID`; also `APPROVAL_INVALID` when `manifestHash !==
  computeManifestHash(manifest)`, `engineVersion !== manifest.engineVersion`, or `expiresAt` is
  not exactly `createdAt + manifest.expiresInMinutes`), and
  `writeFileExclusive(path, data, mode = 0o600)` — `open(path, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,
  0o600)` + `fchmod(0o600)` (umask-proof) + write + fsync + close; `EEXIST` surfaces to callers.
- [x] Step 8: Add `RunApprovalError` (`code`, `message`, `details?`, `name = 'RunApprovalError'`) to
  `backend/src/cli/errors.ts` and an `instanceof RunApprovalError` branch in `main()`
  (`backend/src/cli/index.ts`, alongside `ObservedFixtureError`, exit 1). Codes used by this
  slice: `MANIFEST_INVALID`, `APPROVAL_TTY_REQUIRED`, `APPROVAL_DECLINED` (wrong challenge /
  EOF), `APPROVAL_OUT_EXISTS`, `APPROVAL_MISSING`, `APPROVAL_INVALID`, `APPROVAL_HASH_MISMATCH`,
  `APPROVAL_EXPIRED`, `APPROVAL_ENGINE_MISMATCH`, `APPROVAL_CONSUMED`.

### D. Ceremony (AGX-R2)
- [x] Step 9: Create `backend/src/cli/run-approval-command.ts` exporting
  `type ApprovalTerminal = { stdin: NodeJS.ReadableStream & { isTTY?: boolean }, output:
  NodeJS.WritableStream & { isTTY?: boolean } }` and `runRunApprove(argv, options?: { terminal?,
  clock?, newId? })`. Flow: parse the same flags as step 6 plus required `--out <path>` → build
  manifest → **if stdin or stderr is not a TTY throw `APPROVAL_TTY_REQUIRED` before any write**
  → print manifest (pretty) + hash + challenge to the controlling terminal (`/dev/tty`, never
  stderr — stderr stays the single JSON error line, ADR-0016) → `readline/promises` question on
  (stdin, terminal) → mismatch/EOF → `APPROVAL_DECLINED`
  (nothing written) → `mintRunApprovalRecord` → `writeFileExclusive(out)` (`EEXIST` →
  `APPROVAL_OUT_EXISTS`) → output `{ approvalId, manifestHash, expiresAt, path }`. There is no
  flag, env var, or non-TTY path that skips the prompt; defaults bind to `process.stdin` / the
  controlling terminal `/dev/tty`.
- [x] Step 10: Wire the dispatcher in `backend/src/cli/index.ts` `case 'run'`: peek `rest[0]`;
  `'manifest'` → `await import('./run-manifest-command')` → `writeSuccess(await
  runRunManifest(rest.slice(1)))`; `'approve'` → `await import('./run-approval-command')` →
  `writeSuccess(await runRunApprove(rest.slice(1)))`; otherwise unchanged `runRunCommand(rest)`.
  Update the header docstring verb list.

### E. Verifier and consumption (AGX-R4, AGX-R5, AGX-R6)
- [x] Step 11: Create `backend/src/cli/run-approval-verifier.ts` exporting
  `type VerifiedApproval = { approvalId, manifestHash, manifest, expiresAt, approvalPath }` and
  `verifyRunApproval({ approvalPath, expectedManifest, engineVersion, clock })`: read file
  (`ENOENT`/absent path → `APPROVAL_MISSING`) → `parseRunApprovalRecord` (`APPROVAL_INVALID`) →
  `record.engineVersion !== engineVersion` → `APPROVAL_ENGINE_MISMATCH` (checked before hash so
  the distinct code is reachable) → `record.manifestHash !== computeManifestHash(expectedManifest)`
  → `APPROVAL_HASH_MISMATCH` (details: both hashes) → `clock() >= expiresAt` →
  `APPROVAL_EXPIRED` → consumption marker already present → `APPROVAL_CONSUMED` (pre-check;
  authoritative check is step 12).
- [x] Step 12: In the same module export `consumeRunApproval(verified, { clock })`: marker path =
  `approvalMarkerPath(approvalId)` = `<stateDir>/consumed/<approvalId>` (keyed by id, not by the
  approval file's path, so a copied file cannot replay — AGX-R5); `writeFileExclusive` of
  `{ approvalId, manifestHash, consumedAt }`; `EEXIST` → `APPROVAL_CONSUMED`. Doc comment: callers
  must call this **after** all refusals and **before** any spawn; consumption is final regardless
  of outcome (incl. cancel); `approvalId` from `VerifiedApproval` is what shells 02–04 put into
  `run.start`, the spend ledger and the terminal outcome.

### F. Tests
- [x] Step 13: `tests/cli/run-manifest.test.ts` — `buildRunManifest` twice on the same inputs →
  byte-identical `canonicalJson` and identical `manifestHash`; tool-list order does not change the
  hash; each field change changes the hash; bound violations (`totalUsd > 20`, `perActionUsd >
  totalUsd`, `expiresInMinutes > 60`, allowed∩disallowed) → `MANIFEST_INVALID`;
  `permissionMode` is always `'acceptEdits'`. CLI: `main(['run','manifest', <req>, …flags,
  '--json'])` exit 0, one JSON line, empty stderr; missing `--profile` → exit 2 `USAGE_ERROR`;
  `main(['run', <req>, '--executor','stub'])` behaviour unchanged (existing `run-verb` tests keep
  passing).
- [x] Step 14: `tests/cli/run-approval.test.ts` — ceremony via fake `ApprovalTerminal`
  (PassThrough streams with `isTTY` set): correct challenge → record written, mode `0o600`,
  schema valid, `expiresAt - createdAt` = 60 min default / shorter when requested; wrong
  challenge and EOF → `APPROVAL_DECLINED`, no file; `stdin.isTTY` false, `stderr.isTTY` false →
  `APPROVAL_TTY_REQUIRED`, no file; pre-existing `--out` → `APPROVAL_OUT_EXISTS`, original bytes
  untouched. Negative mint paths: no argv flag (e.g. `--yes`, `--challenge`) is accepted
  (`USAGE_ERROR`); env vars (`GOAL_GEN_APPROVE=1` etc.) have no effect; subprocess test with piped
  stdin (`spawnSync(process.execPath, [tsx, cli, 'run','approve', …], { input: '<challenge>\n' })`)
  → exit 1 `APPROVAL_TTY_REQUIRED`, no file.
- [x] Step 15: `tests/cli/run-approval-verifier.test.ts` — one test per refusal code
  (`MISSING`, `INVALID` for bad JSON / schema / tampered hash / lengthened `expiresAt`,
  `ENGINE_MISMATCH`, `HASH_MISMATCH`, `EXPIRED` via injected `clock`, `CONSUMED`), happy path
  returns `VerifiedApproval` with the record's `approvalId`; `consumeRunApproval` second call →
  `APPROVAL_CONSUMED`; concurrency: 16 × `Promise.all(verify → consume)` on one approval → exactly
  one fulfilled, 15 rejected with `APPROVAL_CONSUMED`, marker mode `0o600`.
- [x] Step 16: Zero-spawn proof — in `tests/cli/run-manifest.test.ts` (or a dedicated
  `run-approval-spawn.test.ts`) put a sentinel fake `claude` on `PATH` (pattern from
  `acceptance-evidence.test.ts:501-540`) and run `run manifest` and a refused `run approve` as
  subprocesses → stamp file absent (zero invocations).
- [x] Step 17: `tests/cli/run-approval-isolation.test.ts` modelled on
  `acceptance-record-isolation.test.ts`: source grep of `run-manifest.ts`,
  `run-manifest-command.ts`, `run-approval.ts`, `run-approval-command.ts`,
  `run-approval-verifier.ts` forbids `node:child_process`, `spawn`/`exec*`, `./run-command`, and
  the string `bypassPermissions`; `vi.doMock` the forbidden modules (`run-command`,
  `provider-run-v1`, `executors/claude-code-executor`, `extractors/llm-extractor`,
  `orchestrator/orchestrator`) to throw, then `main(['run','manifest', …])` still exits 0; and
  `version`/`capabilities` never load the new modules.

### G. Docs for the verbs
- [x] Step 18: Add a `run manifest` / `run approve` bullet to the Commands section of `CLAUDE.md`
  (and its mirror `AGENTS.md:15-18`): zero-spend, TTY-only mint, not a Protocol v1 capability,
  never from CI or an autonomous session; link ADR-0020 and the runbook.

## Verification
- `npm run typecheck` (from `goal-gen/`) -> expected: exit 0.
- `npm test -- tests/cli/run-manifest.test.ts tests/cli/run-approval.test.ts tests/cli/run-approval-verifier.test.ts tests/cli/run-approval-isolation.test.ts` -> expected: all pass, fake `claude` stamp never written.
- `npm test` -> expected: full suite green; existing `run-verb`, `dispatch`, `capabilities-isolation`, protocol golden tests unchanged.
- `npm run eval` and `bash scripts/install-smoke.sh` -> expected: pass; `capabilities.operations` unchanged.
- `npm run test:operator-recipe` -> expected: pass (existing runbook untouched).
- `npm run cli -- run manifest <request.json> --profile config-repair --per-action-usd 1 --total-usd 5 --auth-mode subscription --allowed-tool Edit --json` run twice -> expected: identical output bytes.
- `echo x | npm run cli -- run approve <same flags> --out /tmp/…/a.json` -> expected: exit 1, `APPROVAL_TTY_REQUIRED`, no file created. (Interactive approval is a manual human check only.)
- `rg -n bypassPermissions backend/src/cli/run-manifest*.ts backend/src/cli/run-approval*.ts` -> expected: no matches.

## Context Files
- `plans/specs/approval-gated-real-execution.md` — AGX-R1..R6 text, key flow 1–2 ordering, decisions.
- `backend/src/cli/index.ts` — dispatcher `case 'run'`, `main()` error mapping.
- `backend/src/cli/errors.ts` — error-class shape to mirror.
- `backend/src/cli/protocol-run-options.ts` — `parseRunInvocation` (why `run manifest` must be intercepted upstream).
- `backend/src/cli/candidate-offline-profiles.ts` — `getCandidateOfflineProfile`, `candidateProfileDigest` (Consumes: profile + digest).
- `backend/src/cli/provider-capabilities.ts` — `ProviderProtocolVersion`, capabilities operations list (Consumes: protocol v1 contract; must stay unchanged).
- `backend/src/run/request-to-run.ts` — `loadRunRequest` (Consumes: request validation contract).
- `backend/src/cli/artifact-version.ts` — `readArtifactVersion` (engine version).
- `backend/src/packs/canonical-json.ts`, `backend/src/packets/checksums.ts` — hashing helpers.
- `backend/src/orchestrator/guardrails.ts` — ADR-0010 cap constants.
- `backend/src/cli/committed-source-bundle.ts:515-531` — exclusive-create flag precedent.
- `backend/src/cli/acceptance-evidence.ts` — zod strict schema + `fail()` pattern.
- `backend/src/orchestrator/orchestrator.ts` (~1215 `stdinConfirm`) — readline prompt shape on stderr.
- `tests/cli/dispatch.test.ts`, `tests/cli/acceptance-record-isolation.test.ts`, `tests/cli/acceptance-evidence.test.ts:501-540` — test patterns.
- `docs/decisions/_template.md`, `docs/decisions/README.md` — ADR format + index (Consumes).
- `plans/specs/verified-single-milestone-execution.md:14-22` — VS layer table (Consumes).
- `docs/operator-committed-source.md`, `scripts/operator-committed-source-paths.sh` — runbook precedent; script pins only that file.
