# Spec: Canonical Request-to-Run Pipeline

> Authored 2026-08-26 as the re-derivation the reconstructed backend spec calls for
> (`m1-backend-api-persistence-controls.md` → "Forward guidance"): the transport question is
> settled here **before** any HTTP endpoint surface is re-derived. R-ids in this spec use the
> `RR` prefix so they can never be confused with the original spec's unrecovered `R7–R18,
> R20–R21, R28, R33–R34` — those remain unrecovered and must still be re-derived against
> `.claude/specs/api.md` + PRD §6 when the HTTP milestone starts. (New partial evidence found
> during this work: `backend/src/db/schema.ts` cites **R16** as "`id` doubles as the SSE event
> id" on `run_events` — record that when R16 is re-derived.)

## Problem

Two disjoint pipelines never meet:

- The **compiler pipeline** (`request create/validate → inspect → analyze → compile → packet
  verify`) consumes the canonical `RepositoryGoalRequest`
  (`backend/src/contracts/request.ts`) and ends at a read-only packet ZIP.
- The **M1 runner** (`backend/src/runner.ts`) takes a bare goal string, is not on the CLI
  dispatcher, executes for real, and logs ad-hoc `{t, ev, ...}` lines.

Three event shapes exist: `RunEventSchema` (`yellow-goal/run-event/v1`, vendored JSON Schema
— emitted by nothing), the orchestrator's unversioned `insertRunEvent` rows, and the runner's
stdout lines. An external process consumer (the yellow-plugins bridge) would need two request
formats and three event dialects. This spec collapses each to one.

## Transport decision (settles shell-04's HTTP-first assumption)

The canonical consumer transport for this phase is the **stdio CLI**: spawn `goal-gen <verb>`,
parse JSON stdout / single-line structured stderr, discriminate on exit codes. `.claude/specs/
api.md`'s HTTP + realtime surface assumed an in-process frontend as first consumer; the actual
first consumer is an external process harness. HTTP becomes a thin adapter over the same
verbs/events later — nothing in this spec may depend on an HTTP server existing.

## Requirements

### One request object (RR1–RR5)

- **RR1 — single request format.** A run is requested with the same canonical
  `RepositoryGoalRequest` the compiler consumes. No parallel "run request" schema. Run intent
  is expressed by the existing `mode: 'approved-implementation'` — the enum value shipped for
  exactly this purpose and consumed by nothing until now.
- **RR2 — execution refinement, vendored schema verbatim.** Run-specific configuration lives
  in an `execution` sub-object of the already-untyped `orchestration` bucket (same policy as
  `permissionProfile`/`orchestrationProfile`, schemas/README "No changes needed":
  `request.schema.json` is kept verbatim; zod narrows compatibly). Shape:
  `orchestration.execution?: { autoConfirmDod?: boolean; model?: string; guardrails?: {
  maxBudgetUsd?; maxReplans?; maxReextractions?; maxRetriesPerAction?; actionTimeoutMs? } }`
  — every guardrail optional, defaulting via `defaultRunConfig()` (ADR-0010). The `execution`
  object itself is **strict**: unknown keys inside it are a validation error (fail closed on
  typos in spend-controlling config), even though the surrounding `orchestration` bucket stays
  passthrough.
- **RR3 — one mapping path.** `backend/src/run/request-to-run.ts` maps a validated request to
  run inputs `{ goalText, runConfig, autoConfirm }`: `goalText` is `intent.goal` **verbatim**
  (the compiler's goal-preservation invariant applies to the run path too); `runConfig` is
  `defaultRunConfig(guardrail + model overrides)`; `autoConfirm` from
  `execution.autoConfirmDod` (default false). Everything that turns a request into a run goes
  through this module — the CLI `run` verb and the M1 runner may not derive run inputs
  anywhere else.
- **RR4 — fail closed on intent.** A request whose `mode` is not `'approved-implementation'`
  is refused before any extractor/executor/worktree work starts (`VALIDATION_FAILED`
  envelope with details naming the field, exit 1). Review modes never execute.
- **RR5 — runner consumes the request file.** `npm run runner -- --request <file>` drives the
  identical RR3 mapping. The bare-goal form (`npm run runner -- "<goal>"`) remains for
  operator back-compat, mapping onto the same defaults.

### One event shape (RR6–RR10)

- **RR6 — run-event/v1 everywhere.** Every event crossing a process or persistence boundary
  is a `run-event/v1` envelope (`schemaVersion`, `runId`, `sequence`, `timestamp`, `type`,
  `payload`) validating against both `RunEventSchema` (zod) and the vendored JSON Schema.
- **RR7 — one sequence mint per run.** A single per-run emitter mints `sequence`: starts at
  0, +1 per event, monotonic across **all** sources feeding the run (extractor `onEvent`,
  orchestrator `onEvent`, entry-point wrapper). Nothing else mints sequences.
- **RR8 — internal call sites keep their names.** The orchestrator's/extractor's ad-hoc
  `{ ev, ...rest }` objects map to envelopes as `type = ev`, `payload = rest` at the emitter
  boundary; call sites stay terse. Runner/`run`-verb stdout is one serialized envelope per
  line (JSON Lines).
- **RR9 — persisted rows carry the same identity.** `run_events` gains a `sequence` column
  (generated migration, unique on `(run_id, sequence)`); `PersistenceProvider.insertRunEvent`
  takes the envelope's `sequence`. The synchronous `AwaitingAcceptance` write (R31 semantics
  preserved: status update + event write awaited before the gate parks) uses a
  emitter-minted envelope, so the durable log and the stream can never disagree on ordering.
- **RR10 — the summary is an event.** The terminal `run.summary` is itself a run-event/v1
  envelope (the last one of the run), not a bespoke final object.

### `run` verb on the dispatcher (RR11–RR16)

- **RR11 — same contract as every other verb.** `run <request.json> [--yes] [--executor …]
  [--json]` joins `request|inspect|analyze|compile|packet` on
  `backend/src/cli/index.ts`: JSON stdout, single-line stderr envelope
  `{"error":{code,message,details?}}`, exit 2 = `USAGE_ERROR`, exit 1 = other failures. A
  consumer never needs a second protocol.
- **RR12 — streamed events + terminal summary.** stdout is run-event/v1 JSON Lines (RR6);
  the final line is the `run.summary` envelope. Exit 0 iff terminal status is `succeeded`;
  exit 1 otherwise (including `failed`/`cancelled`/`budget-exhausted`). On any non-`succeeded`
  terminal status the verb ALSO writes RR11's single-line stderr envelope
  (`{"error":{code,message}}`), with `code` one of `RUN_FAILED` / `RUN_CANCELLED` /
  `RUN_BUDGET_EXHAUSTED` so a consumer can tell them apart without parsing `reason` text;
  the success path's stderr stays empty and stdout's terminal `run.summary` is unaffected
  either way. The mandatory 60-minute run-wide wall-clock (CLAUDE.md invariant #6, ADR-0010,
  `RUN_WALL_CLOCK_MS` in `orchestrator/guardrails.ts`) is enforced here by aborting the run's
  `AbortController` on trip, which surfaces as an ordinary `cancelled` terminal summary.
- **RR13 — no default executor.** `--executor claude-code|stub` is required: real spend is
  only ever an explicit choice (ADR-0015 fail-closed posture), and `stub` gives consumers and
  tests a deterministic, zero-spend path. Absent/unknown values are a `USAGE_ERROR`; nothing
  is spawned.
- **RR14 — gates preserved.** `--yes` auto-confirms DoD/reconfirm gates only; the completion
  sign-off (acceptance) gate is never auto-accepted by `--yes` (existing runner semantics,
  CodeAnt Critical finding). Interactive gates read stdin exactly like the runner.
- **RR15 — no DB wiring yet.** The `run` verb runs with the no-op persistence provider
  (parity with the M1 runner). Wiring `DATABASE_URL`-backed persistence into the verb belongs
  to the HTTP/persistence milestone, not this one.
- **RR16 — CI never executes a real agent.** Tests cover the `run` verb exclusively through
  `--executor stub`; the real-executor path stays covered by `tests/integration/
  runner.probe.ts` (outside the vitest glob, operator-invoked only).

### Operator consent & non-interactive gates (RR18–RR20)

Added 2026-08-26 from the adversarial review of the `run` verb (PR #18): a request FILE is
untrusted input relative to the invoking OPERATOR — anything that expands spend or removes
oversight needs consent expressed on the command line, not in the file.

- **RR18 — guardrail ceilings.** A request may freely LOWER guardrail caps; RAISING any
  spend/time-relevant cap (`maxBudgetUsd`, `maxReplans`, `maxReextractions`,
  `maxRetriesPerAction`, `actionTimeoutMs`) above the ADR-0010 defaults requires the
  operator's explicit `--allow-guardrail-override`. Without it the mapping fails validation
  (`RUN_GUARDRAILS_EXCEED_DEFAULTS`, one entry per offending field). `model` is not a cap
  (it selects unit cost) and stays unrestricted. The effective `runConfig` is always emitted
  in the stream's `run.start` audit envelope, along with the override flag, so spend
  configuration is never invisible.
- **RR19 — real-executor DoD consent.** With a real executor (the runner always; the `run`
  verb under `--executor claude-code`), the DoD gate is where the operator sees every verify
  command before real spend — the request file's `autoConfirmDod` alone cannot skip it; only
  the CLI `--yes` can. An ignored request-file ask is surfaced in-stream
  (`gate.requestAutoConfirmIgnored`), never silently dropped. The zero-spend stub engine
  honors `autoConfirmDod` as-is.
- **RR20 — non-interactive gate policy.** Gate prompts go to stderr (stdout is the protocol
  stream). On closed/dead stdin: the DoD/reconfirm gate DECLINES (costs nothing); the
  acceptance gate FAILS LOUDLY rather than auto-deciding — 'reject' would trigger the
  remediation loop's real spend with nobody at the keyboard. (Mechanics shipped in the PR #18
  review pass; recorded here as policy.)

### Known conflations / deferred mappings (recorded, not resolved here)

- `permissionProfile` is compiler-scoped today: the run path does not map profiles onto
  executor permission modes (the real engine uses ADR-0009's scratch-worktree bypass opt-in
  regardless). Profile→permissionMode mapping is provider-protocol-v1 work. The canonical
  execution sample uses the `implement` profile for coherence, but nothing consumes it on the
  run path yet.
- `target.repository` is disclosed in `run.start` (`targetRepositoryHonored: false`) — see
  "Out of scope".

## Design

### Stacked delivery

| PR | Branch | Covers |
|---|---|---|
| 1 | `agent/feat/ci-gates` | CI/migration/installation gates (shipped separately) |
| 2 | `agent/feat/run-request-contract` | RR1–RR5 |
| 3 | `agent/feat/run-event-v1` | RR6–RR10 |
| 4 | `agent/feat/run-verb` | RR11–RR16 |

### Provider-protocol seed (six-step order, step 4)

The run-event/v1 stream over stdio (RR6–RR8, RR12) is deliberately the substrate of the
future provider protocol: a provider is "something that emits this stream and honors this
request object". Protocol v1 should version the *verb surface and gate interaction*, not
invent a new event envelope.

## Out of scope

- HTTP endpoints, WebSocket/SSE, auth, read models (`.claude/specs/api.md`) — blocked on
  re-deriving the unrecovered R-ids; the transport decision above is this spec's only input
  to that work.
- Executing against `target.repository`. The M1 loop runs every action in a fresh scratch
  worktree in tmpdir (`executors/worktree.ts`, ADR-0009 blast-radius posture) — the request's
  target selects the *compiler pipeline's* subject today, not the executor's working tree.
  Pointing execution at the target is its own future milestone with its own safety review.
- DB-backed `run` verb persistence (RR15), crash-resume of parked gates (original R32
  posture), multi-executor routing (M2).
- Any change to the read-only compiler pipeline's behavior.
