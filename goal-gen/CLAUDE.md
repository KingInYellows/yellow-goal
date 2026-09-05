# CLAUDE.md — GOAL Generator

Repo memory + "constitution" for Claude Code. Keep this file tight. Update it when an architectural decision changes. Full product spec: `docs/prd.md`. Component contracts: `.claude/specs/`. Background/architecture: `../docs/05-self-hosted-build-blueprint.md`.

## What this is
A self-hosted app: plain-English goal → LLM-extracted action graph → deterministic A\* GOAP plan → orchestrator dispatches each action to a headless coding-agent CLI → ground-truth verification → replanning → live view. **Local, single-operator**, self-hosted on a Proxmox LXC or VM.

**v1 = M1 (single-executor core):** Claude Code (`claude -p`) only, run **serially**; extract → plan → confirm definition of done → execute → verify → replan, with a minimal live view. Multi-executor (Codex, Antigravity) + per-step routing + parallelism + full dashboard are **M2 fast-follow**; pgvector memory is **M3**. See `docs/prd.md` §6/§12.

**Second subsystem — Universal Repository Goal Packet Compiler (shipped):** a **read-only** pipeline (`request create/validate` → `inspect` → `analyze` → `compile` → `packet verify`, via `npm run cli`) that turns any supported Git repository + plain-English goal into a schema-valid, tamper-evident ZIP implementation packet (`repository-goal-packet@1`). It never mutates target repositories, rejects unknown permission/orchestration profiles fail-closed, and must not import executor/orchestrator mutation code. Contract: `.claude/specs/packet-compiler.md` (read before touching `backend/src/{contracts,intake,inspection,evidence,research,analysis,packs,packets,cli}`).

## Stack (decided)
- **Language:** TypeScript end-to-end.
- **Frontend:** React + Vite + Tailwind + shadcn/ui. Lift `goal_ui`'s MIT planner + plan-tree/state-card components liberally where they fit (keep license headers); build the real-event run view fresh.
- **Backend/orchestrator:** Node (Hono or Fastify); built on the **Claude Agent SDK** where useful.
- **DB:** Postgres + pgvector.
- **Realtime:** WebSocket/SSE.
- **Executors:** host-installed CLIs invoked headless. **v1: `claude` only**; `codex` + `agy` at M2.
- **Extraction LLM:** headless `claude -p` (subscription; no API key); strict JSON + zod repair; swappable behind a thin interface later.

## Repo layout
```
CLAUDE.md · AGENTS.md
.claude/specs/        # component contracts (read before implementing a component)
docs/                 # prd.md (source of truth) + decisions/ (ADRs, MADR) + solutions/ (compounded learnings)
plans/                # active plans + specs/ (requirement specs with stable R-/RR-ids, e.g. request-to-run-pipeline.md)
backend/src/          # M1 core: planner/ extractors/ executors/ orchestrator/ db/ run/ events/ paths/
                      # compiler: contracts/ intake/ inspection/ evidence/ research/
                      #           analysis/ packs/ packets/ providers/ cli/
bin/goal-gen.mjs      # installed-package entry (tsx shim, ADR-0016) — same contract as `npm run cli --`
scripts/              # install-smoke.sh (pack → install → spawn gate; runs in CI)
schemas/ · policies/  # vendored JSON Schemas (+ corrections log) and permission policies
packs/                # repository-goal-packet/v1 pack assets (templates, prompts, scripts)
frontend/src/         # (future) components/ pages/ lib/
tests/                # unit + contract + fixture + adversarial + integration + db/ (migration gate) + evals/
../.github/workflows/ci.yml        # CI lives at the repo root; every step uses working-directory: goal-gen
../.github/workflows/release.yml   # annotated v* tag → GitHub Release asset goal-gen-<ver>.tgz
```

