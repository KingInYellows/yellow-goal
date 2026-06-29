# Executor De-Risk Spike — Findings

**Captured:** 2026-06-25 · **Spike:** `tests/spikes/executor-spike.ts` ·
**Plan:** `plans/executor-de-risk-spike.md` · **Status of run:** `OK` (exit 0,
clean teardown, zero leaked worktrees/temp dirs).

This freezes the concrete learnings from running the executor mechanics
end-to-end against the host `claude` CLI inside an isolated git worktree. It is
the spec input for the production `Executor` (`.claude/specs/executor-router.md`).

---

## 0. Environment

| Item | Value |
|------|-------|
| `claude --version` | `2.1.190 (Claude Code)` |
| Node | `v24.15.0` (strip-types is default/no-warning ≥24.3) |
| User | uid 1000 (non-root — required; `bypassPermissions` is blocked as root) |
| Auth | subscription via `~/.claude/.credentials.json`, read automatically; `ANTHROPIC_API_KEY` unset |
| Model | `claude-haiku-4-5-20251001` (alias `--model haiku`) |

---

## 1. Exact flags that worked

```
claude -p "<prompt>" \
  --output-format json \
  --permission-mode bypassPermissions \
  --model haiku \
  --max-turns 10
```

- Spawned via `node:child_process.spawn` with `cwd` = worktree path,
  `stdio: ['ignore','pipe','pipe']`, `env: process.env`. **Prompt passed as an
  argv positional**, not stdin.
- `--permission-mode bypassPermissions` was **sufficient** for the agent to use
  `Write` + `Bash` (create files, run `node --test`) headless with no prompts
  and no hang. `--allowedTools` was **not** needed.
- All five flags are accepted by v2.1.190. `--max-budget-usd` /
  `--no-session-persistence` were **not** used in this run (kept out of the
  baseline; confirm against `claude --help` before adding).
- `bypassPermissions` is the canonical value; `--dangerously-skip-permissions`
  is its alias. `--permission-mode auto` is **not** portable — do not use it.

---

## 2. The `--output-format json` envelope (REAL shape)

The real envelope has **more** top-level keys than the published docs. Observed
top-level keys (v2.1.190):

```
type, subtype, is_error, api_error_status, duration_ms, duration_api_ms,
ttft_ms, ttft_stream_ms, time_to_request_ms, num_turns, result, stop_reason,
session_id, total_cost_usd, usage, modelUsage, permission_denials,
terminal_reason, fast_mode_state, uuid
```

Verbatim sample (session id redacted; this is the actual run — **abridged**: the
timing keys `ttft_stream_ms` and `time_to_request_ms` from the key list above
were observed but elided here for brevity):

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "api_error_status": null,
  "duration_ms": 19957,
  "duration_api_ms": 13555,
  "ttft_ms": 4113,
  "num_turns": 4,
  "result": "Perfect! Both files have been created and the test passes: …",
  "stop_reason": "end_turn",
  "session_id": "1ab6…e3",
  "total_cost_usd": 0.0803324,
  "usage": {
    "input_tokens": 26,
    "cache_creation_input_tokens": 32591,
    "cache_read_input_tokens": 101044,
    "output_tokens": 1004,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard",
    "cache_creation": { "ephemeral_1h_input_tokens": 32591, "ephemeral_5m_input_tokens": 0 },
    "iterations": [ { "input_tokens": 8, "output_tokens": 287, "cache_read_input_tokens": 42603, "cache_creation_input_tokens": 6551, "type": "message" } ],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-haiku-4-5-20251001": {
      "inputTokens": 26, "outputTokens": 1004,
      "cacheReadInputTokens": 101044, "cacheCreationInputTokens": 32591,
      "costUSD": 0.0803324, "contextWindow": 200000, "maxOutputTokens": 32000
    }
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "uuid": "6242e6ae-…"
}
```

### Where cost & usage live
- **Cost (authoritative):** `total_cost_usd` (number, top level). Per-model
  copy at `modelUsage.<model>.costUSD`.
- **Usage:** `usage` (top level, **snake_case**) — `input_tokens`,
  `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  plus nested `server_tool_use`, `cache_creation`, `iterations[]`,
  `service_tier`, `speed`. `modelUsage.<model>` mirrors it in **camelCase**
  (`inputTokens`, `cacheReadInputTokens`, …) — note the casing differs between
  `usage` and `modelUsage`.
- **Defensive parsing is mandatory.** The published shape is a subset; treat
  `subtype` as an open string and `usage.*` as possibly absent (`?? 0`). The
  spike's zod schema used `.passthrough()` and validated cleanly against this
  richer real object.

