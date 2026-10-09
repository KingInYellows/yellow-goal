# Spec: Approval-gated real execution (Yellow Harness step 6)

Status: approved by the operator 2026-09-28; implementation in progress (approval foundation,
AGX-R1–R6). Date: 2026-09-28. Owner: Yellow Goal (engine) with Yellow Plugins (consumer).
Decision: [ADR-0020](../../docs/decisions/0020-approval-gated-real-execution.md)
(challenge derivation and `--state-dir` superseded by
[ADR-0021](../../docs/decisions/0021-fresh-approval-challenge-and-no-state-dir.md)).
Source brainstorm: `docs/brainstorms/2026-09-28-approval-gated-real-claude-execution-brainstorm.md`
(decisions D1–D10, confirmed by the operator 2026-09-28).

> **Requirement IDs.** Inside this spec requirements are bare `R1..Rn` so `/flow:decompose` can
> trace them. **Outside this spec, cite them as `AGX-R<n>`** (approval-gated execution) — never
> bare — so they cannot be confused with the M1 backend spec's unrecovered `R7–R35`
> (`m1-backend-api-persistence-controls.md`). IDs are stable: obsolete requirements are
> tombstoned, never renumbered.

> **Human-control constraint.** This spec authorizes design and zero-spend code only. Every
> spend-incurring step (the permission probe, R34; the live acceptance run, R35) is executed by a
> human operator, never by an autonomous session. `bypassPermissions` is not reachable from
> anything this spec adds.

## Overview

Steps 1–5 of the Yellow Harness program built a canonical request-to-run pipeline, released
engine tarballs, Provider Protocol v1 (stub-only by contract: PP-04, PP-10, A12) and a
process-boundary consumer in yellow-plugins. The verified-single-milestone (VS) spec then built
the *verification* half offline (layers 3–3e: `acceptance verify-candidate`, `reproduce`,
captured-base replay), designed so that a non-deterministic worker's candidate can be judged by
engine-owned trusted checks. What does not exist is the *execution* half: a real `claude -p`
worker whose spend is approved in advance by a human, bounded, metered, and whose output is
judged by that verifier instead of by its own narrative.

This spec defines VS **layer 4a**: one human-approved, budget-capped, single-attempt real worker
run in an engine-owned scratch worktree seeded from the `config-repair` profile, verified by the
existing candidate verifier, exposed through a new `provider-protocol/v2` (a superset of v1), and
consumed by a user-only command in yellow-plugins. It proves the approval → spend → verification
loop on a toy profile before any real repository is touched (captured-base 4b is only a scratch
seed from the capture bundle's profile id, pinned commit, and selected file bytes, refusing a dirty
or mixed owner worktree with no worker spawn and `targetRepositoryHonored` false; target-bound is
later still and needs its own safety review).

## Users

- **Operator** (single local admin, ADR-0011 trust model): approves manifests at a terminal,
  supervises the probe and the live run, makes the final accept call after reproduction.
- **Host session / consumer** (yellow-plugins, possibly model-driven): may display manifests and
  start an already-approved run; must never be able to mint or widen an approval.
- **CI**: proves everything with zero spend.

## Evidence and scope

Verified against yellow-goal `072882d` and yellow-plugins `c58af0b`:

| Fact | Evidence |
|---|---|
| `config-repair` v1: base `site.json`/`SITE`/`keep.txt`, allowed paths `site.json`,`SITE`, checks `schema-host`+`site-bind`, no prompt field | `backend/src/cli/candidate-offline-profiles.ts:16-71` |
| Profile digest hashes id, version, timeout, checks, paths, base files, limits, checker identities | `candidate-offline-profiles.ts:148-163`; `reproduce` fails `profile-digest-mismatch` |
| Executor argv has no budget/allowlist flags; command hardcoded `spawn('claude', …)`; child env spreads `process.env` | `executors/claude-code-executor.ts:109,387-398`; `executors/worktree.ts:21-25` |
| Permission narrowing to `{plan, acceptEdits}`, unknown modes fail without spawn (ADR-0015) | `claude-code-executor.ts:41-49,332-338,369-386` |
| Legacy real path hardcodes `bypassPermissions` | `cli/run-command.ts:88`, `runner.ts:217` |
| `createWorktree({seedFiles})` builds a scratch repo in tmpdir only | `executors/worktree.ts:85-129` |
| ADR-0010 defaults: `MAX_BUDGET_USD=20`, retries/replans/re-extractions > 0 | `orchestrator/guardrails.ts:10-29` |
| Protocol v1 id, capabilities, stub-only start payload; `--protocol v1` requires `--executor stub` | `cli/provider-capabilities.ts:13,31-60`; `provider-run-v1.ts:203-206`; `cli/protocol-run-options.ts:58-61` |
| Consumer pin `0.2.0`, argv always `--executor stub --protocol v1`, start validator rejects non-stub | yellow-plugins `plugins/yellow-goal/src/pin.ts:12-19`, `src/runtime.ts:647-661`, `src/provider-protocol.ts:645-672` |
| User-only command precedent (`disable-model-invocation: true`) | yellow-plugins `plugins/yellow-ci/commands/ci/runner-cleanup.md:9` |
| Headless cost/auth facts (~$0.08 floor, `total_cost_usd` authoritative, API key overrides subscription, only bypass proven headless) | `tests/spikes/executor-spike-findings.md` |

