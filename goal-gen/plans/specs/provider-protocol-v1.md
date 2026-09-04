# Provider Protocol v1 — installed stdio contract

Status: accepted design; implementation follows this independently reviewed specification.
Date: 2026-09-04. Owner: Yellow Goal. Consumer: Yellow Plugins.
Decision: [ADR-0017](../../docs/decisions/0017-provider-protocol-v1-stdio.md).

## Evidence and scope

Re-derived against Yellow Goal main `5fad39d48bf5df179bc80c3ead5185fd01025629`
and Yellow Plugins main `c9733b8c3ba1c1bf27a7a1b07a8a15bfc9799325`.
The released compatibility baseline is engine `0.1.0`, annotated tag `v0.1.0`
at `a2dd49ae7fd2c4c5140d4bdc259ba879e1e5b4aa`. It has no protocol discovery.
This document assigns NEW `PP-*` requirements. The lost R7–R18, R20–R21,
R28, and R33–R34 in the persistence/API plan remain unrecovered.

| Evidence | Current fact used here |
|---|---|
| [Request/run plan](request-to-run-pipeline.md), `backend/src/contracts/request.ts`, `backend/src/run/request-to-run.ts` | Canonical request, explicit executor, permission and guardrail admission |
| `backend/src/contracts/run-event.ts`, `backend/src/events/run-event-emitter.ts`, `tests/events/` | One existing envelope, per-run identity and contiguous sequence |
| `backend/src/cli/{index,commands,run-command}.ts`, `tests/cli/` | Artifact identity, JSON process boundary, legacy gate and terminal behavior |
| `backend/src/events/stdout-sink.ts`, `tests/cli/run-verb.test.ts` | Current EPIPE exception and unbounded flush need an explicit protocol policy |
| [Persistence/API plan](m1-backend-api-persistence-controls.md) | Lost requirements are not recoverable from their numbering; persistence controls are separate work |
| [API component](../../.claude/specs/api.md) | Proposed frontend REST/realtime transport, not a shipped provider contract |
| [Packet compiler](../../.claude/specs/packet-compiler.md) | Read-only compiler separation and permission-profile validation |
| [PRD](../../docs/prd.md) sections 6, 7, 9, 12 | Local single-operator scope, completion gates, bounded cancellation, staged infrastructure |
| ADRs [0008](../../docs/decisions/0008-completion-policy.md), [0009](../../docs/decisions/0009-worktree-isolation.md), [0015](../../docs/decisions/0015-compiler-provider-seams-and-failclosed-permissions.md), [0016](../../docs/decisions/0016-ci-gates-and-tarball-installation.md) | Preserve consent, distinguish isolation from sandboxing, fail closed, install tarball as external process |
| Plugins `plugins/yellow-goal/src/{pin,runtime,spawn,cli}.ts`, `tests/{cli-contract.test.ts,release-smoke.mjs}` at the commit above | Landed consumer checks version/create/validate, structured errors, bounded spawning and public release asset |
| `backend/src/extractors/stub-extractor.ts`, `backend/src/executors/stub-executor.ts`, `backend/src/orchestrator/orchestrator.ts` | Existing deterministic extraction error/cost seams; verifier results determine action success |

Protocol v1 admits only offline discovery, version, request create/validate,
and deterministic stub runs. It does not advertise or enable a real executor,
analyze, target-repository execution, HTTP, SSE, persistence, remote gate
resolution, pause/resume, or a control plane. Existing compiler and human-run
entry points remain separate. No provider probes or credential inspection are
needed to discover compatibility. This is a process protocol, not another
provider implementation interface inside the engine.

## PP-01 — independent identities and negotiation

`goal-gen capabilities --json` emits one UTF-8 JSON object plus LF, empty
stderr, exit 0. Unknown options or positionals produce `USAGE_ERROR`/2 with
empty stdout. Discovery is static and must not import run/executor modules,
spawn children, read a target, access the network, or inspect credentials.
Its output is JSON even if `--json` is omitted.

Required shape (arrays shown with their initial exact members):

```json
{
  "schemaVersion": "yellow-goal/provider-capabilities/v1",
  "protocolVersion": "yellow-goal/provider-protocol/v1",
  "engineVersion": "<package artifact version>",
  "requestSchemaVersion": "yellow-goal/request/v1",
  "runEventSchemaVersion": "yellow-goal/run-event/v1",
  "operations": ["capabilities", "request.create", "request.validate", "run", "version"],
  "capabilities": ["run.cancel.os-signal", "run.executor.stub", "run.gate.noninteractive", "run.stdout.jsonl", "run.timeout"],
  "stubScenarios": ["await-cancel", "budget-exhausted", "failed", "success"],
  "limits": {"maxEventBytes": 1048576, "maxQueuedBytes": 4194304, "writerFinalizationTimeoutMs": 5000}
}
```

