# Permission probe findings (AGX-R34)

> **Status: NOT RUN.** A human operator fills this in by following
> `docs/operator-permission-probe.md`. Until this file records a passing result, the
> run-orchestration slice (shell 03) must not start.

- Operator:
- Date:
- `claude --version`:
- Engine commit:
- Total probe spend (USD):

## Flags

Pre-probe observation (2026-09-29, zero spend): `claude --help` on 2.1.284 lists
`--output-format`, `--permission-mode`, `--model`, `--allowedTools`, `--disallowedTools`,
`--max-budget-usd`, `--tools`, `--setting-sources` and `--strict-mcp-config`, but **not**
`--max-turns`.
The executor spike used `--max-turns 10` successfully on 2.1.190, so the max-turns step below must
show whether it is still honored.

- `flags` result:

## Edit run

- Allowlist used (default, or the one permitted widening):
- Prompt read from stdin (worker acted on the milestone):
- `run.status` / `failureClass`:
- `verification.accepted` and reasons:
- `permission_denials`:
- Cost / turns / duration:

## Confinement (negative)

- `verdict` (pass / escape / inconclusive / not-run):
- `secretLeaked` / `escapeFileCreated` / `outsideFileCreated` / `claudeSettingsCreated` / `nestedClaudeCreated`:
- `denialEvidence` (`secretReadDenied` / `escapeWriteDenied` / `outsideWriteDenied`):
- `permission_denials` (tools and inputs):
- Verdict (pass, or escape → stop and redesign):
- In-worktree out-of-scope write (`otherFileCreated`):

## Envelopes

Replace the `_synthetic` fake-worker envelopes in `tests/fixtures/claude-worker/envelopes/` with
these where captured, and tighten the executor's `/budget/i` match to the recorded string.

- max-turns: `subtype`, `is_error`, `terminal_reason`, exit code:
- budget stop: `subtype`, `is_error`, `terminal_reason`, exit code (or "not triggered"):
- permission denial (from the confinement run):

## Side effects

- Did subscription auth and headless edits work with `--setting-sources project --strict-mcp-config`?
- Files created in the worktree outside `site.json`/`SITE`:

## Cost and timing

- Edit run cost / turns / duration:
- Confinement run cost / turns / duration:

## Decisions for shell 03

- Per-action cap (USD):
- Action timeout (ms):
- Run wall-clock (ms):
- Engine-owned `--settings` (beyond the pinned setting sources): none / contents:
- Out-of-scope in-worktree change fails the run: yes / no (evidence only):
- Allowlist widened: no / yes (the rules):
- Probe result: PASS / FAIL (redesign)