Out of scope: `target.repository` execution, multi-worker/M2
routing, DB persistence and crash-resume (RR15), HTTP/SSE, auto-merge/publish/deploy, retiring the
legacy `--executor claude-code` path (follow-up after R35). Captured-base (4b) is only the scratch
seed: profile id, pinned commit (`source.commit`), and selected file bytes (`source.overlay.files`),
refusing a dirty or mixed owner worktree before any worker spawn, with `targetRepositoryHonored`
false. It does not authorize target execution, retries, or a live spend run.

## Requirements

### Approval

- **R1.** When the operator requests a real-run manifest, the engine shall render it offline with
  zero spend and without spawning `claude`, containing: engine version, protocol id, profile id +
  version + digest, request hash, model, permission mode, allowed and disallowed tools, max turns,
  per-action and total USD caps, action timeout, run wall-clock, auth mode, attempt count (always
  1), and expiry.
  - Acceptance: rendering the same inputs twice yields byte-identical manifests and an identical
    `manifestHash`; a fake `claude` records zero invocations.
- **R2.** When `run approve` is invoked, the engine shall mint an approval only after an
  interactive confirmation on a controlling terminal (stdin and stderr are TTYs) in which the
  operator types a challenge that is cryptographically random, fresh per ceremony, and shown only on that terminal
  (never printed by `run manifest`, never stored); a non-TTY invocation shall be refused with
  `APPROVAL_TTY_REQUIRED` and write nothing. *(Amended 2026-10-01: previously derived from the
  manifest hash, which let a session that saw `run manifest` output relay the answer in advance.)*
  - Acceptance: no argv flag, environment variable, or piped stdin can mint an approval (tested via
    the injected TTY seam and a piped-stdin negative test).
- **R3.** The engine shall write each approval as a `yellow-goal/run-approval/v1` record
  (`approvalId`, `manifestHash`, full manifest, `createdAt`, `expiresAt`, `engineVersion`) to an
  operator-specified path with exclusive create and owner-only permissions; default expiry is 60
  minutes and a manifest may shorten but never lengthen it.
- **R4.** When a real run is started, the engine shall recompute the manifest from the actual
  invocation and refuse before any spawn unless the approval's `manifestHash` and `engineVersion`
  match and its `expiresAt` is in the future; each refusal has a distinct code
  (`APPROVAL_MISSING`, `APPROVAL_INVALID`, `APPROVAL_HASH_MISMATCH`, `APPROVAL_EXPIRED`,
  `APPROVAL_ENGINE_MISMATCH`). The hashed manifest carries only the relative `expiresInMinutes`
  (never an absolute time), so recomputation is deterministic; the absolute `expiresAt`
  (`createdAt + expiresInMinutes`, at most 60) lives only on the approval record and is checked
  against the clock separately.
  - Acceptance: a test approves once and starts later (within expiry) without
    `APPROVAL_HASH_MISMATCH`.
  - Accepted risk: an approval record is consent evidence, not a credential. A process running as
    the operator could forge a record without a TTY; signed approvals were rejected by the operator
    (ADR-0020). Mitigation is a harness-level PreToolUse deny on approval-record writes and
    agent-driven ptys, tracked as a follow-up.
