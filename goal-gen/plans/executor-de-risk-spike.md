# Feature: Executor De-Risk Spike (`tests/spikes/executor-spike.ts`)

> Source brainstorm: `docs/brainstorms/2026-06-23-next-work-item-brainstorm.md` (Status: Decided).
> Detail level: **COMPREHENSIVE** — low scope/risk (throwaway, isolated) but high *technical* uncertainty; the whole point is de-risking unknown headless `claude -p` behavior before a production interface is committed.

## Overview

A single throwaway TypeScript/Node script that proves the executor + ground-truth
verification mechanics **end-to-end** against the host `claude` CLI, in full
isolation, then freezes the concrete learnings into
`tests/spikes/executor-spike-findings.md`. The findings doc becomes the spec
input for the later production `Executor` implementation
(`.claude/specs/executor-router.md`).

This is **Approach A** from the brainstorm (focused spike, zero
production-interface commitment). Approaches B (spike + interface sketch) and C
(spike + extractor JSON probe) were rejected as premature / scope-diluting.

## Problem Statement

### Current pain points
- M0 (deterministic A\* GOAP planner) ships green at the 52/52 eval gate
  (`backend/src/planner/{plan,simulate,types}.ts`). The next M1 critical-path seam
  is **execute → verify**, and it is the highest-unknown component.
- The production `Executor` contract already exists on paper
  (`.claude/specs/executor-router.md`: `RunContext` / `Executor` / `AgentRun`),
  but **no code exists yet** (`backend/src/executors/` is empty). Designing that
  implementation before observing real `claude -p` output risks baking in a
  wrong contract (e.g. wrong cost field, wrong exit-code semantics, wrong
  failure surfacing).

### Why de-risk first
The brainstorm's decision constraint is **"de-risk first."** The unknowns are
mechanical and only answerable by running the real CLI: exact flags, the
`--output-format json` envelope shape, exit-code semantics, where cost/usage
lives, worktree create/teardown that actually works headless, and subscription
auth gotchas. A throwaway spike answers all of them at near-zero risk.

### Value
- Turns 4 open unknowns (brainstorm §Risks) into documented facts.
- Produces a reproducible findings artifact that directly seeds the production
  `claude-code` adapter and de-risks the `AgentRun` field mapping.
- Exercises and validates ADR-0009 worktree create/teardown in practice.

## Proposed Solution

### High-level architecture
A standalone ESM script (`tests/spikes/executor-spike.ts`), run manually via
`node --experimental-strip-types`, that walks the brainstorm flow:
**preflight → scratch repo + worktree → headless `claude -p` run → parse envelope →
ground-truth capture → verify → teardown → findings summary**, with
teardown guaranteed in a `finally` block.

### Key design decisions (locked)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Raw `claude` CLI via `node:child_process`** — *not* the Agent SDK. | The spec commits to "spawn the CLI as a subprocess"; the brainstorm says "against the host `claude` CLI." The SDK adds a dependency and proves the wrong thing for a zero-commitment spike. Keeps `devDependencies` untouched. SDK-vs-CLI is itself a finding to record. |
| D2 | **No new npm dependencies.** Built-in `node:child_process`/`fs`/`os`/`path` + `zod` (already a dep). | Throwaway script; `@types/node` is installed; `tsx`/`execa` are **not** and would add network/dep cost. |
| D3 | **`--output-format json`** (single object), not `stream-json`. | Brainstorm + spec both specify `json`; simplest to parse. `stream-json` is noted as the production live-view choice (a finding), not implemented here. |
| D4 | **zod-validate the envelope** (`.passthrough()`, `.safeParse`). | House pattern (ADR-0006). Unknown fields tolerated; parse failure routes to a `PARSE_FAIL` path that preserves raw evidence rather than crashing. |
| D5 | **Hermetic verify via `node --test add.test.mjs`** on a `node:test` file. | Zero-install temp repo; instantly verifiable; pinned filename + pass-count assertion defeats the 0-exit/0-tests false-pass. |
| D6 | **Ground-truth oracle = `git status --porcelain` non-empty OR HEAD moved from `INIT_SHA`** (shipped). | Catches committed, staged, **and untracked** changes with no index side-effects. The spike proved plain `git diff <SHA>` silently misses the agent's untracked new files — findings §5. |
| D7 | **Cut the proto-`AgentRun` struct mapping.** Print a labeled findings summary instead. | Avoids premature interface commitment (brainstorm rejects Approach B). The mapping is the *next* session's job; the findings doc describes it in prose. |
| D8 | **Fail-loud preflight aborts** on `claude` absent, `ANTHROPIC_API_KEY` set, or running as root. | The spike must exercise the *subscription, non-root* path the production host uses; otherwise findings are misleading. |

