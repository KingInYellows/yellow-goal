---
title: 'Compound-Staging Auto-Promotion Writes Docs to Repo Root Instead of Project Root in Monorepo Subdirectories'
date: 2026-06-30
category: workflow
track: bug
problem: 'yellow-core staging-promoter resolves docs/solutions/ write path via git rev-parse --show-toplevel, writing one level too high for goal-gen (a monorepo subdir); also truncates auto-generated titles mid-word'
tags: [compound-staging, staging-promoter, monorepo, show-toplevel, path-resolution, title-truncation, docs-solutions]
components: [yellow-core/compound-staging, staging-promoter]
source: 'review:sweep-all across PR #10 (KingInYellows/yellow-goal)'
---

# Compound-Staging Auto-Promotion Writes Docs to Repo Root Instead of Project Root in Monorepo Subdirectories

## Problem

yellow-core's compound-staging pipeline (SessionStart hook -> `claude -p`
drain session -> `staging-reviewer` -> `staging-promoter`) auto-promoted 3
session-transcript findings into solution docs for the `goal-gen` project.
All 6 resulting files (3 `.md` docs + 3 `.promote-done` markers) landed at
the monorepo root's `docs/solutions/integration-issues/...` instead of the
project-scoped `goal-gen/docs/solutions/integration-issues/...`. One of the
three docs also had its YAML `title`, its H1 heading, and its derived
filename slug truncated mid-word.

## Symptoms

- `git -C <repo> ls-tree -r --name-only HEAD -- docs/solutions/` (run from
  the `yellow-goal` monorepo root) found all 6 newly auto-promoted files;
  the equivalent query scoped to `goal-gen/docs/solutions/` returned empty.
- One doc's frontmatter `title` and matching H1 were cut off mid-word at
  ~60 / ~50 characters respectively, missing the closing paren and the rest
  of the sentence — e.g. `title: 'During GOAP Re-Extraction (Append-Only
  Action Authoring Afte` (missing `r a Verify Failure): ...`). The filename
  itself was derived from this same truncated slug.
- All 3 auto-generated docs' "Source" sections referenced
  `plans/background-compounding-triggers.md`, a file that does not exist
  anywhere in the repo (confirmed via full-repo `ls-tree` search) — the
  pipeline hardcodes this reference without checking it resolves.
- **Ruled out, not a symptom:** the project's MEMORY.md Session Notes index
  links to these docs as `docs/solutions/integration-issues/....md` with no
  `goal-gen/` prefix. This looks at first glance like the same bug leaking
  into the index, but it is not: MEMORY.md's relative links are read
  against the project's own working directory (`goal-gen/`), not the git
  root, so the unprefixed form is the *correct* convention there — verified
  directly with `[ -f docs/solutions/... ]` (resolves) vs.
  `[ -f goal-gen/docs/solutions/... ]` (does not resolve), both run from
  `goal-gen/` as cwd. Do not "fix" these links by adding a `goal-gen/`
  prefix — that would break them. This is a distinct convention from the
  file-placement bug above, and worth noting because it is easy to conflate
  the two.

## What Didn't Work / Root Cause

`goal-gen`'s own `CLAUDE.md` documents this exact gotcha under "Repo root
gotcha": `goal-gen` is a *subdirectory* of a git repo rooted at the parent
`yellow-goal/` — `git rev-parse --show-toplevel` returns `yellow-goal`, not
`goal-gen`. "Tools that probe `show-toplevel` for project files will look
one level too high." `staging-promoter` (shared across every project
registered with the yellow-core plugin) almost certainly resolves its
`docs/solutions/` write path this way — via `show-toplevel` or an
equivalent repo-root heuristic — rather than via a project-local marker
(nearest ancestor `CLAUDE.md`, or an explicit configured project root).
This is a systemic risk for *any* monorepo project registered with
yellow-core where the working project is a subdirectory of the git root,
not unique to this one incident.

The title-truncation bug is unrelated to path resolution: the pipeline's
title-generation/slugification step appears to apply an unguarded hard
character-count cap to the title *before* the full sentence is composed,
or shares a single length cap between the filename slug and the display
title/heading instead of scoping the cap to the filename only.

## Solution

Fixed directly on the PR branch (`agent/docs/m1-compound-solutions`,
commit `6fab49e`):

1. `git mv` all 6 files from root `docs/solutions/integration-issues/`
   into `goal-gen/docs/solutions/integration-issues/`, confirmed via
   `goal-gen/docs/decisions/` and `goal-gen/docs/brainstorms/` as the
   precedent for correct nesting.
2. Manually restored the full title/heading text in the truncated doc and renamed the truncated doc/marker slug to the complete `during-goap-re-extraction-append-only-action-authoring-after-verify-failure` form.
3. Deleted the dangling `plans/background-compounding-triggers.md`
   reference line from all 3 docs.
4. `git add -A` before `gt modify` (see [[gt-modify-stage-first]] — `gt
   modify` here amends only staged changes), then `gt submit
   --no-interactive`, then verified the fix landed on the remote with
   `git show origin/agent/docs/m1-compound-solutions:<path>` before
   treating either finding as resolved.

The upstream pipeline bug itself (in `staging-promoter`) is **not** fixed
by this — only this PR's 6 files were relocated/repaired. Future
auto-promoted docs in `goal-gen` (or any other subdirectory-nested project
using yellow-core) will hit the same defect until `staging-promoter` is
patched upstream.

## Why This Works

`git mv` preserves file history while relocating into the directory this
project's own `CLAUDE.md` declares canonical. Verifying against
`origin/<branch>` rather than trusting the local working tree or `gt
modify`'s reported diffstat closes the same trust gap documented in
[[gt-modify-stage-first]]: a plausible-looking diffstat is not evidence the
right content actually shipped.

## Prevention

- **Upstream (yellow-core / staging-promoter):** resolve the
  `docs/solutions/` write path from the nearest ancestor project marker —
  e.g. presence of a project-local `CLAUDE.md` — rather than `git
  rev-parse --show-toplevel`, whenever the invoking project directory
  differs from the git root. (MEMORY.md's own relative links are a
  separate, already-correct convention — see Symptoms above — do not
  "fix" those.)
- **Upstream (title generation):** compose the full title/H1 string first;
  apply any length cap only to the derived filename slug, never to the
  display title or heading.
- **Upstream (Source section):** validate that any hardcoded
  "Source: `plans/...`" reference actually resolves before writing it, or
  drop the line when it doesn't.
- **In this project:** after any compound-staging auto-promotion, verify
  placement with `git ls-tree -r --name-only HEAD -- docs/solutions/` run
  from the `yellow-goal` root — a nonempty result there (rather than empty,
  with the real files under `goal-gen/docs/solutions/`) is the earliest
  tell that files landed one level too high.
- **In this project:** when adding a new MEMORY.md Session Notes line,
  match the existing unprefixed convention (`docs/solutions/<category>/<slug>.md`,
  not `goal-gen/docs/solutions/...`) — links there resolve against
  `goal-gen/` as cwd, not the git root.
