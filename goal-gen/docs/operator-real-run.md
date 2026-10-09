# Operator runbook — approval-gated real run (VS layer 4a)

> **Human operator only.** Never run any step of this runbook from CI or an autonomous agent
> session. The approval step refuses without a controlling terminal by design. Nothing here ever
> uses `bypassPermissions`.

Decision: [ADR-0020](decisions/0020-approval-gated-real-execution.md)
(challenge derivation and `--state-dir` superseded by
[ADR-0021](decisions/0021-fresh-approval-challenge-and-no-state-dir.md)). Spec:
[`plans/specs/approval-gated-real-execution.md`](../plans/specs/approval-gated-real-execution.md)
(AGX-R1..R35). Status: steps 1–3 are implemented — step 3 is `run --protocol v2 --executor
agx-claude-code`, released as goal-gen 0.3.0. Step 4 is yours: reproduce the bundle and decide. CI
exercises the whole flow only as a zero-spend [rehearsal](#rehearsal-fake-worker-zero-spend) with a
fake worker; the production command below is never run there.

All paths are operator-supplied arguments; the engine has no `runtime/` concept. In the Yellow
Harness workspace, put approvals, bundles and ledgers under `runtime/`.

## Prerequisites

- A validated `approved-implementation` request file (`request validate <file>`).
- An engine built from a released tarball (the live acceptance run, AGX-R35, uses the release).
- Caps inside the ADR-0010 defaults. The per-action cap and timeouts for `config-repair` come from
  the AGX-R34 permission probe ([`operator-permission-probe.md`](operator-permission-probe.md)),
  which passed (`tests/spikes/permission-probe-findings.md`):
  - Per-action cap: **$0.50** recommended. `--per-action-usd` and `--total-usd` are always
    required, so spend is typed explicitly. A budget stop can overshoot its cap by up to one turn.
  - Action timeout: **120000 ms** and run wall-clock: **600000 ms** are the manifest defaults.
    `--action-timeout-ms` and `--run-wall-clock-ms` accept any value up to ADR-0010's ceilings
    (10 min per action, 60 min per run).

## 1. Render the manifest (zero spend)

```bash
goal-gen run manifest <request.json> --profile config-repair@2 \
  --per-action-usd 0.5 --total-usd <usd> --auth-mode subscription \
  --max-turns <n> --allowed-tool 'Read(./**)' --allowed-tool 'Edit(./site.json)' \
  --allowed-tool 'Edit(./SITE)' --allowed-tool 'Write(./site.json)' --allowed-tool 'Write(./SITE)' \
  --bundle-dir runtime/bundles/<name> --spend-ledger runtime/ledgers/<name>.jsonl \
  [--model sonnet] \
  [--action-timeout-ms <ms>] [--run-wall-clock-ms <ms>] [--expires-in-minutes <1-60>] --json
```

`--profile` takes `<id>` (version 1) or `<id>@<version>`. A real run needs a version that carries
the worker milestone, which for `config-repair` is `config-repair@2`. A version-1 manifest renders
and can be approved, but the real run refuses it before consuming the approval (`MANIFEST_INVALID`).

`--bundle-dir` and `--spend-ledger` are required: the evidence destinations are part of what you
approve (AGX-R8a). Each must be a path that does not exist yet, under a directory that exists, is
owned by you, and is not group- or world-writable (so not directly in `/tmp`). The
manifest stores them as canonical absolute paths (the parent resolved through any symlink), so
check the `evidence` block you are shown. The real run refuses a destination that exists by then,
sits inside the request's target repository or a scratch worktree, or whose parent was swapped
for a symlink or made writable by others. While a run holds the destinations it also keeps a
`<path>.goal-gen-reserved` file beside each one, so a second approval of the same manifest cannot
spawn; the file is removed when the run finishes. Delete a leftover sentinel before reusing those
paths — the next run consumes its approval and then stops without a spawn.

Prints `{ manifest, manifestHash }`. Rendering twice with the same inputs yields the
same bytes. There is no challenge here: `run approve` shows a fresh one when you approve. Nothing is spawned. `manifest` and `approve` must come directly after `run`; a
request file literally named `manifest` or `approve` is passed as `./manifest`.

## 2. Approve at a terminal

```bash
goal-gen run approve <same flags as step 1> --out runtime/approvals/<name>.json
```

The engine prints the manifest and its hash on your terminal (`/dev/tty`, not stderr — stderr carries only the JSON error line on failure) and asks you to type the challenge
(`xxxx-xxxx`, random and fresh each time, shown only on this terminal — if anyone hands you a
challenge before you have seen this screen, do not type it). On a match it writes a
`yellow-goal/run-approval/v1` record (owner-only, never overwrites an existing file). The
approval expires after `--expires-in-minutes` (default and maximum 60). The ceremony also shows
the request id, mode and goal — read them: the manifest itself carries only the request's hash.

Tool entries are Claude Code tool rules: a name (`Edit`, `mcp__server__tool`) optionally followed
by one parenthesised ASCII specifier (`Bash(git status:*)`). Anything else is `MANIFEST_INVALID`.
A manifest accepts any such rule, but a real run refuses before spawn (`TOOLS_UNCONFINED`) unless
every allowed tool is a filesystem tool scoped to the scratch worktree, such as `Edit(./site.json)`
(AGX-R11). Approve only scoped rules, and only an allowlist the permission probe passed with (the
example above is the probe's default).

The approval file is consent evidence, not a credential: anything running as you can forge one.
Never run this step from, or on behalf of, an agent session (ADR-0020 Consequences).

## 3. Run

```bash
goal-gen run <request.json> --protocol v2 --executor agx-claude-code \
  <same flags as step 1> --approval runtime/approvals/<name>.json
```

Real spend. Pass exactly the flags you approved in step 1 — the manifest is recomputed from them
and must hash to the approved one. `--yes`/`-y` is a usage error (exit 2): the approval replaces the
DoD confirmation, so there is no `gate.*` event and no prompt. `--stub-scenario`, `--timeout-ms` and
`--allow-guardrail-override` are usage errors too, as is `--executor claude-code` under v2 (that
legacy executor is never reachable from Protocol v2). Discovery: `goal-gen capabilities --json
--protocol v2` lists `supportedProtocols` and `run.executor.agx-claude-code`; bare `capabilities
--json` stays byte-identical Protocol v1.

stdout is a run-event/v1 JSON Lines stream, and only after the approval is consumed:

| Event | When | Payload |
|---|---|---|
| `run.start` | once, right after consumption | `protocolVersion` (v2), `executor` `agx-claude-code`, `simulation: false`, `targetRepository`, `targetRepositoryHonored: false`, `approvalId`, `manifestHash`, `profile {id, version, digest}`, `caps` |
| `run.spend` | once per metered worker attempt | `approvalId`, `costUsd` (or `null`), `turns`, `durationMs`, `exitClass` |
| `run.summary` | once, terminal | `outcome` = `verified` (`bundleDir`, `outOfScopeChanges`) · `verification-rejected` (`bundleDir`, `reasons`, `outOfScopeChanges`) · `worker-failed` (`reason`, `evidence`; no bundle) |

A `refused` invocation emits **no events**: stdout stays empty and stderr carries one
`{"error":{"code","message","approvalId"?}}` line (`approvalId` only when a valid approval had been
read, e.g. `AUTH_MODE_MISMATCH`, `APPROVAL_CONSUMED`). Exit codes: `0` verified (awaiting you,
never accepted); `1` refusal, `worker-failed` (`RUN_WORKER_FAILED`), `verification-rejected`
(`RUN_VERIFICATION_REJECTED`) or a broken stdout (`RUN_STDOUT_TRANSPORT_FAILED`); `2` usage.

The engine runs, in this order:

1. Recompute the manifest from the invocation's flags and verify the approval against it.
2. Refuse a mismatched credential (`AUTH_MODE_MISMATCH`), an unscoped allowlist
   (`TOOLS_UNCONFINED`) or a bad evidence destination (`EVIDENCE_DESTINATION_REFUSED`).
3. Consume the approval (creating `$XDG_STATE_HOME/yellow-goal/consumed/<approvalId>`, default
   under `~/.local/state/yellow-goal/`). Copying the approval file does not make it reusable.
4. Reserve the evidence destinations by exclusively creating `<path>.goal-gen-reserved` beside the
   bundle directory and the spend ledger (sorted path order). The reservation is released when the
   run finishes. A second approval of the same manifest that loses it does not spawn
   (`worker-failed`, `evidence-destination-refused`); that approval is already consumed. A leftover
   sentinel from a crash does the same until you delete it.
5. Seed a scratch worktree from the profile's base files. The request's target repository is never
   touched.
6. Run exactly one worker attempt on the profile's milestone, bounded by the action timeout, the
   run wall-clock and cancellation. Each kills the worker's whole process group.
7. Write one entry to the spend ledger (`yellow-goal/real-run-spend/v1` JSON Lines: `approvalId`,
   `model`, `costUsd` or `null`, `turns`, `durationMs`, `exitClass`, `startedAt`, `endedAt`).
   `durationMs` is the worker-reported duration when the result envelope carried one, else the
   engine-measured time.
8. Read only the allowed paths into the candidate. A symlink, FIFO, device or oversize entry is
   never read and fails the run.
9. Judge the candidate with `acceptance verify-candidate` for the approved profile version, and
   write the bundle to `--bundle-dir`.

From consumption until the run ends, SIGHUP, SIGINT and SIGTERM stop the worker (outcome
`worker-failed`, `cancel`) instead of killing the engine; a cancel that arrives before
consumption is refused (`RUN_CANCELLED`) and leaves the approval usable.

It ends in exactly one outcome:

- `refused`: nothing spawned or metered. The approval stays unconsumed, except for
  `APPROVAL_CONSUMED`.
- `worker-failed`: the worker failed (its failure class, or `wall-clock`, `cancel`,
  `worker-not-terminated`), produced an unsafe candidate (`unsafe-allowed-path`,
  `non-utf8-candidate`), or the engine could not finish after consumption
  (`evidence-write-failed`, `evidence-destination-refused`, `engine-error`). A cancel or wall-clock
  expiry before the worker started spawns nothing and writes no ledger entry. The wall-clock and
  cancellation also cover candidate extraction and verification: if one lands meanwhile, the
  outcome is `worker-failed` (`wall-clock` / `cancel`) with the candidate kept as evidence, and no
  bundle is written.
- `verification-rejected`: the verifier rejected the candidate; the bundle holds the reasons.
- `verified`: the verifier accepted the candidate, which now awaits your decision.

Files the worker changed outside the allowed paths are listed in `outOfScopeChanges` as evidence.
They are never part of the candidate and never fail the run. The worker's own exit status and
narrative never decide success. Nothing is committed, merged or pushed.

## 4. Reproduce and accept

```bash
goal-gen acceptance reproduce <bundle-dir> --json
```

Run it in a fresh process against the `bundleDir` from `run.summary`. It replays the recorded
candidate and must reproduce the engine's decision (`decision.accepted: true` for a `verified`
run). Then read the diff yourself and record your accept decision as evidence (AGX-R20). No engine
verb ever marks a real-run candidate accepted, and nothing is committed, merged or pushed for you.

## Refusal codes

| Code | Meaning |
|---|---|
| `MANIFEST_INVALID` | A manifest input is out of range (caps above ADR-0010 defaults, expiry above 60 min, tool in both lists, an unknown profile version, an evidence destination whose parent cannot be resolved, …), or the approved profile version has no worker milestone |
| `APPROVAL_TTY_REQUIRED` | `run approve` was not run with stdin and stderr attached to a terminal; nothing written |
| `APPROVAL_DECLINED` | The typed challenge did not match (or input ended); nothing written |
| `APPROVAL_OUT_EXISTS` | The `--out` path already exists (a symlink counts); approvals are never overwritten |
| `APPROVAL_OUT_UNWRITABLE` | The approval could not be written to `--out` (missing directory, permissions, disk full); nothing kept |
| `APPROVAL_MISSING` | The approval file does not exist |
| `APPROVAL_INVALID` | The approval file is not a well-formed, internally consistent `run-approval/v1` record, or is dated in the future |
| `APPROVAL_ENGINE_MISMATCH` | The approval was minted by a different engine version |
| `APPROVAL_HASH_MISMATCH` | The invocation's manifest differs from the approved one |
| `APPROVAL_EXPIRED` | The approval's `expiresAt` has passed |
| `APPROVAL_EXPIRED` (at consume) | The approval lapsed between verification and consumption; not spent |
| `APPROVAL_CONSUMED` | The approval (by `approvalId`, even via a copied file) was already used |
| `APPROVAL_STATE_UNAVAILABLE` | The consumption-marker directory could not be read or written; the run is refused |
| `AUTH_MODE_MISMATCH` | The environment's credential contradicts the manifest's auth mode: `ANTHROPIC_API_KEY` is set but the auth mode is not `api-key` (it would silently override the subscription), or it is unset under `api-key` (the CLI would silently fall back to the subscription); or `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL` or a `CLAUDE_CODE_USE_*` provider toggle is set, which would substitute another credential or provider. Nothing spawned |
| `EVIDENCE_DESTINATION_REFUSED` | A bundle or ledger destination already exists, is inside the request's target repository or a real-run scratch worktree, or its parent now resolves through a symlink, is owned by another user, or is group- or world-writable. Checked before consumption (outcome `refused`; nothing spawned). The same checks run again once the scratch worktree exists and just before each evidence file is written; failing them then is `worker-failed` with reason `evidence-destination-refused` (the approval is already consumed; a verified candidate is kept in the outcome). After consumption the engine also reserves each destination (`<path>.goal-gen-reserved`); losing that reservation to a concurrent approval of the same manifest, or finding a leftover sentinel, is the same `worker-failed` reason and does not spawn |
| `EVIDENCE_WRITE_FAILED` | The spend ledger or bundle could not be written after the worker ran (including a ledger destination that failed its re-check just before the write); reported as a `worker-failed` outcome (`evidence-write-failed`) with the spend so far, and with the candidate and verifier decision when the bundle was the failed write |
| `RUN_CANCELLED` | The run was cancelled before the approval was consumed; the approval stays usable and nothing spawned |
| `TOOLS_UNCONFINED` | An allowed tool is not a filesystem tool path-scoped to the scratch worktree (`Read`/`Edit`/`Write`/`MultiEdit`/`Glob`/`Grep` with a relative in-worktree specifier such as `Edit(./site.json)`, built only from letters, digits, `.`, `_`, `-`, `*` and `/`); `Bash`, unscoped, absolute, `~`, `..`, whitespace and multi-rule specifiers are refused, as are an empty allowlist and write rules naming `.git`, `.claude`, `.mcp.json`, `CLAUDE.local.md` (any case) or a dotfile wildcard. Nothing spawned |
| `USAGE_ERROR` (real run) | `--yes`/`-y`, `--stub-scenario`, `--timeout-ms` or `--allow-guardrail-override` with `agx-claude-code`; `agx-claude-code` without `--protocol v2`; a missing `--approval`; manifest flags or `--approval` on a stub or legacy run; `--executor claude-code` under `--protocol v2`. Exit 2, nothing read or spawned |
| `RUN_WORKER_FAILED` | The run ended `worker-failed` (stderr after the terminal `run.summary`); the message names the reason. Exit 1 |
| `RUN_VERIFICATION_REJECTED` | The verifier rejected the candidate (stderr after the terminal `run.summary`); the bundle holds the reasons. Exit 1 |
| `RUN_STDOUT_TRANSPORT_FAILED` | stdout could not carry the event stream (closed pipe, overflow); the engine is aborted. Exit 1 |

## Rehearsal (fake worker, zero spend)

CI proves this runbook end to end without a real `claude`: `bash scripts/operator-real-run-recipe.sh`
(`npm run test:operator-recipe:real-run`) extracts the `recipe:`-marked fences below and runs them
from `goal-gen/` against the test-only harness and the fake worker. The harness mints its approvals
through the injected-terminal seam — CI never runs `run approve`, and these fences never touch the
production real-run path. They are for rehearsing and for CI; as an operator you run steps 1–4
above instead. `REH` is a scratch directory you own that is not group- or world-writable.
`harness` is the test-only wrapper (the script defines it read-only; by hand, define it first):

```bash
harness() { node node_modules/tsx/dist/cli.mjs tests/harness/real-run-harness.ts "$@"; }
```

<!-- recipe:rehearsal-setup -->
```bash
FLAGS=(--profile 'config-repair@2' --model sonnet --max-turns 8 --per-action-usd 0.5 --total-usd 5
  --auth-mode subscription --allowed-tool 'Edit(./SITE)' --allowed-tool 'Edit(./site.json)'
  --allowed-tool 'Read(./**)')
cat > "$REH/request.json" <<'JSON'
{"schemaVersion":"yellow-goal/request/v1","requestId":"req-rehearsal-001","target":{"repository":"octocat/example","ref":"main"},"intent":{"goal":"Rehearse the approval-gated real run with the fake worker."},"mode":"approved-implementation","pack":"repository-goal-packet@1","orchestration":{"permissionProfile":"implement","orchestrationProfile":"claude-fable-opus-sonnet@1"},"constraints":{"readOnlyTarget":false,"allowTargetEdits":true}}
JSON
"$BIN" request validate "$REH/request.json" > "$REH/validate.json"
```

Each rehearsal run mints a fresh approval (it is bound to the run's own evidence paths), then runs
the production argv through the harness. `--record` appends one line per fake-worker invocation.

<!-- recipe:rehearsal-success -->
```bash
RUNFLAGS=("${FLAGS[@]}" --bundle-dir "$REH/b-success" --spend-ledger "$REH/l-success.jsonl")
harness --mode mint-approval "$REH/request.json" "${RUNFLAGS[@]}" --out "$REH/a-success.json" > "$REH/mint-success.json"
rc=0
harness --mode protocol-v2 "$REH/request.json" --protocol v2 --executor agx-claude-code \
  "${RUNFLAGS[@]}" --approval "$REH/a-success.json" \
  --scenario success --record "$REH/worker.jsonl" --state-dir "$REH/state" \
  > "$REH/out-success.jsonl" 2> "$REH/err-success.txt" || rc=$?
echo "$rc" > "$REH/exit-success"
```

<!-- recipe:rehearsal-wrong-repair -->
```bash
RUNFLAGS=("${FLAGS[@]}" --bundle-dir "$REH/b-wrong" --spend-ledger "$REH/l-wrong.jsonl")
harness --mode mint-approval "$REH/request.json" "${RUNFLAGS[@]}" --out "$REH/a-wrong.json" > "$REH/mint-wrong.json"
rc=0
harness --mode protocol-v2 "$REH/request.json" --protocol v2 --executor agx-claude-code \
  "${RUNFLAGS[@]}" --approval "$REH/a-wrong.json" \
  --scenario wrong-repair --record "$REH/worker.jsonl" --state-dir "$REH/state" \
  > "$REH/out-wrong.jsonl" 2> "$REH/err-wrong.txt" || rc=$?
echo "$rc" > "$REH/exit-wrong"
```

<!-- recipe:rehearsal-budget-stop -->
```bash
RUNFLAGS=("${FLAGS[@]}" --bundle-dir "$REH/b-budget" --spend-ledger "$REH/l-budget.jsonl")
harness --mode mint-approval "$REH/request.json" "${RUNFLAGS[@]}" --out "$REH/a-budget.json" > "$REH/mint-budget.json"
rc=0
harness --mode protocol-v2 "$REH/request.json" --protocol v2 --executor agx-claude-code \
  "${RUNFLAGS[@]}" --approval "$REH/a-budget.json" \
  --scenario budget-stop --record "$REH/worker.jsonl" --state-dir "$REH/state" \
  > "$REH/out-budget.jsonl" 2> "$REH/err-budget.txt" || rc=$?
echo "$rc" > "$REH/exit-budget"
```

A spent approval is refused with no events and no second worker invocation, even from the same flags:

<!-- recipe:rehearsal-reused-approval -->
```bash
RUNFLAGS=("${FLAGS[@]}" --bundle-dir "$REH/b-success" --spend-ledger "$REH/l-success.jsonl")
rc=0
harness --mode protocol-v2 "$REH/request.json" --protocol v2 --executor agx-claude-code \
  "${RUNFLAGS[@]}" --approval "$REH/a-success.json" \
  --scenario success --record "$REH/worker.jsonl" --state-dir "$REH/state" \
  > "$REH/out-reused.jsonl" 2> "$REH/err-reused.txt" || rc=$?
echo "$rc" > "$REH/exit-reused"
```

Finally, reproduce the verified bundle in a fresh process (step 4):

<!-- recipe:rehearsal-reproduce -->
```bash
"$BIN" acceptance reproduce "$REH/b-success" --json > "$REH/reproduce.json"
```
