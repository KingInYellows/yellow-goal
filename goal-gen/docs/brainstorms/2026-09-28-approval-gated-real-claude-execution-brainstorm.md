# Brainstorm — Step 6: Approval-gated real-Claude execution (paired PRs)

- **Date:** 2026-09-28
- **Status:** Decided — the operator confirmed D1–D10 on 2026-09-28 (see "Operator decisions"). Design only; nothing here authorizes running a real executor.
- **Topic:** Step 6 of the Yellow Harness six-step program (`workspace-meta/README.md`): the first real, human-supervised, spend-incurring Claude execution, delivered as paired PRs (yellow-goal engine, then yellow-plugins consumer).
- **Human-control constraint:** every gate assumes a human operator. No autonomous session runs `run --executor claude-code` / `npm run runner` / live `analyze`, and `bypassPermissions` is never proposed on any new path.

## Context

Verified against `yellow-goal` main `072882d` and `yellow-plugins` main `c58af0b`:

- **Protocol v1 is stub-only by contract.** PP-04 (permissions are intent, never authority), PP-10 / A12 (zero real spend, untouched target) and `run.start` (`executor: stub`, `simulation: true`, `targetRepositoryHonored: false`) all promise zero spend. `capabilities --json` advertises only `run.executor.stub`. The consumer (`plugins/yellow-goal`, pin `0.2.0`) has no executor selector: its argv is always `--executor stub --protocol v1`.
- **A real executor path already exists but is not fit to promote.** Legacy `run --executor claude-code` (`backend/src/cli/run-command.ts`) hardcodes `permissionMode: 'bypassPermissions'` in `claudeCodeEngine`, runs the LLM extractor (`claude -p`, more spend) and then a per-action `claude -p`, inside `createWorktree()` — a fresh `git init` scratch repo in `tmpdir` with **no seed files** (an empty base). `target.repository` is disclosed as not honored. ADR-0009: worktree = collision avoidance, not a sandbox; the host is the blast radius.
- **Fail-closed permission machinery exists.** ADR-0015 / `ClaudeCodeExecutor`: default `acceptEdits`; an action payload may only narrow within `{plan, acceptEdits}`; unknown or escalating modes fail without spawning. `policies/permission-profiles.json`: profile `implement` = `targetWrite: isolated-worktree-only`, `defaultClaudeMode: acceptEdits`. The mapping from profile to executor mode is explicitly deferred in `request-to-run-pipeline.md` (RR21) and by ADR-0018.
- **Spend facts** (`tests/spikes/executor-spike-findings.md`): ~$0.08 and ~26 s for a trivial non-`--bare` action, dominated by context cache creation; `total_cost_usd` is the authoritative meter; `claude -p` cannot force JSON (extractor is zod-repaired); `ANTHROPIC_API_KEY` silently overrides subscription auth (metered API billing); the agent leaves untracked files and does not commit (oracle = `git status --porcelain` OR moved HEAD, never `git diff <sha>`); hooks/plugins drop noise files (`ruvector.db`). The spike only ever proved `bypassPermissions`; `acceptEdits` plus an allowlist is **untested headless**. Installed `claude --help` (checked 2026-09-28, read-only) lists `--max-budget-usd`, `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--no-session-persistence`, `--settings`, `--bare`.
- **The verification half is already built, and was designed for a non-deterministic worker.** VS layers 3–3e are offline `acceptance` verbs. `verify-candidate config-repair <candidate.json>` takes an untrusted FILE-CONTENT candidate (`yellow-goal/candidate-file-content/v1`), materializes it on an engine-owned synthetic base in a disposable repo, reruns engine-owned trusted checks, records via the packed recorder, and writes a durable bundle that `acceptance reproduce` re-verifies in a fresh process. The spec deliberately has no golden output ("at least two byte-distinct valid candidates can both pass"). Limits: engine-owned fixed profiles only (`config-repair`; `package-manifest-lockfile` for captured sources), ≤16 files / 16 KiB per file / allowed paths only, disposable repos under `$TMPDIR`, no arbitrary repos or caller checkers.
- **Coordination rules** (`workspace-meta/README.md`): paired milestones are two dependent PRs, not one cross-repo PR; plugins spawns the released tarball and never imports the engine; mutation/execution tests only touch `fixtures/bridge-smoke-repo` or copies under `runtime/`. Precedent for step 4 -> 5: engine lands and is released first, consumer pins the released asset second. Precedent for operator procedures: the committed-source runbook (#43) gated in CI by ADR-0019 (`operator-recipe` job).

## What We're Building

A first, human-supervised, budget-capped path on which one real `claude -p` worker produces a candidate that the existing independent verifier judges, with a human approval recorded before any dollar is spent and a human sign-off before anything is accepted. Concretely (chosen increment, "layer 4a"):

1. **Profile-bound worker run.** The worker runs in an engine-owned scratch worktree seeded from a VS profile's base (`createWorktree` already supports `seedFiles`), starting with `config-repair`. There is no target repository at all: `target.repository` stays non-selecting. One approved milestone, one immutable synthetic base (fixed dates and recorded recipe already give a reproducible `baseRevision`), one bounded worker.
2. **Manifest-driven single action, no LLM extraction.** The profile supplies the milestone text and allowed paths; the engine builds a fixed one-action GoalSpec (like the stub goal) instead of calling the LLM extractor. The approval manifest can then list the exact spend surface (one `claude -p` invocation, max-turns, per-action budget) before spend.
3. **Approval ceremony (engine-owned).** A new offline, zero-spend step renders a run manifest (profile id + digest, base revision, request hash, model, permission mode, allowed/disallowed tools, per-action and total USD caps, action/wall-clock timeouts, auth mode) and, only after an interactive TTY confirmation by a human, writes a `run-approval/v1` record under `runtime/`. A real run requires that record, verifies its hash binding to the actual invocation, expiry and single-use, and echoes the approval id in `run.start`. The host/consumer can display a manifest and pass an approval path; it can never mint one.
4. **Fail-closed spend and permission bounds.** `acceptEdits` plus an explicit `--allowedTools` list derived from the approved manifest (never `bypassPermissions`; the legacy path's hardcode is left untouched and not promoted), per-action `--max-budget-usd`, the existing guardrails (ADR-0010) with a much lower first-run cap, refusal to start when `ANTHROPIC_API_KEY` is set unless the manifest says so, SIGINT/SIGTERM via the existing AbortController, consumer deadline and SIGKILL escalation (PP-08).
5. **Verification reuse.** After the worker finishes, the engine extracts a FILE-CONTENT candidate from allowed paths only (porcelain/HEAD oracle, noise-filtered), then hands it to `acceptance verify-candidate <profile> <candidate.json> --bundle-dir …`. A human later runs `acceptance reproduce <bundle>` in a fresh process and makes the final accept call. Worker narrative never succeeds the milestone (FR-16); no merge or deploy.
6. **Protocol and consumer.** Real runs are advertised and selected explicitly and separately from stub runs under a new `provider-protocol/v2` identity (D8); the plugin gains a user-only real-run command that surfaces the manifest, passes an approval path, validates the extended event stream and shows the spend tally, with tests against a fake engine only.

Explicitly not in this step: executing against `target.repository` or any live checkout; captured-base real runs (the natural next rung, 4b); multi-worker or M2 routing; persistence or crash-resume (RR15); HTTP/SSE; auto-merge; publishing anything.

## Why This Approach

- **The verifier already exists and fits.** Profile-bound execution consumes VS 3c as designed. Target-bound execution would need the safety review the request-to-run spec reserves for it and would fight VS-01/VS-02 and ADR-0009 before a single real dollar has been metered.
- **It bounds and makes spend enumerable.** Skipping LLM extraction leaves exactly one metered call surface, so the approval manifest can be exact and the budget cap meaningful (~$0.08 floor observed).
- **Approval is a first-class, verifiable artifact, not a flag.** Today's consent is `--yes` (RR19, "the operator's CLI `--yes` may skip the DoD gate"). A hash-bound, single-use, TTY-minted approval closes the gap between "operator typed --yes once" and "this exact manifest was authorized". The DoD gate (existing) still shows verify commands, and completion sign-off stays never auto-approved (RR14/PP-07).
- **Autonomous-session safety.** No path in this design lets an agent self-approve through argv, env or stdin; the plugin command is user-only; CI never contains a real `claude` spawn.

Honest limit: a TTY ceremony is a consent ceremony under ADR-0011's single-admin local trust model, not authentication. A human who deliberately scripts a TTY defeats it; the defense is that agent-driven sessions have no controlling TTY and that the plugin command cannot mint approvals.

## Approaches considered

### Approach A (chosen): Profile-bound scratch execution, engine-owned approval, new real-run protocol surface
As above. **Pros:** smallest safe real-spend increment; reuses VS verifier unchanged; exact manifests; no target risk; produces the first honest measurement of `acceptEdits`+allowlist and real cost. **Cons:** first live task is a toy profile (`config-repair`), so it proves the control loop, not general engineering ability; requires a new profile field for milestone/prompt text; needs a supervised probe to confirm `acceptEdits` viability. **Best when:** the goal is to prove the approval/spend/verification loop before touching real code.

### Approach B: Target-bound (or captured-base) execution immediately
Point the worker at a real repository worktree or a captured commit and verify a patch against it. **Pros:** closest to layer-1 outcome. **Cons:** VS profiles cap at 8-16 tiny files under fixed checks, so real repos exceed the verifier envelope; target-bound needs its own safety review (worktree is not a sandbox, ADR-0009), new identity/patch semantics and conflict handling; risk compounds with first-ever metered run and untested permission mode. **Best when:** approval, spend and permission mechanics are already proven. **Verdict:** rejected for step 6; captured-base (VS 3e overlay) is the recommended 4b next rung, target-bound later still.

### Approach C: Flip the existing path on (allow `--executor claude-code` under Protocol v1, `--yes` as approval)
Smallest diff. **Pros:** almost no new code. **Cons:** breaks v1's zero-spend guarantees for existing consumers; keeps the bypass hardcode; runs against an empty scratch repo so success is meaningless; `--yes` is not an auditable approval; still runs the paid LLM extractor. **Verdict:** rejected.

Also considered and rejected: per-action approval gates (serial single-action run; adds prompts without a new decision to make — YAGNI); a persistent approval daemon or signed/authenticated approvals (ADR-0011 single-admin scope); adding a mock-`claude` env switch (PP-03 forbids environment-selected behavior — test doubles are injected constructor options instead).

## Key Decisions (confirmed by the operator 2026-09-28)

| # | Decision | Decided |
|---|---|---|
| D1 | First-increment scope | Profile-bound scratch execution (4a); captured-base is 4b; target-bound out of scope |
| D2 | Work definition | Manifest-driven single action from an engine-owned profile; no LLM extractor in the real path |
| D3 | Gates | G1 pre-dispatch run approval (manifest, TTY-minted, hash-bound, single-use, expiring); G2 existing DoD confirm (operator `--yes` only); G3 human sign-off after independent verification (separate `acceptance reproduce` step, never in-process auto-accept) |
| D4 | Who approves | CLI operator via engine TTY ceremony. Host/plugin displays and forwards, never mints |
| D5 | Evidence | `run-approval/v1` record + spend ledger + candidate + `acceptance` bundle all under `runtime/`, cross-linked by approval id; bundle is reproducible without the approval |
| D6 | Permissions | Profile `implement` -> `acceptEdits` + manifest-derived `--allowedTools`; `bypassPermissions` unreachable from new path, regression-tested. A supervised probe precedes E2 finalization; if `acceptEdits` + allowlist cannot run the profile's checks, widen the allowlist once, then **stop and redesign** — never fall back to bypass. Legacy `--executor claude-code` path left untouched and unadvertised during step 6, retired (removed or aliased to the new path) in a follow-up after A1 |
| D7 | Budget / kill switch | Manifest caps override defaults downward only. First live run: **total <= $5, model sonnet, subscription auth**, single action so its `--max-budget-usd` <= the total, `--max-turns` 10, minutes-scale timeout. Abort via existing signals; consumer deadline + SIGKILL; refuse to start when `ANTHROPIC_API_KEY` is set unless the manifest declares API-key auth |
| D8 | Protocol | New `provider-protocol/v2` identity carries real-run capabilities; v1 stays byte-for-byte zero-spend (PP-04/PP-10/A12 untouched) and v1 consumers remain safe unchanged; `capabilities` gains a supported-protocols field |
| D9 | Test strategy | Zero spend in CI: injected fake `claude` executable emitting recorded real-shaped envelopes (spike §2 verbatim plus error variants), fake TTY seam, stub parity of event shape, static/regression tests that the real path cannot resolve to `bypassPermissions`, an ADR-0019-style `operator-recipe` gate that runs the runbook against the fake; exactly one human-run live acceptance, outside CI |
| D10 | ADR | New ADR (next free number) plus a spec `approval-gated-real-execution.md`; do not rewrite ADR-0018 decision text — extend the VS layer table with a 4a row |

> **Note (2026-09-28): D3's G2 is superseded by spec R25.** The original decision text above is kept as a historical record. On real runs, the G1 approval replaces the G2 DoD confirmation, and `--yes` is rejected (`goal-gen/plans/specs/approval-gated-real-execution.md`, R25 and the "Approval replaces the DoD confirm on real runs" decision). Why: with a fixed one-action goal, the approval manifest already shows everything the DoD gate would, so a second prompt adds no decision. G1 (TTY-minted approval) and G3 (human sign-off after independent verification) are unchanged. The spec is normative where the two differ.

## Suggested decomposition into paired PRs

Order mirrors steps 4 -> 5: engine first and released, consumer pins the released asset.

**yellow-goal (engine)**
- **E0 docs:** ADR + spec (RG-* requirements, acceptance matrix), PRD/VS layer-table amendment, runbook skeleton. No code.
- **E1 approval primitives (zero spend):** `run-approval/v1` schema, manifest builder, `run approve` TTY ceremony (TTY seam for tests), verifier (hash binding, expiry, single-use ledger), spend-ledger schema. No `claude` spawn.
- **E2 real-worker engine (zero spend in CI):** profile prompt/milestone field; profile-seeded worktree; single-action engine factory; `acceptEdits` + allowlist + budget flags; env/API-key guard; injectable `claude` command in `ClaudeCodeExecutor`; candidate extraction; hand-off to `verify-candidate`; fake-`claude` tests including denial/timeout/budget-stop/`is_error` variants.
- **E3 protocol surface + release:** capability/identity per D8, extended `run.start`/spend events, terminal handling, installed-tarball smoke against the fake, version bump and release (recoverable workflow, hash evidence) -> the pin target for the consumer.

**yellow-plugins (consumer)**
- **P1 compat:** bump pin (`src/pin.ts`, release-pin gate, blocking `Released Goal Engine Compatibility`), discovery validators for the new surface; still stub-only argv; proves upgrade safety.
- **P2 real-run command:** user-only command (not model-invocable), manifest display, approval-path passthrough, extended event/terminal/spend validators, deadline and cancel behavior; fake-engine tests only; never spawns a real executor in tests.

**Human-supervised acceptance (not a code PR)**
- **A1:** operator runs the runbook once against the released engine on `config-repair`, low caps, recovery-map artifact under `runtime/`, evidence (approval record, spend ledger, bundle, `reproduce` result) recorded; a docs PR captures results and the measured cost/`acceptEdits` behavior. Before A1, a smaller supervised **probe** (one tiny action) answers whether `acceptEdits` + allowlist works headless, since only `bypassPermissions` was ever proven.

## Operator decisions (2026-09-28)

| Question | Answer |
|---|---|
| Scope / profile | Profile-bound scratch execution (4a) on `config-repair`; captured-base is 4b, target-bound later |
| LLM extractor | Dropped from the real path; the profile supplies a fixed one-action goal |
| Protocol identity | New `provider-protocol/v2`; v1 unchanged |
| Approval | Engine-owned TTY ceremony (`run approve`) mints a hash-bound, single-use, expiring `run-approval/v1`; the plugin displays and forwards only |
| Budget / model / auth | $5 total cap, sonnet, subscription auth, API-key guard |
| Permission viability | Supervised probe before E2 finalizes; widen allowlist once, else stop — no bypass fallback |
| Sign-off | Separate human `acceptance reproduce <bundle>` then accept; no in-process gate |
| Legacy path | Untouched and unadvertised during step 6; retired in a follow-up after A1 |
| Environment hygiene (default, not asked) | Candidate extraction reads allowed paths only, so hook/plugin side-effect files (`ruvector.db`) never reach the verifier; no `--bare` (breaks subscription OAuth). Whether to also pass a minimal `--settings` to the child is decided by the probe |

## Residual open items (for `/flow:plan`, not blocking)

- Approval expiry window and the single-use ledger's storage/locking (default proposal: 60 min, ledger under `runtime/`).
- Exact per-action `--max-budget-usd` and wall-clock timeout within the $5 envelope once the probe measures sonnet cost on `config-repair`.
- Where the profile's milestone/prompt text lives (new field on the engine-owned profile vs. a sibling file) and its digest in the manifest.
- v2 event additions (spend tally, approval id in `run.start`) and how the consumer's discovery chooses v1 vs. v2.

## Next step

Run `/flow:plan` on this document to produce E0 (ADR + spec), then treat E1–E3, P1–P2, the permission probe and A1 as separately reviewed slices. The probe and A1 are human-run only.
