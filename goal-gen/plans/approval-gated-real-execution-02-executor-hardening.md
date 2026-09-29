# Feature: Executor hardening and permission probe

## Overview

The existing `ClaudeCodeExecutor` builds `claude -p` argv without budget or tool-allowlist flags,
hardcodes the `claude` command, and passes the full parent environment (so `ANTHROPIC_API_KEY`
silently switches billing). The `config-repair` profile has no worker prompt. This slice adds
those controls, a new profile version carrying milestone text, and a fake worker so CI never
spends. It ends with the human-run permission probe, which decides whether `acceptEdits` plus an
allowlist is viable before orchestration (shell 03) is built on it.

Out of scope here (owned by shell 03 `real-run-orchestration`): manifest → approval → consume
ordering, the `run --executor agx-claude-code` verb, process-group kill (AGX-R14), spend ledger
(AGX-R16), candidate extraction, bundle/ledger destinations (AGX-R8a), and selecting `config-repair`
v2 from `run manifest`. This slice produces the building blocks shell 03 wires together.

## Origin

- Spec: `plans/specs/approval-gated-real-execution.md` (cite as AGX-R<n> outside the spec)
- Covers: AGX-R7, AGX-R11, AGX-R12, AGX-R13, AGX-R15, AGX-R32, AGX-R34
  - AGX-R12 partial: flag, cap validation, cost recording and the `cost-unmetered` class; the
    "rejected before the approval is consumed" ordering is shell 03.
  - AGX-R13 partial: the two-way guard function and executor-level enforcement; placing it
    before consumption in the run sequence is shell 03.
  - AGX-R15: the harness in this slice drives the real-run *executor* with the fake worker; shell 03
    extends the same harness to the full real-run command.
- Shell: approval-gated-real-execution-02-executor-hardening (depends_on: none)
- Expansion decisions (operator, 2026-09-29):
  - **Spec drift:** the spec gained AGX-R8a after decomposition; it belongs to shell 03, so this
    shell proceeds unchanged.
  - **Open questions deferred to the probe:** per-action cap, action/run timeouts inside the $5
    envelope, and whether the worker needs an engine-owned `--settings` are *outputs* of the Step 15
    probe. Code keeps caps as validated values (never hardcoded probe numbers). As shipped there is
    no `--settings` option: the worker config is pinned with `--setting-sources project
    --strict-mcp-config` (operator decision after review), and any engine settings shell 03 needs
    must come through the approved manifest.
  - **Filesystem confinement mechanism (AGX-R11): path-scoped permission rules**, not an OS
    sandbox. The CI negative fixture proves the engine refuses every unconfined allowlist before
    spawn (zero fake-worker invocations). Proof that Claude Code *enforces* the scoped rules headless
    (an out-of-worktree read/write is denied) comes from the human-run probe, because a fake worker
    cannot demonstrate CLI enforcement. If the probe shows an escape, stop and redesign toward a
    sandbox; never widen to `bypassPermissions`.

## Pattern Survey

- **Profiles.** `backend/src/cli/candidate-offline-profiles.ts`:
  - `configRepairProfile()` (:40) builds v1 (`version: '1'`, `allowedPaths: ['site.json','SITE']`,
    checks `schema-host` and `site-bind`).
  - `getCandidateOfflineProfile(id)` (:77) looks up by id only.
  - `candidateProfileDigest` (:147) hashes a literal-key-ordered object, and the key order is
    load-bearing (`docs/solutions/code-quality/adding-a-non-protocol-cli-verb-to-goal-gen.md:56`).
    A new `milestoneText` key must be emitted only when present, or v1's digest changes.
- **Profile callers by id.**
  - `candidate-offline-command.ts:261`: verify.
  - `candidate-offline-command.ts:292`: reproduce, which uses `stored.profile.id` and ignores
    `stored.profile.version`.
  - `candidate-offline-command.ts:38`: `knownProfiles()`.
  - `run-manifest.ts:132` `resolveProfile`.
  - `candidate-offline-bundle.ts:68` stores `{id, version, digest}`.
  - The committed-source registry (`committed-source-profiles.ts`) is separate and untouched.