The schema and protocol identifiers are exact strings, not engine semver.
`engineVersion` must agree with `version --json` and package metadata. Packet
format (`repository-goal-packet@1` and compiler compatibility constants) is a
separate identity; v1 does not consume a packet, so discovery does not imply
packet compatibility. Consumers first check their artifact policy, then the
exact supported protocol identity and required capabilities. Absence or an
unknown identity means unsupported, never an invitation to try another verb.

## PP-02 — evolution and capability validation

Required fields must have the documented types. Identity strings are nonempty;
operation/capability/scenario arrays contain unique nonempty strings. Limits
are positive safe integers. Consumers may ignore unknown fields and unknown
capability strings, but every capability they require must be present. Unknown
fields do not override known fields or weaken safety checks. Malformed known
fields or contradictory artifact identities are
invalid discovery. Producers MUST emit unique object keys. Consumers MAY reject duplicates when
their parser detects them; otherwise they validate the parser-effective values
and are not required to implement a second JSON parser. A consumer may use an exact released-artifact allowlist;
protocol compatibility alone does not authorize an unpinned binary.

Adding optional fields, diagnostic event types, or capabilities is compatible
within v1. Removing/changing required fields, framing, terminal meanings, or
safety guarantees requires a new protocol identity. Artifact semver follows
repository policy independently; choose the next release version from the
implemented impact, not this document's protocol number. The original 0.1.0
read-only bridge remains a regression baseline until the consumer pin changes.

## PP-03 — admitted invocation and request contract

A protocol run is explicitly selected:

```text
goal-gen run <request-file> --executor stub --protocol v1 [--yes] [--timeout-ms <n>] [--stub-scenario <name>]
```

The v1 selector, timeout and scenario options must reject incompatible
executors and unknown values before loading a request, emitting `run.start`,
or constructing an engine. A timeout is an integer from 1 through the existing
run wall-clock cap; omission keeps that cap. Scenario omission means success.
The existing `--json` and `--allow-guardrail-override` flags retain their
meanings. A consumer exposes no executor selector: its argv always names stub.
No arbitrary serialized factory, action queue, environment switch, or goal-text
convention selects a test scenario. Pure parsing tests prove executor rejection;
tests must never spawn a command naming a real executor, even to expect rejection.

The input remains `yellow-goal/request/v1`, validated by the existing owning
schema and `requestToRunInputs`. No new request type or copied consumer schema.
Preserve current unknown-field handling: root and execution/guardrails reject
unknown keys; constraints allow unknown boolean keys; orchestration and
overrides preserve unknown keys; target/intent/researchBounds strip unknown
keys when parsed. Unknown permission or orchestration profile values remain
fail-closed wherever those profiles are resolved. Discovery does not change
which requests are executable.

Request create/validate preserve their existing one-object JSON behavior.
Schema-invalid validate is the explicit domain exception: exit 1, stdout
`{path,valid:false,errors}`, empty stderr. It must not be confused with a run
terminal or with an invocation error.

## PP-04 — permissions are intent, never execution authority

Existing approved-implementation, allowTargetEdits, write-profile and raised
budget consent checks remain in force before `run.start`, including for stub.
These request fields describe intent; they do not authorize a provider, select
a checkout, or grant filesystem/credential access. Stub execution uses only the
in-memory worktree, stub extractor/executor/verifier and no child commands.
`target.repository` and `target.ref` are never execution selectors. A valid
write-intent request still causes no target change in this protocol. No new
bypass permission setting or fallback is introduced.

## PP-05 — event framing and order

Stdout is UTF-8 JSON Lines using the existing `yellow-goal/run-event/v1`
envelope. Each record ends with LF; CRLF is accepted by consumers. Empty
records, malformed UTF-8/JSON and an unterminated final
record are failures. Required envelope fields retain their owning schema:
`schemaVersion`, nonempty `runId`, nonnegative safe-integer `sequence`, valid
RFC3339 `timestamp`, nonempty `type`; payload, when present, is an object.

Exactly one run identity spans the stream. Sequence starts at 0 and increments
by one; timestamps are diagnostic and need not be monotonic. `run.start` is
first, once. `run.summary` is last, once. No events may follow summary. Unknown
nonterminal event types and unknown fields may be ignored semantically, but
still consume a validated sequence number. Unknown terminal statuses fail
closed. Process exit is never a replacement for a terminal summary.

