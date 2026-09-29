---
title: 'flow:decompose Shells: spec-r-ids Is the Whole-Spec Snapshot, and Shells May Exist Only in Another Worktree'
date: 2026-09-28
category: workflow
track: knowledge
problem: 'decompose shells list every spec R-id in spec-r-ids (looks like a bug) and pick-next-shell on the main checkout finds no shells that live untracked in a PR worktree'
tags: [flow-decompose, pick-next-shell, spec-r-ids, shells, worktrees, spec-drift]
components: [yellow-core/flow, goal-gen/plans/shells]
source: 'expanding approval-gated-real-execution shell 01 (PR #53)'
---

# flow:decompose Shells and Where to Find Them

## Context

While expanding approval-gated-real-execution shell 01, every shell showed
`spec-r-ids` listing all of R1..R35, which looked like a broken decompose.

## Guidance

- **Not a bug.** `spec-r-ids` is intentionally the full spec R-id snapshot
  (it is what the spec-drift check compares against). The per-shell slice is
  the `Covers` section in the shell body (R1-R6 for shell 01). Read `Covers`,
  not the frontmatter, to scope a shell.
- **Shells can be untracked.** Decompose output under `plans/shells/` may
  exist only as untracked files in the worktree of the PR that produced it
  (here `worktrees/yellow-goal/agent-docs-step-6-brainstorm`, PR #53), and
  `plans/complete/` may exist only in an archive PR's worktree. Running
  `/flow:pick-next-shell` from the main checkout then reports nothing. Before
  concluding there is no work, check `git -C yellow-goal worktree list` and
  `gh pr list -R KingInYellows/yellow-goal`, then run from the right worktree.