- **Reproduce tests.** `tests/cli/candidate-offline.test.ts:226` (CO-05/06), `:326` (digest
  coverage), `:357` (CO-07 mismatch). There are no golden bundles, because bundles are made in
  tmpdirs. That is why this plan adds a pinned v1 digest constant.
- **Executor.** `backend/src/executors/claude-code-executor.ts`:
  - `spawnClaude` (:97) with a hardcoded `spawn('claude', …, { env: GIT_ENV })` (:109).
  - `SIGKILL_GRACE_MS`/`DEFAULT_MAX_TURNS` (:29-30).
  - `ResultEnvelope` zod `.passthrough()` (:65-84). It lacks `permission_denials`,
    `terminal_reason` and `stop_reason`.
  - `parseEnvelope` (:174), and `classify` (:219), which collapses all failures to `failed`.
  - `ClaudeCodeExecutorOptions` (:298).
  - Permission narrowing via `ACTION_REQUESTABLE_MODES`/`MODE_RANK` (:43-57, ~:365-386).
  - Argv is built inline in `run()` (~:388).
  - `costUsd = envelope.total_cost_usd ?? 0` (~:427), so missing cost is silently 0.
- **Environment.** `backend/src/executors/worktree.ts:21`: `GIT_ENV` spreads `process.env` and is
  shared by `git()` and the claude spawn. `createWorktree({seedFiles})` (:85-129) seeds a tmpdir
  scratch repo.
- **Legacy path.** `cli/run-command.ts:88` and `runner.ts:217` hardcode `bypassPermissions`. That
  code is untouched here (retiring it is a post-AGX-R35 follow-up), but the new real-run modules
  must not share a resolution path with it.
- **Manifest.** `backend/src/cli/run-manifest.ts`:
  - `RunManifestSchema` (:38) already carries `allowedTools`/`disallowedTools`, `maxTurns`,
    `caps{perActionUsd,totalUsd}`, `actionTimeoutMs`, `runWallClockMs`,
    `authMode: 'subscription'|'api-key'`, and `permissionMode: z.literal('acceptEdits')`.
  - Its `superRefine` enforces `perAction ≤ total ≤ MAX_BUDGET_USD`.
  - `TOOL_RULE` (:31) allows a tool with an optional specifier but does not require path scoping.
- **Isolation.** `tests/cli/run-approval-isolation.test.ts` forbids the five approval modules from
  importing `executors/`, `child_process` or `bypassPermissions`. The manifest → executor-options
  mapping therefore lives in `executors/`, never in `cli/run-approval*.ts`/`run-manifest.ts`.
- **Error codes.** `backend/src/cli/errors.ts:57`: `RUN_APPROVAL_ERROR_CODES` `as const` tuple,
  `RunApprovalError(code, message, details?)` (:74). Its header points at the ADR-0020 runbook
  refusal table (`docs/operator-real-run.md` § Refusal codes).
- **Guardrails.** `backend/src/orchestrator/guardrails.ts`: `MAX_BUDGET_USD = 20`,
  `ACTION_TIMEOUT_MS`, `RUN_WALL_CLOCK_MS`, `DEFAULT_MODEL`.
- **Executor tests.** `tests/executors/claude-code-executor.permission.test.ts` mocks
  `node:child_process` (`vi.hoisted` + `vi.mock`, `fakeClaudeChild()`). There is no on-disk fake
  `claude` yet.
- **Child-process test pattern.** `tests/cli/observed-fixture-child.test.ts:57-80`:
  a `.mjs` script run as `[process.execPath, script]`.
- **Static-test precedent.** `tests/cli/run-approval-isolation.test.ts:46-99`: `readFileSync`
  source assertions plus `vi.doMock` forbidden modules. Siblings are
  `capabilities-isolation.test.ts` and `observed-fixture-isolation.test.ts`. No import-graph walker
  exists yet.