### Trade-offs considered
- **SDK vs CLI (D1):** SDK gives typed results for free but is a dependency and
  tests SDK plumbing, not the CLI the spec targets. CLI wins for a de-risk spike.
- **`json` vs `stream-json` (D3):** `stream-json` is what production wants for the
  live view, but it's a moving target to parse; the spike documents it as
  follow-up rather than implementing both.
- **Standalone script vs vitest test:** `vitest.config.ts` only matches
  `tests/**/*.test.ts`, so naming the file `executor-spike.ts` (not `.test.ts`)
  deliberately keeps it **out** of `npm test`/`npm run eval` — it calls a live
  LLM and must never run in CI gates. It is run manually on the host.

## Implementation Plan

### Phase 0: Scaffold + preflight
- [ ] 0.1 Create `tests/spikes/` and `tests/spikes/executor-spike.ts` (ESM,
      `import type` for type-only imports, `node:` builtins — must compile under
      `strict` + `verbatimModuleSyntax`, since `tsconfig.json` `include` covers
      `tests/**/*.ts`).
- [ ] 0.2 Preflight checks, each aborting non-zero with an actionable message:
      - `claude` resolvable on `PATH` → capture `claude --version` (recorded in
        findings). Absent → exit with "install/login `claude` first" (spec
        "CLI not installed → fail fast, don't hang").
      - `process.getuid?.() === 0` → abort: "`bypassPermissions` is blocked as
        root; run the spike as a non-root user." (Override: `SPIKE_ALLOW_ROOT=1`
        to deliberately observe the root-failure behavior — and record it.)
      - `process.env.ANTHROPIC_API_KEY` set → abort: "unset `ANTHROPIC_API_KEY`
        so the spike exercises **subscription** auth (the production path)."