**Repo root gotcha:** this project lives in `goal-gen/`, a *subdirectory* of the git repo rooted at the parent `yellow-goal/` (`git rev-parse --show-toplevel` → `yellow-goal`). Run `git`/`gt` from anywhere in the tree, but note: repo-level config (`.graphite.yml`, PR template) sits at the `yellow-goal` root, while project-local config (`.gitignore`, `.ruvector/`, `.claude/*.local.md`) lives in `goal-gen/`. Tools that probe `show-toplevel` for project files will look one level too high.

## Core invariants (do not violate)
1. **The planner is deterministic.** A\* over symbolic state; no LLM inside the planner. The LLM only *authors* the action graph (in the extractor) and *executes* steps (in executors). Replanning re-runs the deterministic planner; when the existing pool can't reach the goal, the extractor re-authors **additional** actions (append-only, bounded) — the *decision* to re-extract is deterministic (no-plan / N failures).
2. **World state comes from ground truth.** Set state from real exit codes / test output / diffs — never trust an action's declared effect.
3. **Every action has a `verify` check.** No verify → not executable.
4. **Executors are interchangeable** behind one `Executor` interface. The **extraction LLM runs via headless `claude -p`** (subscription; no API key) behind a thin interface so it can be swapped later. `claude -p` has **no server-side forced tool-use**, so strict JSON is prompt-enforced + **zod-repaired**, not guaranteed.
5. **Isolation:** each agent run gets its own git worktree — this is **collision-avoidance (never two writers on the same files), NOT a security sandbox**. In v1 the host LXC/VM is the blast radius; **per-run containers arrive at M2**.
6. **Guardrails are mandatory:** enforce max replans, max budget (USD), wall-clock, per-action retries, max re-extractions, and loop detection on every run. **Defaults (v1, overridable):** $20/run · 5 replans · ≤2 re-extractions · 60-min wall-clock · 3 retries/action · concurrency 1 · loop = same action fails the same way twice → stop & escalate.

## Conventions
- Types-first: define `GoalSpec`/`Action`/`WorldState`/`Plan` (see `.claude/specs/planner.md`) before logic; validate LLM output with **zod**.
- Spec-driven: read the relevant `.claude/specs/*.md` before implementing a component; if behavior must change, update the spec first. **Read the relevant ADR in `docs/decisions/` before changing a locked decision; supersede with a new ADR rather than editing an accepted one.**
- Small, pure functions in the planner; side effects only in executors/db.
- Secrets via environment only — never commit keys; never put secrets in this file.
- No destructive git ops (force-push, hard reset, branch delete) without explicit approval.
- Never edit a test, fixture, or `verify` to make it pass — flag it; if behavior must change, update the spec (and supersede the ADR) first.

## Workflow (how to build this with Claude Code)
- Explore → **Plan Mode** for any multi-file work → code → commit; review diffs in a fresh subagent.
- Use **subagents in isolated worktrees** for parallel components.
- Track work with the task list; one component spec = one work stream.
- **Eval-driven:** keep `tests/evals/` (goal→expected-plan pairs); run before/after planner or prompt changes.

## Commands (frontend/lint still TBD)
- Install: `npm install` (CI uses `npm ci`; npm only — never pnpm/yarn here)
- Dev: `TBD` (frontend `vite`, backend watch — not scaffolded yet)
- Test: `npm test` (`vitest run`, full deterministic suite — no live network/model calls) · `npm run test:watch`
- Evals: `npm run eval` (all) · `npm run eval:planner` (planner gate)
- Typecheck: `npm run typecheck` (`tsc --noEmit`, strict)
- Compiler CLI: `npm run cli -- <request create|request validate|inspect|analyze|compile|packet verify> ... [--json]`
- Identity probe: `npm run cli -- version --json` (RR17; installed bin: `goal-gen version --json`)
- Run: `npm run cli -- run <request.json> --executor stub|claude-code` (RR11–RR20). `stub` is zero-spend and the only executor tests/CI may use. `claude-code` is real spend — never from CI or an autonomous session.
- Install gate: `bash scripts/install-smoke.sh` (packs the tarball, installs it in a scratch dir, drives the `goal-gen` bin as a process — safe locally)
- Migrations: `npm run db:generate` after any `backend/src/db/schema.ts` change (writes the SQL + journal + snapshot that `tests/db/migrations.test.ts` replays) · `npm run db:migrate`
- Test-only zero-spend run: `npm run cli -- run <request.json> --executor stub`. The M1 runner (`npm run runner -- [--yes] "<goal>"` or `npm run runner -- [--yes] --request <file>`) is human-only: it can invoke real `claude -p`; never copy it into CI or an autonomous session.
- Lint/format: `TBD` (not configured yet)