- **Packaging.** `package.json` `files` is `[bin/, backend/src/, packs/, policies/, schemas/]` with
  no `.npmignore`, so anything under `tests/` is already out of the tarball and anything under
  `backend/src/` ships. `bin/goal-gen.mjs` `tsImport`s `backend/src/cli/index.ts`.
  `scripts/install-smoke.sh` packs, installs and drives the bin.
- **Spike evidence.** `tests/spikes/executor-spike-findings.md` §2 recorded only the success
  envelope:
  - The fields are `type, subtype, is_error, num_turns, total_cost_usd, usage, modelUsage,
    permission_denials, terminal_reason, stop_reason, session_id`.
  - Budget, max-turns, error and permission-denial shapes were never observed. The fake-worker
    variants for those are synthesized from the success shape, flagged as synthetic until the
    probe records real ones.
- **Path helpers.**
  - `backend/src/paths/output-containment.ts` for realpath canonicalisation.
  - `assertSafeCandidatePath` (`candidate-offline-command.ts:88`) and
    `worktree.ts:121`, which reject `.`/`..`/absolute segments.
  - There is no `Tool(specifier)` parser yet.
- **CLI flags.** Confirmed in the local `claude --help` (2026-09-29): `--allowedTools`,
  `--disallowedTools`, `--max-budget-usd <amount>`, `--settings <file-or-json>`,
  `--setting-sources`, `--strict-mcp-config`, `--add-dir`, `--permission-mode`.
- **Doc conventions.**
  - Runbooks are `docs/operator-*.md` (shape: header, `## Prerequisites`, numbered steps,
    `## Refusal codes`).
  - The human-run spike pair is `tests/spikes/<name>.ts` plus `<name>-findings.md`, which is
    outside the `tests/**/*.test.ts` glob, so CI never runs it.
- **Constitution** (`CLAUDE.md`):
  - Tests use the stub or fake only.
  - Tests are never edited to make them pass.
  - Update the spec before changing behaviour.
  - ADRs are immutable.
  - Each CLI verb or flag is documented in the `CLAUDE.md` Commands section.

## Implementation

### A. Profile version (AGX-R7)

- [x] Step 1: Pin v1 before touching anything.
  - Add `tests/cli/candidate-offline-profile-versions.test.ts`, asserting that
    `candidateProfileDigest(getCandidateOfflineProfile('config-repair', '1'))` equals a hardcoded
    `CONFIG_REPAIR_V1_DIGEST` hex constant.
  - Capture the constant from current `main` *before* Step 2, via
    `npm run cli -- acceptance verify-candidate …` or a one-off `tsx` print.
  - Also add a regression test that builds a v1 bundle with today's code path (`runCandidateOfflineVerify`
    with the v1 profile) and asserts it still `reproduce`s `accepted: true` after the change.
- [x] Step 2: In `backend/src/cli/candidate-offline-profiles.ts`:
  - Add optional `milestoneText?: string` to `CandidateOfflineProfile`.
  - Add `configRepairProfileV2()`: v1 plus `version: '2'` plus `milestoneText`. The base files,
    allowed paths and checks are the same.
  - Author the milestone text from the `schema-host`/`site-bind` check definitions: it tells the
    worker to repair `site.json` and `SITE` only, and names no path outside `allowedPaths`.
  - In `candidateProfileDigest`, append `milestoneText` after `checkers` only when it is defined,
    so the v1 serialisation is byte-identical.
- [x] Step 3: Make the registry version-keyed.
  - `getCandidateOfflineProfile(id, version = '1')` resolves the id, then the version, and throws
    `unknown candidate-offline profile version: <id>@<version>` on a miss.
  - `listCandidateOfflineProfiles()` returns both versions.
  - `knownProfiles()` (`candidate-offline-command.ts:38`) lists `id@version`.
  - The v1 default keeps every existing caller, including `run-manifest.ts:132` `resolveProfile`,
    byte-identical. Shell 03 selects v2 for real runs.