- **R5.** The engine shall consume an approval exactly once, by atomically creating a
  consumption marker keyed by the approval's `approvalId` in an engine state directory before
  spawning the worker; if the marker exists the run is refused `APPROVAL_CONSUMED`. Consumption
  is final regardless of the run's outcome (including cancel). (Amended 2026-09-28: originally a
  marker beside the approval file, which a copied file could evade — ADR-0020.)
  - Acceptance: two concurrent starts with one approval produce exactly one spawn; a copy of the
    approval file at another path is refused `APPROVAL_CONSUMED`.
  - Crash-before-spawn: the marker is written before spawn, so a crash between marker creation
    and spawn leaves the approval consumed with no spawn. This is deliberate (fail closed; exactly
    one spawn is never violated); the operator recovers by minting a new approval. The `refused`
    outcome for that case, and any `starting`/`spawned` marker state, is decided in the
    run-execution shell.
- **R6.** Every real run that passes all pre-spawn refusals (and so emits `run.start`) shall carry
  its `approvalId` in `run.start`, the spend ledger (R16), and the terminal outcome (R19). A
  refused invocation emits no events; its single structured refusal error (R19, R24) carries the
  `approvalId` when a valid approval was read (e.g. `AUTH_MODE_MISMATCH`, `APPROVAL_CONSUMED`) and
  omits it otherwise (`APPROVAL_MISSING`, `APPROVAL_INVALID`, `APPROVAL_EXPIRED`).

### Worker execution

- **R7.** The engine shall add a new `config-repair` profile **version** that carries the worker's
  milestone text, with its own digest covering that text; the existing version shall remain
  byte-identical so existing VS bundles still reproduce.
  - Acceptance: a regression test reproduces a bundle made with the existing version after the new
    version lands; the new digest changes when the milestone text changes.
  - Clarification: profile lookup for `acceptance verify` and `acceptance reproduce` shall resolve
    the recorded id + version pair through a version-keyed registry (not id alone), so a bundle
    made with the older version does not become `profile-digest-mismatch`. Decided in the
    worker-profile shell.
- **R8.** A real run shall execute in an engine-owned scratch worktree seeded with the profile's
  base files byte-for-byte; it shall never read or write `target.repository`, and `run.start`
  shall disclose `targetRepositoryHonored: false`.
- **R8a.** The bundle and spend-ledger destinations of a real run shall be part of the approved
  manifest (canonical absolute paths, covered by `manifestHash`), so the caller cannot redirect
  evidence writes after approval; the engine shall refuse before spawn a destination that is inside
  `target.repository` or the scratch worktree, or that resolves through a symlink, and shall
  create evidence files with no-follow, exclusive opens. After the approval is consumed and before
  the worker is spawned, the engine shall exclusively create a reservation sentinel beside each
  evidence destination, in sorted path order, and shall not spawn when a sentinel already exists.
  Sentinels are removed when the run finishes. Two concurrent approvals of one manifest therefore
  spawn at most one worker. The manifest schema gains these fields
  when the run path is wired (run-execution shell); approvals minted earlier do not authorize a
  real run.
  - Acceptance: two concurrent approvals of one manifest spawn exactly one worker.
- **R9.** A real run shall build a fixed one-action goal from the profile's milestone text and
  shall not invoke the LLM extractor.
  - Acceptance: the fake `claude` records exactly one invocation per successful run.
- **R10.** A real run shall make at most one worker attempt: no retries, replans, re-extractions,
  or remediation loops; any failure ends the run with a blocker outcome (R19).
- **R11.** The real-run path shall invoke the worker with `--permission-mode acceptEdits` and an
  `--allowedTools` list taken from the approved manifest; it shall be impossible for this path to
  resolve to `bypassPermissions`.
  - Filesystem confinement: `acceptEdits` plus `--allowedTools` does not itself confine tools to
    the scratch worktree. Before spawn, the real-run path shall refuse an approved manifest whose
    filesystem tools (`Read`, `Edit`, `Write`, …) are not path-scoped to the worktree, unless the
    worker runs under an OS sandbox proven by a fixture; which mechanism is decided in the
    worker-execution shell. R17 filtering of the candidate is a second line of defense, not the
    confinement.
  - Acceptance: a unit test over every manifest-reachable configuration plus a static regression
    test on the real-run module fail if `bypassPermissions` becomes reachable.
- **R12.** The engine shall pass the manifest's per-action cap as `--max-budget-usd`, accept only
  manifests with per-action cap ≤ total cap ≤ the ADR-0010 default (rejected before the approval
  is consumed), and record the reported `total_cost_usd`; if a
  worker result lacks a cost figure, the run shall end as a blocker with reason `cost-unmetered`.
