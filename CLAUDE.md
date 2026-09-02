# yellow-goal — repository root

The product lives in **`goal-gen/`**, a subdirectory of this repo
(`git rev-parse --show-toplevel` is this directory). Read
**`goal-gen/CLAUDE.md`** before doing anything — it is the project constitution —
and run every `npm` command from `goal-gen/`.

What sits at this root and why:

- `.github/workflows/ci.yml` — CI gates (typecheck / test / eval + tarball
  install smoke). Every step runs with `working-directory: goal-gen`.
- `.graphite.yml`, `.github/pull_request_template.md` — repo-level PR conventions.
- `docs/01`–`08` — research knowledge base that `goal-gen/docs/prd.md` (the
  product source of truth) and the specs cross-link to.
- `HANDOFF-PROMPT.md` — superseded; provenance only.

Never run `npm run runner` or any live executor from CI or an autonomous
session — it invokes a real coding agent with real spend.