- [x] Step 4: `runCandidateOfflineReproduce` (`candidate-offline-command.ts:292`) looks up
  `getCandidateOfflineProfile(stored.profile.id, stored.profile.version)`, so a v1 bundle never
  becomes `profile-digest-mismatch`.
- [x] Step 5: `runCandidateOfflineVerify` gets `--profile-version <v>` in `parseVerifyArgv` (:157),
  default `'1'`.
  - Add the flag to the usage text and the `CLAUDE.md` Commands section. Follow the checklist in
    `docs/solutions/code-quality/adding-a-non-protocol-cli-verb-to-goal-gen.md`.
  - Tests:
    - v2 verify records `version: '2'` and the v2 digest.
    - Changing `milestoneText` changes the v2 digest.
    - The v1 digest equals `CONFIG_REPAIR_V1_DIGEST`.
    - An unknown version is a usage error.
    - Existing `tests/cli/candidate-offline.test.ts` passes unedited.

### B. Real-run executor options (AGX-R11, R12, R13, R15)

- [x] Step 6: Add error codes to `RUN_APPROVAL_ERROR_CODES` (`backend/src/cli/errors.ts:57`), and add
  rows for both to the refusal table in `docs/operator-real-run.md`:
  - `AUTH_MODE_MISMATCH`;
  - `TOOLS_UNCONFINED`, the filesystem-confinement refusal (AGX-R11).
- [x] Step 7: Create `backend/src/executors/real-run-guards.ts`. It must not import from
  `cli/run-approval*.ts`, so the isolation test holds.
  - `assertAuthModeMatchesEnv(authMode: 'subscription' | 'api-key', env: NodeJS.ProcessEnv): void`
    throws `RunApprovalError('AUTH_MODE_MISMATCH', …)` in both directions:
    - a non-empty `ANTHROPIC_API_KEY` present while `authMode !== 'api-key'`;
    - `ANTHROPIC_API_KEY` absent or empty while `authMode === 'api-key'`.

    Details name the direction but never echo the key value.
  - `assertFilesystemToolsConfined(allowedTools: readonly string[]): void` throws
    `TOOLS_UNCONFINED` unless every entry matches
    `^(Read|Edit|Write|MultiEdit|Glob|Grep)\((<spec>)\)$` and every `<spec>` is a relative
    in-worktree pattern. The specifier rejects:
    - a leading `/` (settings-relative in Claude Code), `//` or `~`;
    - any `..` segment;
    - a backslash, a drive letter or `$`;
    - empty specifiers.

    Accept `./x`, `x` and glob forms such as `./**`. Unscoped tools such as `Edit` and every
    non-filesystem tool, including `Bash(...)`, are refused. The details list each offending entry.
  - `resolveRealRunPermissionMode(requested: unknown): 'acceptEdits'` returns `'acceptEdits'` only
    for exactly `'acceptEdits'`, and throws for anything else. Its return type admits no other mode.
    Keep this file free of the string of the bypass mode, because Step 10's static test asserts that.