### Success classification
`exit 0` **AND** `is_error === false` **AND** `subtype === 'success'` (all held
here). Extra corroborating signals: `stop_reason === 'end_turn'`,
`terminal_reason === 'completed'`, `permission_denials === []`.

---

## 3. Exit-code semantics (observed)

- **Success:** process exit **0**, `is_error:false`, `subtype:"success"`.
- Partial/failure exits (budget/turn limits, auth failure, crash) were **not**
  triggered in this happy-path run. The spike's `PARSE_FAIL` / `RUN_FAIL` paths
  are wired to capture them (raw stdout/stderr preserved in `findings`) when a
  future run hits them. **Do not trust exit code alone** — a budget stop can
  reportedly exit 0 with `is_error:true`; always cross-check `is_error` +
  `subtype`.

---

## 4. Cost reality (important for the production cost model)

`total_cost_usd` was **$0.0803** for a *trivial* `add(a,b)` task. The task
itself was tiny (26 input / 1004 output tokens); the cost was dominated by
**context loading** — **32,591 cache-creation** + **101,044 cache-read** tokens
— because this run was **not** `--bare` (it loaded CLAUDE.md, hooks, plugins,
MCP). Implications:

- Per-action overhead is non-trivial even for trivial work. ADR-0010's $20/run
  budget is fine, but the orchestrator should expect ~$0.05–0.10 *floor* per
  `claude-code` action from context loading alone.
- `--bare` would cut this dramatically **but breaks subscription OAuth** (it
  only reads `ANTHROPIC_API_KEY`). Real tension: bare-for-cost vs.
  subscription-auth. v1 keeps non-bare (subscription); revisit at M2.
- Cache reuse across serial actions in one session could amortize this — worth a
  follow-up probe (session `--resume` vs. fresh process per action).

---

## 5. Ground truth — the headline finding ⚠️

**The agent created `add.mjs` and `add.test.mjs` as NEW UNTRACKED files and did
NOT commit** (`headMoved: false`; `git status --porcelain` →
`?? add.mjs`, `?? add.test.mjs`). Therefore:

- **`git diff <INITIAL_SHA>` and `git diff --quiet <INITIAL_SHA>` MISS the change
  entirely** — plain `git diff` ignores untracked files. The first spike run
  used that oracle and produced a **false `GROUND_TRUTH_FAIL`** even though the
  files were correctly created.
- This contradicts both the SWE-bench-style "diff against a captured SHA" prior
  art and the plan's own deepen-plan "correction" to `git diff --quiet <SHA>`.
- **Correct oracle (used in the final spike, confirmed working):**

  ```
  changed = (git -C <wt> status --porcelain) is non-empty
            OR (git -C <wt> rev-parse HEAD) != INITIAL_SHA
  ```

  `status --porcelain` catches untracked + unstaged + staged; the HEAD check
  catches the case where an agent *does* commit. Together they are complete and
  have **no index side-effects** (unlike `git add -A && git diff --cached`).

**Action for the production `Executor`:** compute `AgentRun.diffRef` from a
status-porcelain/`add -A`+`diff --cached` approach, **never** plain
`git diff <ref>`. This is the single most important de-risking result.

---

## 6. Worktree setup / teardown (ADR-0009) — commands that worked

```bash
# setup (git config isolated from host: GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null)
git init -q
git -c user.name=spike -c user.email=spike@local commit -q -m init   # worktree needs >=1 commit
git worktree add <tmp>/wt -b spike-run

# teardown (ran cleanly; verified zero leaks)
git worktree remove <tmp>/wt --force
git worktree prune
rm -rf <tmp>                     # the whole scratch repo lives in os.tmpdir()
```

- `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` fully isolated the
  scratch repo from host hooks / GPG signing / `includeIf` — no signing prompt,
  clean commit.
- Suggested naming convention (ADR-0009 leaves it open): scratch repo per run in
  `os.tmpdir()/executor-spike-<rand>`, worktree at `<tmp>/wt`, branch
  `spike-run`. A fresh `mkdtemp` per run makes branch-name collisions impossible.
- `git worktree list` after teardown showed only the main scratch checkout —
  the worktree was removed, then the whole temp dir deleted.

---

## 7. Auth / headless gotchas (observed + confirmed)

- Subscription creds at `~/.claude/.credentials.json` are read automatically; no
  env var needed for a logged-in host. No browser/TTY prompt; no hang.
- **`ANTHROPIC_API_KEY` silently overrides subscription** — the spike aborts in
  preflight if it is set (production accepts it as a *fallback* per
  executor-router.md, but the spike validates the subscription path only).
