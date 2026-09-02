# yellow-goal — repository root (AGENTS.md mirror)

GOAL planning and systems for AI agents (GOAP): plain-English goal → LLM-extracted
action graph → deterministic A* plan → real coding-agent execution with
ground-truth verification.

The product lives in **`goal-gen/`**. Read `goal-gen/AGENTS.md` (Codex mirror of
`goal-gen/CLAUDE.md`, which is canonical) and run every `npm` command from
`goal-gen/`. CI at `.github/workflows/ci.yml` uses `working-directory: goal-gen`.
`HANDOFF-PROMPT.md` is superseded. Never run `npm run runner` or a live executor
from an autonomous session (real agent, real spend).