- [x] Step 8: Extend `ClaudeCodeExecutor` (`backend/src/executors/claude-code-executor.ts`). Legacy
  behaviour must stay unchanged when the new options are absent.
  - `workerCommand?: { file: string; args: readonly string[] }` is a constructor-only option,
    default `{ file: 'claude', args: [] }`.
    - Thread it through `spawnClaude` as `spawn(file, [...args, ...argv])`.
    - It is never read from env or argv.
    - Tests never use `PATH` shims.
  - `realRun?: RealRunExecutorConfig` carries `{ allowedTools, disallowedTools, maxBudgetUsd,
    authMode }` (a `settings` field was planned and removed in review). When present:
    - Construction calls `resolveRealRunPermissionMode(opts.permissionMode ?? 'acceptEdits')`, and
      throws if `realRun` is combined with any other mode.
    - Construction also calls `assertFilesystemToolsConfined(allowedTools)`, and validates
      `0 < maxBudgetUsd ≤ MAX_BUDGET_USD` and `maxTurns ≥ 1`.
    - `run()` calls `assertAuthModeMatchesEnv(authMode, process.env)` before any spawn. A
      mismatch returns a `failed` `AgentRun` with `failureClass: 'auth-mode-mismatch'` and zero
      spawns (defense in depth; shell 03 also calls the guard before consuming).
    - Argv appends `--allowedTools <each>`, `--disallowedTools <each>` and
      `--max-budget-usd <maxBudgetUsd>` (see "Review hardening" below for what shipped on top).
    - Build the worker child env with a new `workerEnv()`, fresh at spawn from `process.env` plus
      the `/dev/null` git config pins (`GIT_ENV` is a module-load snapshot). The auth guard checks
      that exact object.
- [x] Step 9: Distinct failure classes and cost metering.
  - Add optional `permission_denials` and `terminal_reason` to the `ResultEnvelope` zod schema.
  - Add `failureClass?: 'error-result' | 'budget' | 'max-turns' | 'permission-denied' |
    'malformed-output' | 'cost-unmetered' | 'timeout' | 'cancel' | 'spawn-error' |
    'auth-mode-mismatch'` to `AgentRun` (`backend/src/types.ts:41`). It is optional, so existing
    consumers and goldens are untouched. Check `tests/contracts/compat.test.ts` in case `AgentRun`
    is schema-vendored.
  - Add a `classifyFailure(envelope)` helper. Map `subtype` `error_max_turns` to
    `max-turns`, and a budget subtype or terminal reason to `budget`. The exact string is recorded
    by the probe, so match defensively on `/budget/i` and never let it pass as success. A non-empty
    `permission_denials` maps to `permission-denied`, and other `is_error` results to
    `error-result`.
  - In real-run mode only, an otherwise-successful envelope with no numeric `total_cost_usd` becomes
    `status: 'failed'`, `failureClass: 'cost-unmetered'`, with `costUsd` left undefined rather than
    0. The legacy `?? 0` stays for non-real-run callers.
- [x] Step 10: Add `backend/src/executors/real-run-executor.ts`, exporting
  `createRealRunExecutor(manifest: RunManifest, opts?: { workerCommand? })`.
  - It maps `manifest.model`, `maxTurns`, `actionTimeoutMs`, `allowedTools`, `disallowedTools`,
    `caps.perActionUsd`, `authMode` and `permissionMode` into `ClaudeCodeExecutorOptions`.
  - It is the only real-run construction site shell 03 will use.
  - Tests in `tests/executors/real-run-executor.test.ts` use the existing `vi.mock('node:child_process')`
    pattern:
    - The argv carries `--permission-mode acceptEdits`, one `--allowedTools` per rule,
      `--max-budget-usd <perActionUsd>` and the injected command.
    - Both `AUTH_MODE_MISMATCH` directions produce zero spawns.
    - Every unconfined allowlist throws `TOOLS_UNCONFINED` at construction with zero spawns: `Edit`,
      `Bash(ls)`, `Read(//etc/**)`, `Edit(../x)`, `Read(~/.ssh/**)`, `Write(/site.json)` and
      `Edit(C:\x)`. This is the AGX-R11 negative fixture.
    - Exhaustive permission test: for every value in `['acceptEdits', 'plan', 'auto', 'dontAsk',
      'manual', 'bypassPermissions', '', undefined, 42]`, either construction throws or the spawned
      argv's `--permission-mode` is `acceptEdits`.
  - Static regression test `tests/executors/real-run-bypass-static.test.ts`, following the
    `run-approval-isolation.test.ts` pattern:
    - `readFileSync` `real-run-executor.ts` and `real-run-guards.ts`, and assert that neither
      contains `bypassPermissions`.
    - Assert that neither imports `cli/run-command` or `runner`.