- **R13.** The engine shall refuse the run before spawn (and before consuming the approval) with
  `AUTH_MODE_MISMATCH` when the environment's credential does not match the manifest's auth mode
  in either direction: `ANTHROPIC_API_KEY` present while the auth mode is not `api-key` (the
  API key would silently override the subscription), or absent while the auth mode is `api-key`
  (the CLI would silently fall back to subscription credentials).
  - Acceptance: both mismatch directions refuse with no spawn and the approval unconsumed.
- **R14.** The engine shall enforce the manifest's action timeout and run wall-clock, abort the
  worker on SIGINT/SIGTERM with SIGTERM→SIGKILL escalation, and report the resulting outcome; a
  cancelled run still consumes its approval (R5). The worker shall be spawned in its own process
  group and the escalation signals sent to the whole group, so descendants cannot outlive the
  bound.
  - Acceptance: a fixture worker that spawns a descendant ignoring SIGTERM is fully terminated on
    timeout and on cancel.
- **R15.** The worker command shall be injectable as a constructor option for tests and shall not
  be selectable through environment variables, argv, or `PATH` from the production `goal-gen`
  command (PP-03). Process-level tests (including the R33 operator recipe) use a separate
  test-only harness entry point — outside the packaged `bin`, not reachable from the
  production real-run command — that constructs the engine with the fake worker injected.
  - Acceptance: a static test proves the production bin never imports the harness or the fake
    worker; the harness is excluded from the release tarball.
- **R16.** The engine shall append one spend-ledger entry per worker spawn (`approvalId`, model,
  reported cost, turns, duration, exit class) alongside the run's evidence.

### Verification and outcome

- **R17.** After the worker exits, the engine shall build a `yellow-goal/candidate-file-content/v1`
  candidate from the profile's allowed paths only; changed files outside those paths shall be
  listed by name as `outOfScopeChanges` evidence and never enter the candidate. Allowed paths are
  worker-controlled, so each is opened descriptor-relative to the worktree with no-follow and
  non-blocking flags, verified as a regular file with `fstat`, and capped at the profile's byte
  limit before its bytes are loaded; a symlink, FIFO, device, directory or oversize entry is never
  read and ends the run as `worker-failed` with the offending path as evidence.
  - Acceptance: fixtures where the worker replaces an allowed path with a symlink to an operator
    file, a FIFO, and an oversize file each end `worker-failed` without reading through or
    blocking.
- **R18.** The engine shall judge the candidate with `acceptance verify-candidate` for the approved
  profile version, writing the bundle to an operator-specified directory; the worker's own
  narrative or exit status shall never make a run succeed.
- **R19.** Every real-run invocation shall end in exactly one outcome with evidence: `refused`
  (R4/R5/R8a/R13, no spawn — transported only as the single structured refusal error on stderr,
  with no `run.start` or other events), `worker-failed` (budget, max turns, timeout, cancel, permission denied, error result,
  `cost-unmetered`), `verification-rejected` (bundle `accepted: false` with decider reasons), or
  `verified` (bundle `accepted: true`).
- **R20.** No engine verb shall mark a real-run candidate accepted; `verified` means "awaiting
  human", and the operator's final accept follows a fresh-process `acceptance reproduce`.
- **R21.** The engine shall never commit, merge, push, publish, or deploy real-run output; the
  scratch worktree shall be removed on every terminal path after its creation (including timeout,
  cancel, spawn error, malformed output, missing cost, and verification failure), and any extracted
  candidate bytes shall be retained outside the worktree (the bundle keeps the bytes).

### Protocol v2

- **R22.** The engine shall add `yellow-goal/provider-protocol/v2`. Protocol discovery shall be
  exposed only through a separately selectable v2 capabilities response (`capabilities --json
  --protocol v2`), which advertises the supported protocol ids; `capabilities --json` without a
  selector, all other v1 invocations, and all v1 output shall remain byte-identical.
  - Acceptance: golden tests of v1 `capabilities` (no selector), stub runs, and errors pass
    unchanged; a v2 test asserts `capabilities --json --protocol v2` lists the supported protocol ids.