`run.start.payload` retains its existing fields and additionally identifies
`protocolVersion`, `stubScenario`, and `simulation:true`; `executor` is stub
and `targetRepositoryHonored` is false. The synthetic action's legacy executor
label is not authority to launch a provider; consumers rely on run.start and
the advertised stub capability, not action labels.

## PP-06 — terminal and stderr agreement

After an admitted run starts, a healthy transport receives exactly one complete
summary with existing `status`, `goalText`, finite nonnegative `costUsd`,
nonnegative safe-integer `replans`/`reextractions`, `actions` array and string
`reason`. Each action has a string `actionId`, status
`succeeded|failed`, nonnegative safe-integer `attempts`, and finite nonnegative
`costUsd`; unknown action fields are allowed.
Unknown summary fields are allowed. `awaiting-acceptance` is not a terminal
status in v1. No duplicate summary is emitted on catch/cleanup paths.

| Terminal status / condition | Exit | Stderr error code |
|---|---|---|
| succeeded | 0 | empty stderr |
| failed | 1 | RUN_FAILED |
| budget-exhausted | 1 | RUN_BUDGET_EXHAUSTED |
| cancelled, terminationReason=signal | 1 | RUN_CANCELLED |
| cancelled, terminationReason=timeout | 1 | RUN_TIMEOUT |
| cancelled, terminationReason=gate-required | 1 | RUN_GATE_REQUIRED |
| Invalid invocation, before run.start | 2 | USAGE_ERROR |
| Invalid request/admission, before run.start | 1 | existing VALIDATION_FAILED code |
| Request I/O or unexpected preflight failure, before run.start | 1 | existing UNEXPECTED_ERROR code |
| Stdout loss, serialization/size/queue/drain failure | 1 | RUN_STDOUT_TRANSPORT_FAILED |

A cancelled summary requires `run.summary.payload.terminationReason` with one of those three
values. Other summary statuses omit it. Stderr failures are exactly one JSON
object plus LF: `{"error":{"code":"...","message":"..."}}`, with optional
unknown fields. Messages are diagnostics, never classification inputs. No
prompts, progress logs or raw exceptions appear on protocol stderr. All
succeeded/failed combinations not admitted by the table are protocol failures.
A preflight error has empty stdout. If either channel is unavailable, delivery
is best effort; the consumer must not infer success from missing data.

## PP-07 — interactive and non-interactive gates

Protocol v1 is non-interactive: stdin is unused and consumers close it. Existing
legacy interactive CLI behavior stays outside v1. For DoD/reconfirmation, CLI
`--yes` or the existing stub-only request autoConfirmDod may grant confirmation;
when confirmation is needed without that consent, emit `gate.required` with
`gate.required.payload.kind` equal to `dod` or `reconfirm`, decline immediately, and end cancelled/gate-required.
Only emit gate.required and classify termination as gate-required when the
shared `recordCause('gate-required')` operation wins. If signal or timeout
already won, preserve that cause and decline without a gate-required event.
This rule also applies to the acceptance adapter below. No human prompt or
indefinite stdin wait is permitted.

Completion sign-off is never auto-approved by `--yes`. Missing sign-off input
is a cancellation, not a user rejection: a plain acceptance `reject` would
enter the existing remediation path. The protocol adapter records gate-required
and aborts through the shared cause recorder, emits `gate.required` with
`gate.required.payload.kind: acceptance`, and settles its decision immediately. It may return reject
only after abort: the orchestrator's existing abort check must win before any
rejection/remediation branch. It must not emit `signoff.rejected`, re-extract,
remediate or dispatch another action. This reuses the AbortSignal seam rather
than adding a new remote gate decision.

The order is `gate.required`, then the existing `AwaitingAcceptance` diagnostic
if emitted by the current orchestrator, then the cancelled terminal (other
nonterminal diagnostics may occur). AwaitingAcceptance promises neither
persistence nor remote resolution, even when observed after input was found
unavailable. Tests inject a sign-off stub goal and assert the entire order,
cause and absence of remediation without changing the public success scenario.
Interactive gate resolution, pause/resume, durable sessions and remote control
need a separately specified milestone. No stdin JSON control channel is added.

## PP-08 — cancellation and deadlines

