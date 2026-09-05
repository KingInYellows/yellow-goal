# AGENTS.md — GOAL Generator

Codex-compatible repo instructions (mirror of `CLAUDE.md`). If both are present, treat `CLAUDE.md` as canonical; this file exists so the Codex executor and other AGENTS.md-aware agents get the same rules. Direct prompts override this file.

## Project
Self-hosted GOAL generator: plain-English goal → LLM action-graph extraction → deterministic A\* GOAP plan → orchestrator dispatches actions to headless coding-agent CLIs → ground-truth verify → replanning → live view. TypeScript end-to-end; Postgres/pgvector; **local, single-operator**, self-hosted on a Proxmox LXC or VM. **v1 = M1: Claude Code (`claude -p`) only, serial** — implemented; Codex + Antigravity + parallelism + full dashboard are M2 fast-follow. A second, **read-only** subsystem — the Universal Repository Goal Packet Compiler (`npm run cli`: request → inspect → analyze → compile → packet verify, emitting verified `repository-goal-packet@1` ZIPs) — is also implemented; it never mutates target repositories and rejects unknown permission/orchestration profiles fail-closed (`.claude/specs/packet-compiler.md`). Product spec: `docs/prd.md`. Component contracts: `.claude/specs/`.

## Build / test
- Install: `npm install` (npm only; CI uses `npm ci`)
- Dev: `TBD` (not scaffolded yet)
- Test: `npm test` · `npm run test:watch` (watch mode) · Evals: `npm run eval` (all) / `npm run eval:planner` (planner gate) · Typecheck: `npm run typecheck`
- Compiler CLI: `npm run cli -- <subcommand> [--json]` · Identity: `npm run cli -- version --json` · Run: `npm run cli -- run <request.json> --executor stub|claude-code` (`stub` only from tests/CI)
- Install gate: `bash scripts/install-smoke.sh` · Migrations: `npm run db:generate` after any `backend/src/db/schema.ts` change (the migration gate `tests/db/migrations.test.ts` fails otherwise)
- Test-only zero-spend run: `npm run cli -- run <request.json> --executor stub`. The M1 runner (`npm run runner -- [--yes] "<goal>"` or `--request <file>`) is human-only: it can invoke real `claude -p`; never copy it into CI or an autonomous session.
- Lint/format: `TBD` (not configured yet)
Always run tests + the eval set before declaring a planner or prompt change done.

## Hard rules
1. Planner is deterministic (A\* over symbolic state); no LLM inside it. Replanning re-runs the planner; when the pool can't reach the goal, the extractor authors **additional** actions (append-only, bounded) — deciding to re-extract is deterministic.
2. Update `WorldState` from **real** results (exit codes/tests/diffs), not declared effects.
3. Every `Action` needs a `verify` check.
4. Keep executors behind one interface. The extraction LLM runs via headless `claude -p` (subscription; no API key) behind a thin interface, swappable later; `claude -p` has no forced tool-use, so strict JSON is zod-validated + repaired.
5. One git worktree per agent run; no two writers on the same files. Worktrees are **collision-avoidance, not a sandbox** — the host LXC/VM is the blast radius in v1; per-run containers at M2.
6. Enforce guardrails on every run: max replans, max budget USD, wall-clock, retries, max re-extractions, loop detection. Defaults: $20/run · 5 replans · ≤2 re-extractions · 60-min · 3 retries/action · concurrency 1; on trip → stop & escalate.
7. Secrets via env only; no destructive git ops without approval.
8. Process contract (ADR-0016): the engine is consumed as a process (npm tarball → `goal-gen` bin), never imported. Command failures use a single-line structured stderr `{"error":{"code","message"}}`; exit 0 is success, exit 2 is `USAGE_ERROR`, and other command failures exit 1. A schema-invalid `request validate` is an expected domain result: it exits 1 with one stdout object `{path,valid:false,errors}` and empty stderr. `tsx` + `zod` are runtime deps. `npm test` includes only `tests/**/*.test.ts`; live tests use the `*.probe.ts` suffix and CI must never run a real agent. An annotated `v*` tag matching `package.json` publishes `goal-gen-<ver>.tgz` as a GitHub Release asset (`.github/workflows/release.yml`): tokenless packing, then token-scoped publication with asset hash verification and safe reruns. To recover an unchanged tag's draft/asset, dispatch that workflow from `main` with `-f tag=vX.Y.Z -f commit=<expected-40-character-commit>` and rerun safely; it checks the existing annotated tag and expected peeled commit without creating or moving a tag. Consumers pin that URL.

## Conventions
Types-first; validate model output with zod; read the relevant `.claude/specs/*.md` before implementing a component, and update the spec first if behavior must change.

## Scope note
v1 = **M1: single executor (Claude Code), serial**, with ground-truth verify + replanning (incl. bounded re-extraction), a minimal live view, and operator confirm-criteria/sign-off. Multi-executor (Codex, Antigravity), per-step routing, parallelism, and the full dashboard are **M2 fast-follow**; pgvector memory is **M3**. See `docs/prd.md` §6/§12.

## Provider Protocol commands

- Discovery: `goal-gen capabilities --json` reports the protocol, request and
  run-event identities, capabilities and transport limits. `version --json`
  continues to report only the package artifact version.
- Opt-in deterministic run: `goal-gen run <request.json> --executor stub --protocol v1 --yes`.
  `--stub-scenario success|failed|budget-exhausted|await-cancel` selects a
  zero-spend scenario; `await-cancel` requires an explicit `--timeout-ms <n>`.
- Protocol v1 is noninteractive and stub-only. Missing required gate consent
  produces structured failure; sign-off is never auto-approved. Real executor
  permission mapping and target-repository execution remain deferred.
- The packet compiler's `ENGINE_VERSION` and packet manifest `engineVersion`
  retain their packet-format meaning and are independent of both identities above.

## Provider Protocol ownership

[Provider Protocol v1](plans/specs/provider-protocol-v1.md) and ADR-0017 define
the installed stdio consumer contract, independently of the PRD's M1/v1 scope.
Preserve the canonical request and run-event/v1; advertise v1 only after all
acceptance gates pass. This milestone admits stub execution only. HTTP, remote
gates, persistence, live providers and target-repository execution remain
separate work. Read the owning specification before changing protocol code.