- **R23.** Under v2, stub runs shall behave exactly as v1 stub runs apart from the protocol id.
- **R24.** Under v2, a real run shall be selected only by the dedicated executor id
  `agx-claude-code` together with an explicit profile and approval path, advertised as a
  distinct capability; its `run.start` shall report executor,
  `simulation: false`, `targetRepositoryHonored: false`, `approvalId`, profile digest, and caps.
  Evidence is phase-dependent: a spend event is emitted once per worker spawn (so only after a
  spawn); the terminal outcome carries the bundle path only for `verification-rejected` and
  `verified`; a `worker-failed` outcome carries spend when a spawn happened and no bundle path.
  A `refused` invocation (R4/R5/R13, no spawn) emits neither spend nor bundle: it is reported as
  the structured refusal error before any `run.start`, with `approvalId` only when a valid
  approval was read (R6).
- **R25.** A v2 real run shall be non-interactive once approved: the approval replaces the DoD
  confirmation, and `--yes` shall be rejected on real runs.
- **R26.** `--protocol v1` shall continue to require `--executor stub`, and the legacy
  `--executor claude-code` path (hardcoded `bypassPermissions`) shall be neither advertised in v2
  capabilities nor reachable from v2: under `--protocol v2`, `--executor claude-code` shall be
  rejected without spawn, and `agx-claude-code` shall dispatch only to the new approval-gated
  implementation, never to the legacy executor.
- **R27.** The engine version carrying v2 shall be released as a tarball through the existing
  release workflow (ADR-0016) before any consumer pins it.

### Consumer (yellow-plugins)

- **R28.** The consumer shall pin the released v2 engine and use protocol v2 for all its commands
  (stub and real); its compatibility gate stays blocking, and the existing stub command's
  user-visible behavior is unchanged.
- **R29.** The consumer shall validate v2 capabilities, real-run `run.start`, spend events, and
  terminal agreement, rejecting a real-run stream without `approvalId`, with `simulation: true`, or
  with `targetRepositoryHonored: true`.
- **R30.** The consumer shall provide a user-only real-run command (`disable-model-invocation:
  true`) that displays the engine-rendered manifest, forwards an operator-supplied approval path,
  never passes `--yes`, and reports spend and the bundle path; it shall have no way to mint an
  approval.
- **R31.** Consumer tests shall use a fake engine only and never spawn a real executor; user flags
  on the existing stub command still cannot select an executor or protocol.

### Testing and operations

- **R32.** No CI job shall spawn a real `claude`: engine tests inject a fake worker that replays
  recorded envelopes (success, error result, budget stop, max turns, permission denial, malformed
  output, missing cost).
- **R33.** An operator runbook for the real run shall exist and be exercised end-to-end against the
  fake worker by an operator-recipe-style CI job (ADR-0019 pattern), driving the R15 test-only
  harness entry point as a process — never the production bin with an environment or `PATH`
  override.
- **R34.** Before the worker engine is finalized, a human-run probe shall establish whether
  `acceptEdits` plus the allowlist can edit the profile's allowed paths headless; on failure the
  allowlist may be widened once, and on a second failure the work stops for redesign — never a
  `bypassPermissions` fallback.
- **R35.** A human operator shall run one live acceptance on the released engine with the
  `config-repair` profile, sonnet, subscription auth and a $5 total cap, and record the approval,
  spend ledger, bundle, `reproduce` result, and measured cost in a docs PR.

## Design

### Components and ownership

| Component | Repo | Covers |
|---|---|---|
| Manifest builder + `run-approval/v1` schema | goal | R1, R3 |
| `run approve` ceremony (TTY seam) | goal | R2 |
| Approval verifier + consumption marker | goal | R4, R5, R6 |
| `config-repair` new version with milestone text | goal | R7 |
| Real-run engine (seeded worktree, fixed goal, one attempt) | goal | R8, R9, R10, R14, R21 |
| Executor options: allowlist, budget flag, injectable command, env guard | goal | R11, R12, R13, R15 |
| Spend ledger | goal | R16 |
| Candidate extraction + verifier hand-off + outcomes | goal | R17–R20 |
| Protocol v2 surface + release | goal | R22–R27 |
| Pin bump + v2 validators | plugins | R28, R29, R31 |
| User-only real-run command | plugins | R30, R31 |
| Fake worker, runbook, operator-recipe job | goal | R32, R33 |
| Probe and live run (human) | operator | R34, R35 |

### Key flows

1. **Approve (zero spend).** `run manifest` (R1) renders and prints the manifest. The operator runs
   `run approve --out <path>` at a terminal; the ceremony (R2) shows the manifest, asks for the
   fresh challenge it shows, and writes the record (R3).