One AbortController owns an admitted run, installed with signal handlers and
deadline before the first event or engine construction. SIGINT/SIGTERM and
the deadline request cooperative cancellation. One synchronous first-cause
recorder owns signal, timeout and gate-required: record the cause before abort,
ignore subsequent causes, and derive both summary terminationReason and stderr
code from that record, never from diagnostic reason text. Successful or failed
completion freezes the result; an already accepted completion is not relabelled
by a later signal. The run must stop admitting work after cancellation and settle through one terminal
path. Run signal handlers, the deadline timer and gate listeners/waits are released
exactly once; the fatal-path stdout error guard follows PP-09. Gate-required
classification is retained when its decline caused termination.

V1 guarantees this lifecycle for its admitted in-memory stub engine, not an
arbitrary blocking provider or operating-system hard kill. Before admission,
or after SIGKILL/process crash, no terminal delivery is promised. Consumers
own an independent overall process deadline and cancellation signal; they send
SIGTERM, allow up to 5 seconds to close, then SIGKILL and settle a transport
failure if a complete agreeing result was not received. Platform signal
limitations become explicit transport failure, never successful cancellation.
A local timeout/cancel request cannot return consumer success, even if a late
success result races it; the consumer's first observed terminal condition wins.

## PP-09 — bounded output and transport failure

The engine uses one FIFO stdout writer. Respect write backpressure: do not
issue later writes until the stream permits them. Count UTF-8 bytes, including
LF: at most 1 MiB per event and 4 MiB queued/in flight. An event that cannot be
serialized or exceeds these bounds fails the transport; do not drop it and
resume with a sequence gap. A false write return alone is not an error.

Five seconds is the single total graceful-finalization budget for queued and
in-flight writes, drain and flush, not five seconds per phase. At the deadline,
record the first transport failure, abort the run, release internal waiters and
queued-buffer references, and destroy the CLI-owned protocol stdout stream.
Destruction is an escalation attempt, not a promise that OS I/O has settled;
finalization does not await close after the deadline. Retain a minimal stdout
error guard until close or process termination to absorb/record late errors
without retaining queued payloads. On healthy completion, remove that guard
only after all writes settle. The caller best-effort emits one structured
RUN_STDOUT_TRANSPORT_FAILED error on stderr and returns exit 1. If destruction
does not release the process, the consumer deadline and SIGKILL remain the hard
bound; do not force process exit in a way that truncates the error envelope.

The v1 sink must never throw into RunEventEmitter: it catches serialization and
synchronous write errors, records failure and aborts, avoiding the legacy
emitter catch that writes plaintext stderr. EPIPE is a transport
failure in v1, as are ENOSPC/EIO, write throws/callback errors, serialization
failure, queue overflow and drain timeout. Record the first error, abort the
run, stop new writes and release pending waits. Stdout transport failure takes
precedence over any summary status or cancellation cause and is reported once
on stderr if available. No summary delivery is promised after transport loss;
a previously seen summary is provisional until process close and stderr agree.
Legacy sink behavior may remain as a compatibility path; there is still only
one event dialect and the same canonical emitter for v1.

Consumers impose their own bounded stdout/stderr accumulation and overall
timeout; a malicious fake process cannot grow memory indefinitely. They verify
the engine's declared limits against supported bounds before starting a run.
No success is reported before stdout/stderr EOF and process close. Spawn error,
EPIPE, premature exit or a missing/truncated terminal yields a typed transport
or protocol error. An error/close/timeout race must settle exactly once.

## PP-10 — public deterministic scenarios

The named scenarios use existing internal seams and never spend money:

| Scenario | Mechanism | Result |
|---|---|---|
| success | Existing canned action and passing stub verifier | succeeded; costUsd 0 |
| failed | StubExtractor extractError | failed; RUN_FAILED |
| budget-exhausted | StubExtractor extraction cost equals configured budget | budget-exhausted; RUN_BUDGET_EXHAUSTED |
| await-cancel | In-memory extractor emits `stub.waiting`, waits on AbortSignal, rejects on abort | cancelled; signal or timeout code from first-cause record |

Scenario results assume a valid executable request and required PP-07 consent.
Public success and budget probes supply `--yes`; scenarios never bypass gates.
Without consent, reaching a DoD gate produces cancelled/RUN_GATE_REQUIRED.
Failure or cancellation before that gate does not require consent. The budget
cost is simulated accounting, not metered spend. Keep
arbitrary EngineFactory, executor/verifier FIFO queues and sign-off fixtures
internal. An executor's declared failed status alone is not the failure oracle:
the existing verifier governs action success. The await-cancel scenario is not self-cancelling: the caller supplies a real
signal or finite protocol timeout. Require an explicit `--timeout-ms` for this
scenario, so a forgotten signal still terminates. Its wait handles an already
aborted signal and removes its listener on settlement. Installed-package tests
wait for `stub.waiting`, send SIGTERM, and verify RUN_CANCELLED/signal; a second
invocation proves RUN_TIMEOUT/timeout. Transport tests additionally use bounded
injected writable seams and fake binaries.

