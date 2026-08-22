# GOAL Generator

Self-hosted, single-user system with two subsystems:

1. **Execution core (M1, shipped):** a plain-English goal becomes an inspectable **GOAP plan** that is **executed by a real coding agent**. An LLM extracts a structured action graph; a deterministic **A\*** planner orders it into a valid, lowest-cost plan; an orchestrator dispatches each step to headless `claude -p`; real results drive ground-truth verification and replanning.
2. **Universal Repository Goal Packet Compiler (shipped):** a **read-only** pipeline that takes any supported Git repository plus a plain-English goal, deterministically inspects it without mutating it, builds an append-only evidence ledger, produces a schema-constrained assessment and goal resolution, selects exactly one milestone, and compiles a schema-valid, tamper-evident, verified ZIP implementation packet (`repository-goal-packet@1`). See [`.claude/specs/packet-compiler.md`](.claude/specs/packet-compiler.md).

**Status:** M0 (deterministic planner + evals) and M1 (single-executor core: extract → plan → confirm → execute → verify → replan, with persistence and control gates) are implemented and green. The packet compiler is implemented with contracts, fixtures, adversarial validation, and golden packets. Milestones: [`docs/prd.md`](docs/prd.md) §12.

## Compiler quick journey

```bash
npm run cli -- request create --repo OWNER/REPO --goal "desired outcome" --output request.json
npm run cli -- request validate request.json
npm run cli -- inspect request.json --output out/inspection
npm run cli -- analyze request.json --profile out/inspection/repo-profile.json --output out/analysis
npm run cli -- compile request.json --assessment out/analysis/assessment.json --pack repository-goal-packet@1 --output out/packet
npm run cli -- packet verify out/packet/<packet>.zip
```

A minimal request needs only `--repo` and `--goal`. Compiler mode never mutates the target repository; unknown permission or orchestration profiles are rejected (never defaulted); generated launch material never uses `bypassPermissions`. The default orchestration profile `claude-fable-opus-sonnet@1` resolves Fable 5 (`claude-fable-5`) as sole lead, Opus 5 (`claude-opus-5`) for deep investigation/verification, and Sonnet 5 (`claude-sonnet-5`) for bounded implementation work.

## Why
`goal.ruv.io` markets this but ships a mock (its "live agents" are a `setTimeout` animation). This builds the two missing pieces: **dynamic LLM action-graph extraction** and a **real execution + telemetry layer**. Full research is in the parent knowledge base (`../docs/01`–`08`).

## Stack (ADR-0002)
TypeScript end-to-end — React/Vite (frontend) · Node (orchestrator/API) · Postgres + pgvector. Executors: host-installed `claude` (v1), then `codex`, `agy`.

## Quickstart
Run from this `goal-gen/` directory:
```bash
nvm use            # Node 22+ (.nvmrc)
npm install
npm test           # full deterministic suite (no live network, no live model calls)
npm run eval:planner
npm run typecheck
```
All tests pass; nothing is skipped. The real-cost integration probe (`tests/integration/runner.probe.ts`) is deliberately outside the `npm test` glob.

## Layout
| Path | What |
|------|------|
| `docs/prd.md` | Source-of-truth scope. |
| `docs/decisions/` | ADRs (MADR) — read before changing a locked decision. |
| `.claude/specs/` | Per-component contracts (incl. [`packet-compiler.md`](.claude/specs/packet-compiler.md)). |
| `CLAUDE.md` · `AGENTS.md` | Agent constitution (Claude Code / Codex). |
| `backend/src/planner/` · `extractors/` · `executors/` · `orchestrator/` · `db/` | M1 execution core (deterministic A\* planner, LLM extractor, `claude -p` executor, orchestrator loop, persistence). |
| `backend/src/contracts/` · `intake/` · `inspection/` · `evidence/` · `research/` · `analysis/` · `packs/` · `packets/` · `cli/` | Packet compiler (read-only; never imports the execution core's mutation code). |
| `schemas/` · `policies/` · `packs/repository-goal-packet/v1/` | Vendored JSON Schemas (corrections logged in `schemas/README.md`), permission/protected-path policies, and the versioned pack. |
| `tests/` | Unit, contract, fixture, adversarial, and eval suites; fixture target repos under `tests/fixtures/repositories/`. |

## Building this with Claude Code
This repo is structured for spec-driven, eval-driven development. Read the relevant `.claude/specs/*.md` before implementing a component. (`docs/claude-code-handoff.md` is the historical M0 bootstrap document.)

## License
Private; license TBD. Third-party attributions in [`NOTICE`](NOTICE).
