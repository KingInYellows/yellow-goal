# yellow-goal — repository root (AGENTS.md mirror)

GOAL planning and systems for AI agents (GOAP): plain-English goal → LLM-extracted
action graph → deterministic A* plan → real coding-agent execution with
ground-truth verification.

The product lives in **`goal-gen/`**. Read `goal-gen/AGENTS.md` (Codex mirror of
`goal-gen/CLAUDE.md`, which is canonical) and run every `npm` command from
`goal-gen/`. CI at `.github/workflows/ci.yml` uses `working-directory: goal-gen`.
An annotated `v*` tag matching `goal-gen/package.json` publishes the tarball
via `.github/workflows/release.yml` as a GitHub Release asset. The workflow
packs without credentials, verifies its peeled commit is `HEAD`, and scopes its
token to GitHub Release publication. `HANDOFF-PROMPT.md` is superseded. Never
run `npm run runner` (use `npm run cli -- run <request> --executor stub` only in
tests) or a live executor from an autonomous session.