## PP-11 — packaging and released-artifact compatibility

Owning tests cover discovery, invocation, terminal agreement, gate behavior,
transport failures and compatibility. The pack/install smoke must execute the
installed bin, not source imports, for discovery, version, create/validate,
stub success/failure/budget, await-cancel signal/deadline, and noninteractive
gate rejection. Runtime files
and target sentinels belong only in disposable test directories.

After implementation lands, select semver from actual impact, tag the verified
main commit with an annotated version tag, and use the existing recoverable
GitHub Release workflow. Verify public download, clean install, identity,
scenarios, and byte-identical publication rerun. Record the URL, annotated tag
object, peeled commit, asset SHA-256 and CI run evidence. No metered Actions artifacts.

Yellow Plugins then pins that verified URL, engine version and asset SHA-256.
Its blocking CI compatibility test checks the downloaded hash before installing
that exact public asset and drives the process
with credential-free test environments. Fakes cover malformed/failing peers;
no copied schema, cross-repository TypeScript import, npm link, private source
path, or production provider substitutes for observable behavior. Runtime
version/discovery checks validate an already trusted executable; they do not
claim to authenticate arbitrary replacement binaries.

## Acceptance matrix and dependency slices

Every row is required before implementation/consumer completion. Tests must
assert outputs, exit status and absence of provider/target effects, not merely
that commands returned. Unknown-field tests validate retained required fields.

| Acceptance | Requirements | Engine proof | Consumer proof |
|---|---|---|---|
| A01 offline static discovery, exact identities, artifact agreement | PP-01/02 | import/spawn isolation; installed bin | public asset handshake |
| A02 missing/malformed discovery fields, producer key uniqueness, parser-effective validation, incompatible protocol/artifact, missing capability | PP-01/02 | discovery shape/usage tests | fake process matrix; no next operation |
| A03 additive unknown fields/capabilities accepted | PP-02 | contract tests | fake compatible peer |
| A04 canonical request and permission/guardrail regressions | PP-03/04 | existing compat/admission suite plus no construction on rejection | public create/validate, fake admission errors |
| A05 invalid v1/scenario/timeout/executor combinations | PP-03 | pure parser tests before factory | consumer has no real-executor selector |
| A06 start identity, contiguous ordering, one terminal | PP-05/06 | emitter and installed scenario tests | fake missing/duplicate/out-of-order/wrong-run events |
| A07 UTF-8, JSON, blank/partial/oversized lines | PP-02/05/09 | writer byte/serialization tests | chunk-split and malformed fake stream matrix |
| A08 complete terminal/status/stderr/exit table | PP-06 | public stub scenarios including await-cancel and injected failure tests | every contradictory combination rejected |
| A09 noninteractive DoD/reconfirm/sign-off, no stdout/stderr prompts | PP-07 | injected gate fixtures and installed DoD rejection | actual artifact and fake gate outcomes |
| A10 first-cause signal/deadline, cleanup and terminal races | PP-08 | installed await-cancel SIGTERM and deadline; fake gates/listener assertions | actual artifact plus fake error/exit/cancel races, one settlement |
| A11 EPIPE/ENOSPC/write throws/serialization/backpressure/queue/drain timeout | PP-09 | controllable writable tests; abort and bounded flush | fake transport/truncated terminal; memory limits |
| A12 success/failed/budget, zero real spend and untouched target | PP-04/10 | installed tarball all scenarios | actual released asset all scenarios and sentinel |
| A13 public install and recoverable release provenance | PP-11 | release workflow, annotated tag and hash evidence | exact release URL in blocking CI |
| A14 no scope expansion | all | diff audit: no target wiring, HTTP, real executor or schema fork | diff audit: only admitted fixed argv |

Implementation PRs land in this order: (1) the internal bounded writer and its
failure tests, without changing CLI behavior or advertising capabilities;
(2) complete v1 discovery, admission, stub scenarios, noninteractive gates,
cancellation/terminal handling and installed-package proofs using that writer;
(3) release/version changes if needed. This keeps intermediate main usable and
avoids advertising a partially implemented protocol. The complete v1 discovery
shape above is exposed only when all of its guarantees pass. Then release the
engine and land the consumer. Final acceptance remains gated on both
repositories' current-head CI and review disposition. Real-Claude acceptance
is a later human-controlled milestone and is not implemented or run by this
program.