2. **Run.** `run --protocol v2 --executor agx-claude-code --profile config-repair@<new> --approval
   <path> --bundle-dir <dir>`. Order is fixed: recompute manifest → verify approval (R4) → env
   guard (R13) → consume (R5) → seed worktree (R8) → one worker spawn (R9–R12, R14) → ledger (R16)
   → extract candidate (R17) → `verify-candidate` (R18; the engine splits `config-repair@<new>`,
   passes the profile ID `config-repair` as the profile argument and the approved version through an
   explicit version option, and the offline lookup resolves the ID then checks that version) →
   outcome (R19) → cleanup (R21). Any
   refusal happens before consumption except R5 itself; nothing spawns before consumption.
3. **Accept (human).** `acceptance reproduce <bundle>` in a fresh process, then the operator's
   decision recorded in the R35 evidence (R20).

### Decisions

- **Single-use by filesystem marker, not a daemon or database.** Exclusive-create of a marker
  keyed by `approvalId` (under `$XDG_STATE_HOME/yellow-goal/consumed/`) is atomic on local
  filesystems, needs no daemon or database, and fits the single-admin trust model (ADR-0011).
  Signed approvals are out of scope for the same reason.
- **TTY ceremony is consent, not authentication.** It stops agent sessions (no controlling
  terminal) and piped input; a human who deliberately scripts a TTY is outside the threat model.
- **Approval replaces the DoD confirm on real runs (R25).** With a fixed one-action goal, the
  manifest already shows everything the DoD gate would; a second prompt adds no decision.
- **Profile version bump (R7) instead of a second digest.** Keeps one digest per profile version
  and leaves existing bundles reproducible.
- **Paths are explicit arguments.** The engine has no `runtime/` concept; approval, bundle, and
  ledger locations are operator-supplied (the workspace puts them under `runtime/`). Bundle and
  ledger destinations are approved as part of the manifest (R8a), so a host session cannot choose
  them after the human approved.
- **Filesystem confinement by path-scoped permission rules, not an OS sandbox (R11).** Decided
  when expanding the worker-execution shell (operator, 2026-09-29). Before spawn the engine
  refuses (`TOOLS_UNCONFINED`) any allowed tool that is not `Read`/`Edit`/`Write`/`MultiEdit`/
  `Glob`/`Grep` with a relative in-worktree specifier; `Bash` can never be path-scoped. CI proves
  the refusal; the human-run R34 probe proves Claude Code enforces the scoped rules headless (an
  out-of-worktree read and write are denied). An escape in the probe stops the work for a redesign
  toward a sandbox — never a wider permission mode.
- **The worker's Claude Code config and tool set are pinned (R11).** Real runs always pass
  engine-constant `--setting-sources project --strict-mcp-config` (the scratch worktree has no
  project settings), so the operator's user settings, plugins, hooks and MCP servers cannot widen
  the approved allowlist (operator, 2026-09-29). `--tools` limits the available built-in tools to
  the approved filesystem tools, because allow rules only add approvals and read-only Bash commands
  are auto-approved. Because project settings are then the only source, the engine also emits
  constant deny rules for `Bash`, `WebFetch`, `WebSearch`, and for writes to `.claude/`,
  `.mcp.json`, `CLAUDE.local.md` and `.git` at any depth, and refuses a worktree that already
  holds worker config.
  The prompt goes to the worker on stdin, never argv.
  Engine git calls in the worker-writable worktree — the executor's activity oracle and the
  orchestrator's diff capture — are pinned to the pre-run git dir (which must lie outside the
  worktree) with `core.fsmonitor` and hooks disabled.
- **No intermediate consumption states (R5; decided in shell 03, 2026-09-29).** The marker is
  written once, at consumption; there are no `starting`/`spawned` states. A crash between
  consumption and spawn leaves the approval consumed with nothing spawned, and the operator mints a
  new approval — the single-use guarantee never depends on crash recovery.
