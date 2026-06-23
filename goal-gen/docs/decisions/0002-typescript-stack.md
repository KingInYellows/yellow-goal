---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0002. TypeScript end-to-end stack + Postgres/pgvector

## Context and problem statement
We need a stack spanning a UI, a deterministic planner, an orchestrator that spawns CLI subprocesses, relational persistence, and (later) vector memory — and we want to reuse `goal_ui` (MIT, TypeScript) and share types end-to-end.

## Decision
**TypeScript end-to-end:** React + Vite + Tailwind + shadcn/ui (frontend); Node (Hono or Fastify) orchestrator, on the Claude Agent SDK where useful; **Postgres + pgvector** for relational + vector in one engine. Retrieval-augmented extraction over pgvector is deferred to M3.

## Alternatives considered
- **Python/FastAPI backend** — viable, but can't reuse `goal_ui`'s TS planner/UI and adds a TS↔Python bridge.
- **Separate vector DB** — unnecessary; pgvector covers v1/M3 needs in one engine.

## Consequences
- 👍 One language, shared types, direct `goal_ui` reuse, simple ops.
- 👎 Node CLI-subprocess orchestration must handle streaming/backpressure carefully.

## Confirmation
PRD §9 (portability); `package.json`/`tsconfig.json` once scaffolded.

## Links
- PRD §9, doc 05 §8, [[0003]].
