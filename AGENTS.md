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
token to GitHub Release publication. `.github/workflows/claude-code-review.yml`
runs an automated Claude Code review on PRs touching `goal-gen/**` or the
workflows, gated on the `CLAUDE_CODE_OAUTH_TOKEN` secret (green no-op without
it); it never invokes the product's executor. `HANDOFF-PROMPT.md` is superseded. Never
run `npm run runner`, `npm run cli -- run approve`, or `run --executor
claude-code` / `--executor agx-claude-code` from CI or an autonomous session
(use `npm run cli -- run <request> --executor stub` only in tests).

## Linear linking

Every branch and pull request in this repo must reference a Linear issue in the
**yellow-goal** team (key `GOAL`). The advisory `linear-link` check warns on PRs that don't.

- Existing work: use Linear's "Copy git branch name" for the branch, or put
  `Fixes GOAL-123` in the PR description (`Refs GOAL-123` for partial work).
- New work with no issue yet: put `Fixes GOAL-NEW` in the PR description.
- Never reference another team's key unless the work genuinely belongs there.
- If Linear links the wrong issue, add `Ignore <ID>` (for example
  `Ignore CLAUDE-123`) to the PR description.