## Process contract & CI (ADR-0016)
- The engine is consumed **as a process**, never imported: `npm pack` tarball → `goal-gen` bin. Consumers (the yellow-plugins bridge) parse **JSON stdout**, structured command-failure stderr `{"error":{"code","message"}}`, and exit codes **0 = success, 2 = `USAGE_ERROR`, 1 = other command failures**. The explicit exception is a schema-invalid `request validate`: it is a domain result with exit 1, one stdout object `{path,valid:false,errors}`, and empty stderr. Keep every verb on that contract (`backend/src/cli/index.ts`).
- `tsx` and `zod` are **runtime** dependencies because the packed artifact ships TypeScript source loaded through `bin/goal-gen.mjs` — do not move them to `devDependencies`.
- CI (`../.github/workflows/ci.yml`, GitHub-hosted `ubuntu-latest`, Node 22.22.x): job `engine` = typecheck → test → eval; job `install-smoke` = `scripts/install-smoke.sh`. `npm test` includes only `tests/**/*.test.ts`; anything touching a live resource uses the `*.probe.ts` suffix (`tests/integration/runner.probe.ts`) and must stay outside that glob — **CI must never execute a real agent**.
- Releases (`../.github/workflows/release.yml`): an annotated `v*` tag (`git tag -a vX.Y.Z -m vX.Y.Z`) that matches `package.json` version and peels to `HEAD` re-runs those gates and attaches `goal-gen-<ver>.tgz` as a GitHub Release asset (unmetered; never `actions/upload-artifact`). Packing runs with `GH_TOKEN` absent; the token is scoped only to idempotent Release publication, which verifies asset SHA-256 before publishing a draft. To recover an existing tag after a partial publish, dispatch Release from `main` with `-f tag=vX.Y.Z -f commit=<expected-40-character-commit>`; the workflow checks out that immutable tag, verifies the expected peeled commit, and never retags it. Consumers pin that URL. Do not cut a tag from an autonomous session.
- Gates that fail on drift: `tests/contracts/compat.test.ts` (zod ↔ vendored JSON Schema — change both together) and `tests/db/migrations.test.ts` (journal SQL vs `schema.ts` on embedded PGlite — run `npm run db:generate`). PGlite boots slowly in parallel workers, hence the 30s vitest timeouts; they bound hangs, not pace the suite.
- The verb surface is specified in `plans/specs/request-to-run-pipeline.md` (RR-ids). `run` and `version` are dispatched in `backend/src/cli/index.ts`. `run --executor claude-code` is a real-spend entry point; `stub` is the zero-spend deterministic engine for tests.

## Host
Runs on a dedicated **Proxmox LXC or VM** with Claude Code logged in once (v1); per-run worktrees (collision-avoidance, not a sandbox); **single-admin login**, reachable only on your own network/Tailscale — no LAN-wide or public exposure. A VM is cleaner if you'll run per-run containers at M2 (nesting in an unprivileged LXC needs extra config). See `docs/prd.md` §11.

## Docs to bookmark
Claude Agent SDK: https://platform.claude.com/docs/en/agent-sdk/overview · Claude Code headless: https://code.claude.com/docs/en/headless · Hooks: https://code.claude.com/docs/en/hooks · MCP: https://code.claude.com/docs/en/mcp

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