### C. Fake worker and test-only harness (AGX-R15, R32)

- [x] Step 11: Add the fake worker at `tests/fixtures/claude-worker/`.
  - `fake-claude.mjs` is plain Node run as `[process.execPath, fake-claude.mjs, --scenario <name>,
    --record <file>]`, then the real claude argv.
    - It appends its full argv, cwd, and the presence (never the value) of `ANTHROPIC_API_KEY` as
      one JSON line to `--record`.
    - It prints the scenario's envelope to stdout and exits with the scenario's code.
    - For `success` it also writes the v2 fixed candidate (`site.json`/`SITE` repaired) into cwd, so
      shell 03 can verify end to end.
  - `envelopes/<scenario>.json` covers `success`, `error-result`, `budget-stop`, `max-turns`,
    `permission-denial`, `malformed-output` (non-JSON stdout) and `missing-cost` (success without
    `total_cost_usd`). Review added two hostile/edge scenarios reusing the success envelope:
    `gitfile-rewrite` (plants a `.git` gitfile pointing at a repo with `core.fsmonitor`) and
    `noise-only` (touches only a tracked noise file). The record line also carries the prompt read
    from stdin.
    - `success` is derived verbatim from the spike findings §2.
    - The other scenarios carry `"_synthetic": true` until the probe records real shapes.
  - `tests/executors/fake-worker.test.ts` runs the real `ClaudeCodeExecutor` (no `child_process`
    mock) with `workerCommand` set to the fake, over each scenario against a
    `createWorktree({ seedFiles })` worktree seeded with v2 base files. It asserts:
    - exactly one recorded invocation;
    - the expected `status`/`failureClass`;
    - that `costUsd` is recorded for metered scenarios and undefined for `missing-cost`.
- [x] Step 12: Add the test-only harness `tests/harness/real-run-harness.ts`. It lives under
  `tests/`, so it is outside `package.json` `files` and not in the tarball.
  - It is a tsx entry that takes `--manifest <file> --scenario <name> --record <file>`.
  - It builds `createRealRunExecutor(manifest, { workerCommand: fakeWorker(scenario, record) })`,
    seeds a `config-repair` v2 worktree, runs one action, and prints the `AgentRun` summary as JSON.
  - It exits 0 for success and 1 for a worker failure.
  - Shell 03 extends it to the full real-run command.
  - Add a process-level test `tests/harness/real-run-harness.test.ts` that spawns it via
    `process.execPath` plus the tsx loader for the `success` and `missing-cost` scenarios.
- [x] Step 13: Add the static packaging test `tests/harness/harness-isolation.test.ts`.
  - Walk the static import graph from `bin/goal-gen.mjs` (following its `tsImport` into
    `backend/src/cli/index.ts`), using a regex over `from`, `import()`, `require()` and `tsImport()`
    specifiers. Assert that no reached module is under `tests/`. As shipped the test also asserts
    that only `claude-code-executor.ts` and `real-run-executor.ts` name `workerCommand`.
  - Assert that no file under `backend/src/` imports a path containing `tests/`.
  - Assert that `package.json` `files` covers neither `tests/harness/` nor `tests/fixtures/`.

### Review hardening (as shipped)