- **Evidence destinations are canonicalized at manifest time (R8a; shell 03).** `run manifest`
  stores each destination as `realpath(parent)` plus its basename, so the approved path names no
  symlinked directory, and the real run recomputes the manifest the same way. A destination whose
  parent was later swapped for a symlink therefore no longer matches the approval
  (`APPROVAL_HASH_MISMATCH`); a removed parent cannot be recomputed (`MANIFEST_INVALID`). Before
  consumption the engine also refuses (`EVIDENCE_DESTINATION_REFUSED`) a destination that already
  exists, sits inside the request's target repository or a real-run scratch worktree, or whose
  parent no longer resolves to itself, is owned by another user or is group/world-writable. The
  same pre-consumption refusal covers a destination whose `<destination>.goal-gen-reserved`
  sibling would exceed the 255-byte file-name limit, and a destination whose own path ends with
  `.goal-gen-reserved` (that path is another run's sentinel; reserving the unsuffixed path would
  create it and the later release would unlink it). The check is
  repeated once the scratch worktree exists and just before each evidence write (a
  failure then is `worker-failed`, the approval already consumed), and the bundle is created
  through a held parent directory descriptor. After consumption and before spawn the engine also
  exclusively creates `<destination>.goal-gen-reserved` beside each destination (sorted path
  order) through the parent's held descriptor, and removes those sentinels the same way when the
  run finishes. Losing that reservation, or finding a
  leftover sentinel, is `worker-failed` `evidence-destination-refused` with nothing spawned (the
  approval is already consumed). A crash leaves the sentinels; the operator deletes them before
  another approval of those paths can run. Two concurrent approvals of one manifest therefore
  spawn at most once. A cancel before consumption refuses
  (`RUN_CANCELLED`) and leaves the approval usable.
- **Out-of-scope changes are evidence only (R17; AGX-R34 probe decision).** `acceptEdits` does
  not confine in-worktree writes, so the worker may leave files outside the allowed paths. They
  are listed by name in the outcome (`outOfScopeChanges`), never read into the candidate, and
  never fail the run; only the allowed paths are extracted and judged.

### Acceptance matrix

| Row | Requirements | Engine proof | Consumer proof |
|---|---|---|---|
| A1 | R1–R3 | manifest determinism, TTY-only mint, record schema | — |
| A2 | R4–R6, R13 | each refusal code, no spawn; concurrent-start single spawn | — |
| A3 | R7 | old-version bundle reproduces; new digest covers text | — |
| A4 | R8–R12, R14–R16 | fake-worker runs: one invocation, flags, caps (rejects per-action > total), ledger, cancel, descendant kill | — |
| A5 | R11, R26 | `bypassPermissions` unreachable (unit + static) | — |
| A6 | R17–R21 | allowed-paths-only candidate, each outcome kind, no commit | — |
| A7 | R22–R25 | v1 goldens unchanged; v2 stub parity; v2 real start/spend/outcome | — |
| A8 | R27, R28 | released tarball install smoke | compat gate on the new pin |
| A9 | R29–R31 | — | validators, user-only command, fake-engine tests |
| A10 | R32, R33 | fake-worker suite; operator-recipe job | — |
| A11 | R34, R35 | human-run evidence docs PR | — |

### Delivery order

Engine first and released, consumer second (the step 4 → 5 precedent). Suggested slices for
`/flow:decompose`: E0 docs (ADR-0020, this spec, VS layer-table 4a row at
`verified-single-milestone-execution.md:21-22`, runbook skeleton) → E1 approval (R1–R6) → E2 worker
engine (R7–R21, R32; gated on the R34 probe) → E3 protocol v2 + release (R22–R27, R33) → P1 pin +
validators (R28, R29, R31) → P2 command (R30) → A1 live run (R35).

## MVP Scope

Everything above is the MVP for step 6. Captured-base (4b) is only the scratch seed: profile id,
pinned commit (`source.commit`), and selected file bytes (`source.overlay.files`), refusing a dirty
or mixed owner worktree before any worker spawn, with `targetRepositoryHonored` false. Deferred:
target-bound execution, bounded retries, in-process sign-off gate, remote gate resolution, retiring
the legacy `--executor claude-code` path (follow-up after R35). Not a live spend run.

## Open Questions

Both are deliberately deferred to the R34 probe (operator decision 2026-09-28):

- Exact per-action cap and timeouts inside the $5 envelope: set from the R34 probe's measured
  sonnet cost on `config-repair`.
- Whether the worker child gets a minimal `--settings` to suppress hook/plugin side effects, or
  relies on allowed-paths-only extraction (R17): decided by the R34 probe. Narrowed 2026-09-29:
  the worker config is now pinned (see Decisions), so the probe only decides whether residual side
  effects need an engine-owned settings file, which would be carried in the approved manifest.
