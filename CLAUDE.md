# yellow-goal — repository root

The product lives in **`goal-gen/`**, a subdirectory of this repo
(`git rev-parse --show-toplevel` is this directory). Read
**`goal-gen/CLAUDE.md`** before doing anything — it is the project constitution —
and run every `npm` command from `goal-gen/`.

What sits at this root and why:

- `.github/workflows/ci.yml` — CI gates (typecheck / test / eval + tarball
  install smoke). Every step runs with `working-directory: goal-gen`.
- `.github/workflows/release.yml` — on an annotated `v*` tag matching
  `goal-gen` `package.json`, re-runs the gates and attaches
  `goal-gen-<ver>.tgz` as a GitHub Release asset. Packaging is tokenless;
  publication alone receives the GitHub token. Consumers pin that URL; do not
  use Actions artifacts.
- `.graphite.yml`, `.github/pull_request_template.md` — repo-level PR conventions.
- `docs/01`–`08` — research knowledge base that `goal-gen/docs/prd.md` (the
  product source of truth) and the specs cross-link to.
- `HANDOFF-PROMPT.md` — superseded; provenance only.

Never run `npm run runner` or any live executor from CI or an autonomous
session — it invokes a real coding agent with real spend. The only permitted
test execution shorthand is `npm run cli -- run <request> --executor stub`.