- **`bypassPermissions` is blocked as root** — run as a non-root user. The spike
  aborts on uid 0 (override `SPIKE_ALLOW_ROOT=1` to observe the failure).
- **Side-effect:** the non-`--bare` nested session's hooks wrote a stray
  `ruvector.db` into the worktree cwd (visible as `?? ruvector.db`). The
  production executor should expect agent-environment side-effect files
  (hooks/plugins/MCP) in the worktree and not mistake them for the agent's
  intended output. (Harmless for v1's "any change = signal" oracle, but the
  diff/patch the operator reviews will include such noise.)

---

## 8. Toolchain gotcha — typecheck-green ≠ strip-types-runnable

`tsc --noEmit` **passed** on a version of the spike that used a TS **parameter
property** (`constructor(readonly status: …)`), but `node
--experimental-strip-types` **failed** at runtime:
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not
supported in strip-only mode`. Strip-only mode also rejects **enums,
namespaces, and legacy decorators**. If the production executor (or any tooling)
runs `.ts` via strip-types, avoid these constructs — `npm run typecheck` will
not catch them.

`process.exit()` was also a trap: it **skips `finally`**, leaking the worktree on
the first run. The spike now uses `process.exitCode` + throw-based control flow
so teardown always runs.

---

## 9. Timing (for timeout tuning)

| Metric | Value |
|--------|-------|
| Wall-clock (spike-measured) | 26,134 ms |
| `duration_ms` (envelope) | 19,957 ms |
| `duration_api_ms` | 13,555 ms |
| `ttft_ms` | 4,113 ms |
| `num_turns` | 4 |

A trivial action took ~26 s end-to-end (non-bare context load included). The
120 s spike timeout was appropriately generous; the orchestrator's 60-min
wall-clock default is for complex multi-step actions, not per-action floors.

---

## 10. Seeding the production `Executor` — `AgentRun` field mapping

From `.claude/specs/executor-router.md`'s `AgentRun`:

| `AgentRun` field | Source from this run |
|------------------|----------------------|
| `status` | `'succeeded'` iff `exitCode===0 && !is_error && subtype==='success'`; else `'failed'` (orchestrator decides retry/replan) |
| `exitCode` | process exit code (`0`) |
| `costUsd` | envelope `total_cost_usd` (`0.0803324`) |
| `tokens` | envelope `usage.output_tokens` (+ input if desired); per-model in `modelUsage` |
| `stdout` | captured child stdout (the full JSON) or `result` for the human summary |
| `stderr` | captured child stderr |
| `diffRef` | **MUST** be computed via `status --porcelain` / `add -A`+`diff --cached <sha>`, **never** plain `git diff <sha>` (see §5) |
| `startedAt` / `endedAt` | wall-clock stamps around the spawn |

### Recommendations for the production session
1. **Ground-truth oracle:** status-porcelain-based (or stage-then-diff). This is
   non-negotiable given §5.
2. **CLI, not SDK:** the raw `claude` CLI via `child_process` proved sufficient
   and zero-dependency; the SDK is unnecessary for v1.
3. **Cost model:** budget for a ~$0.05–0.10 per-action floor from context
   loading; investigate session reuse / cache amortization across serial actions.
4. **Success classification:** `exit 0 && !is_error && subtype==='success'`;
   defensively parse `usage.*` and treat `subtype` as an open string.
5. **Teardown:** never `process.exit()` mid-run; guarantee worktree removal in a
   `finally`.
6. **Live view (M2):** switch to `--output-format stream-json --verbose` to
   stream progress/retry events; the final `result` object is **expected** to
   match §2 — confirm in stream-json mode before shipping (the spike ran only
   `--output-format json`).
7. **Open probe:** does `--bare` + `ANTHROPIC_API_KEY` reduce the per-action
   context cost enough to justify abandoning subscription auth? Deferred.

---

## Acceptance criteria — met

- ✅ Ran end-to-end against host `claude` (subscription, headless), exit 0.
- ✅ Real change made inside an isolated worktree off a throwaway scratch repo.
- ✅ Ground truth enforced (caught the untracked-files oracle bug; corrected).
- ✅ Verify passed only on a real passing test (`# tests 1` / `# fail 0`).
- ✅ Zero leaked worktrees / temp dirs (teardown in `finally`).
- ✅ `npm run typecheck` passes with the spike present.
- ✅ This doc records flags, real envelope, exit semantics, cost/usage location,
  worktree commands, `claude --version`, and the gotchas above.
