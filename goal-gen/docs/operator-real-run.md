# Operator runbook — approval-gated real run (VS layer 4a)

> **Human operator only.** Never run any step of this runbook from CI or an autonomous agent
> session. The approval step refuses without a controlling terminal by design. Nothing here ever
> uses `bypassPermissions`.

Decision: [ADR-0020](decisions/0020-approval-gated-real-execution.md). Spec:
[`plans/specs/approval-gated-real-execution.md`](../plans/specs/approval-gated-real-execution.md)
(AGX-R1..R35). Status: **skeleton** — steps 1–2 are implemented; steps 3–4 land with later
slices.

All paths are operator-supplied arguments; the engine has no `runtime/` concept. In the Yellow
Harness workspace, put approvals, bundles and ledgers under `runtime/`.

## Prerequisites

- A validated `approved-implementation` request file (`request validate <file>`).
- An engine built from a released tarball (the live acceptance run, AGX-R35, uses the release).
- Caps inside the ADR-0010 defaults. The per-action cap and timeouts for `config-repair` come from
  the AGX-R34 permission probe.

## 1. Render the manifest (zero spend)

```bash
goal-gen run manifest <request.json> --profile config-repair \
  --per-action-usd <usd> --total-usd <usd> --auth-mode subscription \
  --max-turns <n> --allowed-tool Edit --allowed-tool Read [--model sonnet] \
  [--action-timeout-ms <ms>] [--run-wall-clock-ms <ms>] [--expires-in-minutes <1-60>] --json
```

Prints `{ manifest, manifestHash, challenge }`. Rendering twice with the same inputs yields the
same bytes. Nothing is spawned. `manifest` and `approve` must come directly after `run`; a
request file literally named `manifest` or `approve` is passed as `./manifest`.

## 2. Approve at a terminal

```bash
goal-gen run approve <same flags as step 1> --out runtime/approvals/<name>.json
```

The engine prints the manifest and its hash on your terminal (`/dev/tty`, not stderr — stderr carries only the JSON error line on failure) and asks you to type the challenge
(`xxxx-xxxx`, derived from the manifest hash). On a match it writes a
`yellow-goal/run-approval/v1` record (owner-only, never overwrites an existing file). The
approval expires after `--expires-in-minutes` (default and maximum 60). The ceremony also shows
the request id, mode and goal — read them: the manifest itself carries only the request's hash.

Tool entries are Claude Code tool rules: a name (`Edit`, `mcp__server__tool`) optionally followed
by one parenthesised ASCII specifier (`Bash(git status:*)`). Anything else is `MANIFEST_INVALID`.

The approval file is consent evidence, not a credential: anything running as you can forge one.
Never run this step from, or on behalf of, an agent session (ADR-0020 Consequences).

## 3. Run (not yet implemented)

Placeholder — the real-run verb (`run --protocol v2 --executor agx-claude-code --profile … --approval
<path> --bundle-dir <dir>`) lands with a later slice. It verifies the approval, consumes it
(creating `$XDG_STATE_HOME/yellow-goal/consumed/<approvalId>`, default under
`~/.local/state/yellow-goal/`), spawns exactly one worker, and ends in one outcome. Copying the
approval file does not make it reusable.

## 4. Reproduce and accept (not yet implemented)

Placeholder — `acceptance reproduce <bundle-dir>` in a fresh process, then the operator's final
accept decision recorded as evidence (AGX-R20). No engine verb ever marks a real-run candidate
accepted.

## Refusal codes

| Code | Meaning |
|---|---|
| `MANIFEST_INVALID` | A manifest input is out of range (caps above ADR-0010 defaults, expiry above 60 min, tool in both lists, …) |
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