Four review passes (see PR #60) changed the real-run executor beyond Steps 7–13. These are the
contract shell 03 builds on:

- **Worker tools and config.** Argv adds `--tools <approved tool names>` (allow rules only add
  approvals; read-only Bash commands are auto-approved otherwise), `--setting-sources project
  --strict-mcp-config`, and engine deny rules after the approved ones: `Bash`, `WebFetch`,
  `WebSearch`, and writes to `.git`, `.claude`, `.mcp.json` and `CLAUDE.local.md` at the root and
  at any depth (`REAL_RUN_CONTROL_NAMES` in `real-run-guards.ts` is the single source).
- **Prompt on stdin**, never argv, so no prompt text is parsed as a flag or subcommand.
- **Allowlist check** (`assertFilesystemToolsConfined`): specifiers must match a strict
  `./`-relative character set; write rules may not name a control path (case-insensitive) or a
  dotfile wildcard.
- **Auth guard** also refuses `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the `CLAUDE_CODE_USE_*` toggles.
- **Pre-spawn worktree preflight**: refuse pre-existing worker config (lstat, so dangling symlinks
  count) and a git dir inside the worktree; every refusal is `failureClass: 'worktree-refused'`,
  an action-requested mode is `'mode-rejected'`, and no-spawn real runs leave `costUsd` unset.
- **Pinned git everywhere**: `createWorktree` records `gitDir` before any agent runs, the
  orchestrator passes it as `RunContext.gitDir`, and every engine git call in an agent-written
  worktree (both executor paths' activity oracle, and `captureDiff`) runs through `pinnedGit`
  with `core.fsmonitor` and hooks off. A planted-gitfile `fsmonitor` previously executed.
- **Envelope**: `total_cost_usd` must be finite and non-negative; a real-run success with
  `permission_denials` fails as `permission-denied`.
- **Deferred to shell 03**: splitting a `RealRunExecutor` out of `ClaudeCodeExecutor`,
  process-group kill (AGX-R14), a worker env allowlist, recording the absolute `claude` path,
  whether in-worktree out-of-scope changes fail the run (AGX-R17), a shared test manifest fixture,
  and deriving the probe's flag list from the executor.

### D. Probe (AGX-R34): human-run exit gate

- [x] Step 14: Write the probe procedure, the probe script and the pre-probe docs.
  - Procedure `docs/operator-permission-probe.md`, in runbook shape, with a human-operator-only
    banner and no `bypassPermissions` anywhere. It lists the probe steps:
    1. `claude --help` shows every flag the executor emits.
    2. An edit run on `config-repair` v2 with sonnet, subscription auth, and scoped rules
       `Read(./**)`, `Edit(./site.json)`, `Edit(./SITE)`, `Write(./site.json)`, `Write(./SITE)`,
       with a suggested `--max-budget-usd 0.50`.
    3. The run edits the allowed paths headless, and the verifier (`acceptance verify-candidate
       config-repair --profile-version 2`) accepts.
    4. A negative run whose prompt asks the worker to read a host file outside the worktree (with
       the Read tool and with `cat`), write `../escape.txt` and an outside file, and write worker
       config (`./.claude/settings.json`, a nested `.claude/skills` file) ends with the probe's
       `verdict: "pass"`: nothing leaked or created, and the secret read shows up as denied.
    5. A `--max-turns 1` run records the real max-turns envelope, and a tiny budget run records the
       real budget-stop envelope if it can be triggered cheaply.
    6. Confirm the pinned setting sources leave no hook or plugin side effects in the worktree, and
       decide whether shell 03 needs an engine-owned `--settings` (through the manifest).
    7. Record the measured cost, turns and duration.

    The suggested total probe spend is ≤ $3, and the operator may lower it. Failure rule: widen
    the allowlist once. A second failure, or any confinement escape, means stop and redesign.
    Never fall back to `bypassPermissions`.
  - Probe script `tests/spikes/permission-probe.ts`, modelled on `executor-spike.ts`. It is outside
    the `*.test.ts` glob, and its header says "HUMAN-RUN ONLY — real spend". It uses
    `createRealRunExecutor` with the real `claude` (no `workerCommand`), so the probe exercises the
    exact production argv.
  - Result template `tests/spikes/permission-probe-findings.md` has these sections: Flags, Edit run,
    Confinement (negative), Envelopes (budget / max-turns / permission-denial), Side effects, Cost
    and timing, and **Decisions for shell 03**. The decisions cover the per-action cap, action
    timeout, run wall-clock, whether an engine-owned `--settings` is needed, whether in-worktree
    out-of-scope changes should fail the run, and whether the allowlist was widened.
  - Update `docs/operator-real-run.md` so the Prerequisites point at the probe and the § 1 example
    uses scoped rules (`--allowed-tool 'Edit(./site.json)'` …). Unscoped `Edit` is now refused.
  - Record the path-scoped-rules decision for AGX-R11 in the spec's `### Decisions` subsection
    (Design section) of `plans/specs/approval-gated-real-execution.md`.
- [ ] Step 15: **HUMAN-RUN — an autonomous `/flow:work` session must stop before this step.**
  - The operator runs the probe per `docs/operator-permission-probe.md`, fills in
    `tests/spikes/permission-probe-findings.md`, and commits the findings in a docs PR.
  - On success, replace the `_synthetic` fake-worker envelopes with the recorded real shapes where
    they were captured, and tighten the `/budget/i` match to the recorded string.
  - Shell 03 must not be expanded until this findings file records a passing result.

## Verification

- `npm run typecheck` → exit 0.
- `npx vitest run tests/cli/candidate-offline-profile-versions.test.ts tests/cli/candidate-offline.test.ts`
  → the pinned v1 digest matches, the pre-change v1 bundle reproduces `accepted: true`, and the v2
  digest moves with `milestoneText`.
- `npx vitest run tests/executors` → the permission exhaustive test, the static bypass test, both
  auth-mismatch directions, every `TOOLS_UNCONFINED` case, and all nine fake-worker scenarios pass,
  each with ≤ 1 recorded invocation and zero for refusals.
- `npx vitest run tests/harness` → the harness process test passes, and the import-graph test
  shows the bin never reaches `tests/`.
- `npx vitest run tests/cli/run-approval-isolation.test.ts tests/executors/claude-code-executor.permission.test.ts`
  → unedited and passing, so legacy executor behaviour is unchanged.
- `npm test && npm run eval` → full suite green.
- `bash scripts/install-smoke.sh` → green, and `npm pack --dry-run` lists no `tests/` paths.
- No step in CI or in `/flow:work` invokes a real `claude`. Only Step 15, run by the human
  operator, spends.

## Context Files

- `plans/specs/approval-gated-real-execution.md`: AGX-R7, R11–R13, R15, R32 and R34 text and design
  decisions.
- `docs/decisions/0020-approval-gated-real-execution.md`, `0015-…failclosed-permissions.md` and
  `0010-guardrail-defaults.md`: the governing ADRs (immutable).
- `backend/src/executors/claude-code-executor.ts`: the executor being extended.
- `backend/src/executors/worktree.ts`: `GIT_ENV` and `createWorktree({seedFiles})`.
- `backend/src/cli/candidate-offline-profiles.ts`: the profile, registry and digest.
- `backend/src/cli/candidate-offline-command.ts`: verify/reproduce lookups (:157, :261, :292).
- `backend/src/cli/run-manifest.ts`: manifest fields feeding `createRealRunExecutor`.
- `backend/src/cli/errors.ts`: `RUN_APPROVAL_ERROR_CODES`.
- `backend/src/orchestrator/guardrails.ts`: `MAX_BUDGET_USD` and the timeouts.
- `backend/src/types.ts`: `AgentRun` (adds `failureClass`).
- `tests/executors/claude-code-executor.permission.test.ts`: the mock-spawn pattern.
- `tests/cli/run-approval-isolation.test.ts`: the static-test pattern and the isolation constraint.
- `tests/cli/candidate-offline.test.ts`: the reproduce tests that must stay unedited.
- `tests/spikes/executor-spike.ts` and `executor-spike-findings.md`: envelope shapes and the probe
  precedent.
- `docs/operator-real-run.md`: the runbook refusal table and scoped-rule example.
- `docs/solutions/code-quality/adding-a-non-protocol-cli-verb-to-goal-gen.md`: the CLI flag checklist.
- `package.json`: `files` and `bin`, which control tarball contents.
