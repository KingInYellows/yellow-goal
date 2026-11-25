# yellow-goal — repository root

The product lives in **`goal-gen/`**, a subdirectory of this repo
(`git rev-parse --show-toplevel` is this directory). Read
**`goal-gen/CLAUDE.md`** before doing anything — it is the project constitution —
and run every `npm` command from `goal-gen/`.

What sits at this root and why:

- `.github/workflows/ci.yml` — CI gates (typecheck / test / eval, tarball
  install smoke, operator recipe). Every step runs with `working-directory: goal-gen`.
- `.github/workflows/release.yml` — on an annotated `v*` tag matching
  `goal-gen` `package.json`, re-runs the gates and attaches
  `goal-gen-<ver>.tgz` as a GitHub Release asset. Packaging is tokenless;
  publication alone receives the GitHub token. Consumers pin that URL; do not
  use Actions artifacts.
- `.github/workflows/claude-code-review.yml` — automated Claude Code review of
  PRs touching `goal-gen/**` or the workflows. Gated on the
  `CLAUDE_CODE_OAUTH_TOKEN` Actions secret: absent, the workflow is a green
  no-op. It never invokes the product's executor or runner. Not a required
  status check.
- `.graphite.yml`, `.github/pull_request_template.md` — repo-level PR conventions.
- `REVIEW.md` — review-only rules (what counts as Important, the Nit cap, what
  not to report). Reviewers should read it from the base branch.
- `.github/review-risk.json` — path rules that set a PR's review risk tier
  (low, medium, high) for yellow-review's `classify-risk`, also read from the
  base branch. Use the repository merge check below before each merge.
- `yellow-plugins.example.md` shows the per-checkout setup for yellow-review.
  Copy it to the ignored `yellow-plugins.local.md` when provisioning a review
  checkout and verify the approver login. The cloud SessionStart hook seeds
  the Phase 1 shadow setting only when no local config exists.
- `docs/01`–`08` — research knowledge base that `goal-gen/docs/prd.md` (the
  product source of truth) and the specs cross-link to.
- `HANDOFF-PROMPT.md` — superseded; provenance only.

Never run a real-spend command from CI or an autonomous session: `npm run
runner`, `npm run cli -- run approve`, or `run --executor claude-code` /
`--executor agx-claude-code`. They invoke a real coding agent with real spend.
The only permitted test execution shorthand is
`npm run cli -- run <request> --executor stub`. `.claude/settings.json`
enforces this with deny rules and a PreToolUse guard
(`.claude/hooks/guard-live-executor.mjs`); its SessionStart hook runs
`npm install` in `goal-gen/` for cloud sessions.

## Merge approval

Run the following from a trusted checkout of the default branch immediately
before merging with yellow-review 4.0.0 or newer enabled in the Claude Code
plugin cache. The check combines the shared merge-readiness
report with this repository's human approval policy.

```sh
python3 scripts/check-merge-ready.py PR_NUMBER
```

Low risk needs no human label. For medium or high risk, KingInYellow18 must
manually add `merge-approved` to the current head. If the head changes,
remove and re-add the label. GitHub timestamps have one-second precision,
so a label in the same second as the push also needs re-adding. Only the owner performs that action. Merge the
verified head only. The local check is separate from GitHub branch protection.

## Linear linking

Every branch and pull request in this repo must reference a Linear issue in the
**yellow-goal** team (key `GOAL`). The advisory `linear-link` check warns on PRs that don't.

- Existing work: use Linear's "Copy git branch name" for the branch, or put
  `Fixes GOAL-123` in the PR description (`Refs GOAL-123` for partial work).
- New work with no issue yet: put `Fixes GOAL-NEW` in the PR description.
- Never reference another team's key unless the work genuinely belongs there.
- If Linear links the wrong issue, add `Ignore <ID>` (for example
  `Ignore CLAUDE-123`) to the PR description.