<!-- deepen-plan: codebase -->
> **Codebase:** `.claude/specs/executor-router.md` (line 26) lists
> `ANTHROPIC_API_KEY` as a *legitimate fallback* for the production `claude-code`
> adapter. The spike deliberately **aborts** on it instead, to prove the
> subscription path the host actually uses. Record this intentional
> spike-vs-production divergence in the findings doc so the later Executor session
> knows the API-key fallback path was *not* exercised here.
<!-- /deepen-plan -->
- [ ] 0.3 Declare `tmpDir` / `worktreePath` / capture buffers in **outer scope**
      (before the `try`) so `finally` can always clean up (Edge Case #E9).

### Phase 1: Scratch repo + worktree (exercises ADR-0009)
- [ ] 1.1 `fs.mkdtemp(path.join(os.tmpdir(), 'executor-spike-'))` → unique temp
      dir each run (guarantees no branch-name collision across reruns).
- [ ] 1.2 Run all `git` with config isolation: env
      `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null` (no inherited
      hooks / GPG signing / `includeIf`), plus `-c user.name=… -c user.email=…`
      (Edge Case #E8). `git init` → write a seed file → `git add -A` →
      `git commit` → **capture the initial commit SHA** (`INIT_SHA`).
- [ ] 1.3 `git worktree add <tmp>/wt -b spike-run` (repo has ≥1 commit, so this
      succeeds). Record the exact create command for findings. `worktreePath = <tmp>/wt`.

### Phase 2: Headless `claude -p` execution
- [ ] 2.1 Build the prompt (very explicit, pinned filenames):
      > "In the current directory create exactly two files. `add.mjs`: export a
      > pure function `add(a, b)` returning their numeric sum. `add.test.mjs`: a
      > test using Node's built-in `node:test` and `node:assert/strict` that
      > imports `add` from `./add.mjs` and asserts `add(2, 3) === 5`. Do not
      > install any dependencies and do not run git. Then run `node --test
      > add.test.mjs` to confirm it passes."
- [ ] 2.2 Baseline invocation (core flags only — every flag here is well-attested):
      `claude -p "<prompt>" --output-format json --permission-mode bypassPermissions --model haiku --max-turns 10`
      Spawn via `child_process.spawn` with `cwd: worktreePath`, `stdio: ['ignore','pipe','pipe']`,
      env = `{ ...process.env }` (subscription creds read from `~/.claude/.credentials.json`).
      **Record the exact `argv` array** for findings (Nice-to-have #16).
- [ ] 2.3 Collect stdout/stderr by accumulating `data` chunks (no fixed
      `maxBuffer` cap → no pipe-buffer deadlock, Edge Case #E13).
- [ ] 2.4 Wall-clock timeout: **120 s** total → `child.kill('SIGTERM')`, then
      `SIGKILL` after a **10 s** grace (matches spec kill behavior). Overridable
      via `SPIKE_TIMEOUT_MS`. Record observed `duration_ms` from the envelope.
- [ ] 2.5 **Optional guardrail-flag layer** (documented, off by default): a
      `SPIKE_EXTRA_FLAGS` toggle to also pass `--max-budget-usd 1.00`
      `--no-session-persistence`. These are flagged version-sensitive — **confirm
      against `claude --help` on the host before enabling** (Edge Case #E12).

### Phase 3: Parse + ground-truth + verify
- [ ] 3.1 Check **exit code first**. Then parse stdout as JSON and
      zod-`safeParse` against the envelope schema (Technical Specs below). On any
      JSON/zod failure → record raw stdout+stderr verbatim, mark `PARSE_FAIL`,
      exit non-zero (Edge Case #E3). Extract `subtype`, `is_error`, `result`,
      `error?`, `total_cost_usd`, `usage`, `num_turns`, `session_id`,
      `duration_ms`.

<!-- deepen-plan: external -->
> **Research:** Treat process exit code as necessary-but-not-sufficient. Success =
> exit 0 **AND** `is_error === false` **AND** `subtype === 'success'`. The CLI can
> exit **0 while setting `is_error: true`** (a max-budget stop yields
> `subtype: "error_max_budget_usd"`); sources disagree on the exact exit code for
> budget/turn limits, so the spike should **record the observed exit code** for that
> case as a finding. Parse `usage.*` defensively (`?? 0`) — cache token fields may
> be absent. `subtype` is an open string (no published schema) → keep it
> `z.string()`. Keep `--permission-mode bypassPermissions`: `--permission-mode auto`
> is non-portable across CLI builds. Sources: code.claude.com/docs/en/agent-sdk,
> claude-code issues #54080 / #46792.
<!-- /deepen-plan -->
- [ ] 3.2 **Ground truth (invariant #2):** `git -C <wt> status --porcelain`
      non-empty **OR** `git -C <wt> rev-parse HEAD` ≠ `<INIT_SHA>` → real change
      (shipped oracle; plain `git diff <SHA>` misses untracked files — findings §5).
      **Empty diff → mark `GROUND_TRUTH_FAIL`, exit non-zero** even if the CLI
      exited 0 — "the agent ran but changed nothing; never trust a declared
      effect" (Edge Case #E1).

<!-- deepen-plan: external -->
> **Research (refines the step above):** Prefer **`git -C <wt> diff --quiet
> <INITIAL_SHA>`** (exit code is the boolean: non-zero ⇒ changed) over `git add -A
> && git diff --cached <SHA>`. The staging approach mutates the index and is
> sensitive to `assume-unchanged`; `git diff <SHA>` reads the working tree directly
> with no side effects and catches the agent's changes whether **committed, staged,
> or unstaged**. Capture `INITIAL_SHA=$(git rev-parse HEAD)` before the run; also
> capture the full patch `git diff <INITIAL_SHA>` for the findings doc. Prior art:
> SWE-bench, OpenHands stop-hook diff, allenai/agent-eval `git diff --quiet`.
>
> ⚠ **SPIKE RESULT (2026-06-25) — this annotation was WRONG.** The real agent
> creates NEW UNTRACKED files and does not commit, and `git diff <SHA>` /
> `--quiet` **ignore untracked files** → false `GROUND_TRUTH_FAIL`. The shipped
> spike uses `git status --porcelain` non-empty **OR** moved HEAD instead. See
> `tests/spikes/executor-spike-findings.md` §5.
<!-- /deepen-plan -->
- [ ] 3.3 **Verify (invariant #3):** run `node --test add.test.mjs` in the
      worktree (via `--test-reporter tap`). Pass iff exit 0 **AND** the TAP summary
      shows `# tests N` with N ≥ 1 **AND** `# fail 0`. A 0-exit/0-tests run is a
      **fail**, not a pass (Edge Case #E5).
      Capture verify stdout/exit for findings.

<!-- deepen-plan: external -->
> **Research (refines the step above):** `node --test`'s **default reporter is
> `spec`**, which is not machine-parseable, and a run that discovers **zero tests
> still exits 0**. Run **`node --test --test-reporter tap add.test.mjs`** and assert
> exit 0 **AND** `# tests` ≥ 1 **AND** `# fail 0` (parse the TAP summary; `# tests`
> is the reliable "did anything run" signal — stronger than `# pass`). No
> `--test-force-exit` needed (the spike leaves no open handles). Source:
> nodejs.org/api/test.html.
<!-- /deepen-plan -->

### Phase 4: Teardown (in `finally`)
- [ ] 4.1 `git worktree remove <wt> --force` → `git worktree prune` →
      `fs.rm(tmpDir, { recursive: true, force: true })`. Guard each step so one
      failure doesn't skip the rest; log what ran.
- [ ] 4.2 Log `git worktree list` for the scratch repo (informational only — do
      **not** hard-assert "zero leaked"; the temp dir is removed regardless,
      Scope #15).

### Phase 5: Findings summary + findings doc
- [ ] 5.1 Print a labeled **FINDINGS SUMMARY** block to stdout covering every DoD
      item (flags, envelope keys observed, exit-code meaning, cost/usage
      location, worktree commands, gotchas, outcome status).
- [ ] 5.2 Author `tests/spikes/executor-spike-findings.md` from that output —
      including a **verbatim excerpt of the real observed envelope** (redact
      `session_id`/token values) — not a restatement of the docs (Important #11).
      Outline in "Findings doc — required contents" below.

<!-- deepen-plan: codebase -->
> **Codebase:** nothing in `.gitignore` matches `tests/spikes/`, so both
> `executor-spike.ts` and `executor-spike-findings.md` will be **git-tracked** and
> committed by `gt commit`. That's intended (the findings doc is the deliverable) —
> state it explicitly so the generated `.md` isn't mistaken for a stray artifact.
> (`/worktrees/` *is* gitignored, but the spike's scratch repos live in
> `os.tmpdir()`, fully outside the repo — no conflict.)
<!-- /deepen-plan -->
- [ ] 5.3 Quality gate: `npm run typecheck` passes with the new file present
      (it is in the tsconfig `include` set).

## Technical Specifications

### Files to create
- `tests/spikes/executor-spike.ts` — the spike script (standalone, ESM).
- `tests/spikes/executor-spike-findings.md` — the deliverable findings doc.

### Files to read (context, do not modify)
- `.claude/specs/executor-router.md` — `RunContext`/`Executor`/`AgentRun`; the
  contract the findings will seed.
- `docs/decisions/0009-worktree-isolation.md` — worktree posture (no mechanical
  API specified; the spike invents and documents one).
- `docs/decisions/0006-*` — `claude -p` extraction (confirms subscription, no API
  key; zod-validate + repair house pattern).
- `backend/src/planner/types.ts` — house code style to match (plain TS, JSDoc).

### Exact baseline invocation (record in findings verbatim)
```
claude -p "<prompt>" \
  --output-format json \
  --permission-mode bypassPermissions \
  --model haiku \
  --max-turns 10
# cwd = <worktree>; env carries subscription creds; NO ANTHROPIC_API_KEY
```

### Envelope schema sketch (zod, defensive)
```ts
import { z } from 'zod';
const ResultEnvelope = z.object({
  type: z.literal('result'),
  subtype: z.string(),                 // observed: 'success' | 'error'
  is_error: z.boolean(),
  result: z.string().optional(),       // may be absent on error variants
  error: z.string().optional(),        // names the reason, e.g. 'max_turns_exceeded'
  session_id: z.string().optional(),
  num_turns: z.number().optional(),
  duration_ms: z.number().optional(),
  total_cost_usd: z.number().optional(),   // authoritative cost (spec parses this)
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();                       // tolerate unknown fields; record them
```

### How to run
```bash
node --experimental-strip-types tests/spikes/executor-spike.ts
```
(Node 24 host emits no experimental warning. ESM only; `import type` required by
`verbatimModuleSyntax`. Run on a host with `claude` logged in via subscription,
as a non-root user, with `ANTHROPIC_API_KEY` unset.)

<!-- deepen-plan: codebase -->
> **Codebase:** `.nvmrc` pins **Node 22**, but the host shell runs **Node
> 24.15.0**. `--experimental-strip-types` is stable and warning-free only on Node
> ≥24.3; on Node 22 it is experimental and prints an `ExperimentalWarning`. Run the
> spike on **Node 24** — do **not** `nvm use` down to 22. (Any warning goes to the
> spike's own stderr, not the child's stdout, so it wouldn't corrupt envelope
> parsing — but pin Node 24 to keep output clean.)
<!-- /deepen-plan -->

<!-- deepen-plan: codebase -->
> **Codebase:** `tsconfig.json` sets `noUncheckedIndexedAccess: true`, so every
> array/Record index (`chunks[0]`, regex `match[1]`, `lines[i]`) is typed
> `T | undefined`. Guard each indexed read (null-check or `!`) or `npm run
> typecheck` (Acceptance Criterion 7) fails — this bites the chunk-accumulation and
> TAP-parsing paths in particular.
<!-- /deepen-plan -->

<!-- deepen-plan: external -->
> **Research:** On Node ≥24.3 type-stripping is the **default** and
> `--experimental-strip-types` is optional/no-warning (kept here for Node-22
> compatibility and explicitness). The stripper erases types but cannot transform
> runtime-emitting TS: **avoid enums, namespaces, parameter properties
> (`constructor(private x)`), and legacy decorators** — they fail under strip
> (`--experimental-transform-types` was removed in Node 24). `import type`, `node:`
> builtins, top-level `await`, and the `zod` value import are all safe. The spike is
> a single self-contained file, so the "relative imports need a `.js` extension"
> rule doesn't apply. Source: nodejs.org/api/typescript.html.
<!-- /deepen-plan -->

## Acceptance Criteria

1. `node --experimental-strip-types tests/spikes/executor-spike.ts` runs
   end-to-end on a host with `claude` logged in (headless, subscription) and
   exits **0** on the happy path.
2. Preflight **exits non-zero with an actionable message** when `claude` is
   absent, `ANTHROPIC_API_KEY` is set, or the process is root.
3. The spike makes a real `claude -p --output-format json` call inside an
   isolated git worktree off a throwaway scratch repo.
4. Ground truth: the run is reported **failed (non-zero exit)** if the worktree
   does not differ from `INIT_SHA`, even when `claude` exits 0.
5. Verify: reported **passed** only when `node --test add.test.mjs` exits 0 with
   ≥1 passing test and 0 failures.
6. **Zero worktrees / temp dirs leak** after a normal run *and* after an early
   throw or SIGKILL (teardown runs in `finally`).
7. `npm run typecheck` passes with the new file present.
8. `tests/spikes/executor-spike-findings.md` exists and records, **concretely**:
   exact flags used + serialized `argv`; a **verbatim (redacted) sample of the
   real JSON envelope**; exit-code semantics (success vs partial vs failure);
   the precise location/key of cost (`total_cost_usd`) and usage; the worktree
   setup/teardown commands that worked; `claude --version`; and any
   auth/headless gotchas observed.
9. The findings are sufficient to seed the production `Executor`
   (`.claude/specs/executor-router.md`) `AgentRun` field mapping — stated as
   prose mapping in the findings doc.

## Edge Cases & Error Handling

| # | Scenario | Handling |
|---|----------|----------|
| E1 | `claude` exits 0 but **empty diff** (task-level "couldn't do it") | `GROUND_TRUTH_FAIL`, exit non-zero, loud message. This is invariant #2 working — a *successful demonstration*, but a failed *run outcome*. Document both. |
| E3 | Non-zero exit with **partial/garbage JSON** | Never crash at parse. Record raw stdout+stderr verbatim, mark `PARSE_FAIL`, exit non-zero. The failure output itself is a finding. |
| E5 | Verify: `node --test` 0-exit but **0 tests** (misnamed file) | Pinned `add.test.mjs` + require `# tests N≥1` / `# fail 0`. Misnamed → loud fail (also a prompt-adherence finding). |
| E6 | Agent **commits** its work (so `git diff HEAD` would be empty) | The moved-HEAD half (`HEAD ≠ INIT_SHA`) catches committed work; `status --porcelain` catches untracked/unstaged. False-positive (edit-then-revert) noted as low-probability. |
| E8 | Global git hooks / GPG signing / `includeIf` break the scratch commit | `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` + `-c user.*` on every git call. |
| E9 | Early throw before vars assigned → `finally` can't clean up | Declare `tmpDir`/`worktreePath` in outer scope before `try`. |
| E12 | `--max-budget-usd` / `--no-session-persistence` unrecognized on host version | Not in baseline invocation; behind `SPIKE_EXTRA_FLAGS`, "confirm via `claude --help` first." |
| E13 | stdout pipe-buffer deadlock on verbose output | Accumulate `data` chunks via `spawn` (no fixed maxBuffer). |
| — | `claude` **hangs** | 120 s timeout → SIGTERM → 10 s grace → SIGKILL; mark failed; teardown still runs. |
| — | `--max-turns` / budget exceeded | non-zero exit + `is_error:true` + `error` field; recorded as the partial-failure exemplar. |

## Reproducibility / Determinism

Calling a live LLM is non-deterministic (cost varies, model availability, flaky
completion). The spike stays **green-or-clearly-explained**:
- **Cost is OBSERVED, not asserted** (ADR-0012: executor cost/success are
  observed metrics, not gates). Assert only that `total_cost_usd` is a number
  `≥ 0` and present — never a specific value.
- Determinism comes from the **mechanics** (worktree isolation, exit-code
  capture, diff oracle, verify), not from the LLM's exact output.
- `--model haiku` keeps cost/latency low and behavior stable for a trivial task.
- A flaky/failed completion is captured and reported (E1/E3), not retried — the
  spike is a one-shot probe; retry/replan is the orchestrator's job, out of scope.

## Findings doc — required contents (`executor-spike-findings.md`)

1. `claude --version` and host/Node version.
2. Exact flags + serialized `argv` of the spawned command.
3. **Verbatim, redacted** sample of the real `--output-format json` envelope.
4. Field map: where `total_cost_usd` / `usage` / `num_turns` / `session_id` live.
5. Exit-code semantics observed: success vs partial (max-turns/budget) vs crash;
   how `subtype`/`is_error`/`error` distinguish them.
6. Worktree commands that worked (create + teardown), and the chosen naming.
7. Auth/headless gotchas observed (root block, `ANTHROPIC_API_KEY` override,
   `--bare`↔OAuth-token caveat, credentials path).
8. Recommendations to seed the production `Executor`: CLI-vs-SDK call, prose
   `AgentRun` field mapping, whether to adopt `stream-json` for the live view,
   suggested worktree naming convention (ADR-0009 leaves it open).

## Security Considerations

- **Isolation is collision-avoidance, not a sandbox** (invariant #5 / ADR-0009).
  The scratch repo lives in `os.tmpdir()` with zero contact with the goal-gen
  repo or its history — the cleanest possible blast radius for a spike.
- **Never echo secrets:** redact `session_id`/token values in the findings doc
  and any logs (spec "never echo secrets; redact env from logs").
- `bypassPermissions` is used **only** because the target is a throwaway temp
  dir; this is exactly the dangerous-but-acceptable posture the spike documents
  for the production host setup.

## Out of Scope (explicit)

Production `Executor` interface/implementation, goal-extractor, orchestrator
loop, persistence/API, frontend, the `codex`/`agy`/`shell`/`mcp` adapters,
`stream-json` parsing, retry/replan, per-run containers (M2). Learnings *inform*
these later rather than committing to them now.

## References

- Brainstorm: `docs/brainstorms/2026-06-23-next-work-item-brainstorm.md`
- Spec: `.claude/specs/executor-router.md` (`RunContext`/`Executor`/`AgentRun`,
  parse `total_cost_usd`, kill via SIGTERM→SIGKILL, CLI-not-installed handling)
- ADRs: `docs/decisions/0009-worktree-isolation.md` (worktree posture),
  `0006` (`claude -p` extraction / subscription / zod-repair),
  `0012` (GATE vs OBSERVED metrics — cost is observed)

<!-- deepen-plan: codebase -->
> **Codebase:** exact ADR filenames confirmed —
> `docs/decisions/0006-extraction-via-claude-p.md` ("Goal extraction via headless
> `claude -p`") and `docs/decisions/0012-metrics-gate-vs-observed.md` ("Success
> metrics: gate vs observed split"). Also: `zod ^3.24.0` lives in
> **`devDependencies`** (not `dependencies`) — fine for a dev-only spike; the v3
> `.passthrough().safeParse` API in the schema sketch is correct and the `^3` range
> won't pull zod v4.
<!-- /deepen-plan -->
- Invariants: CLAUDE.md #2 (ground truth), #3 (verify required), #5 (worktree isolation)
- House style: `backend/src/planner/{plan,simulate,types}.ts`
- Run config: `tsconfig.json` (`include` covers `tests/**/*.ts`),
  `vitest.config.ts` (only `*.test.ts` runs — spike is excluded by design),
  `package.json` (`zod` present; no `tsx`/`execa`)
- Claude Code headless docs: https://code.claude.com/docs/en/headless ·
  CLI reference: https://code.claude.com/docs/en/cli-reference ·
  Auth: https://code.claude.com/docs/en/authentication ·
  Worktrees: https://code.claude.com/docs/en/worktrees

## Resolved open questions (from SpecFlow analysis)

1. **Empty diff** → `GROUND_TRUTH_FAIL`, non-zero exit (E1).
2. **`json` not `stream-json`** (D3); document the real shape, note stream-json as follow-up.
3. **Timeout** = 120 s total, 10 s SIGKILL grace (env-overridable).
4. **`ANTHROPIC_API_KEY` set** → **abort** (not warn) (D8).
5. **Verify** = pinned `node --test --test-reporter tap add.test.mjs` + `# tests N≥1` / `# fail 0` (D5/E5).
6. **Diff oracle** = `status --porcelain` non-empty OR HEAD ≠ `INIT_SHA` (D6/E6; shipped — findings §5).
7. **proto-`AgentRun` mapping** → **cut**; print findings summary instead (D7).
