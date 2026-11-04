---
# yellow-plugins per-project config, read by yellow-review's /review:pr.
# Schema: yellow-core's local-config skill.
review_pipeline: workflow
---

# yellow-plugins settings for yellow-goal

`review_pipeline: workflow` is phase 1 of the risk-tiered review pipeline
(GOAL-45). `/review:pr` runs its usual persona review and, beside it, the
yellow-review `review-gate` workflow on the same diff. The workflow's findings
are only compared in the report's Coverage section; they are never applied,
posted or written to the review ledger. Remove the line, or set
`review_pipeline: persona`, to stop the shadow run.

This file is tracked so cloud sessions get the same setting. Keys that
yellow-review ignores in a tracked file (approval-gate keys,
`resolve_pr.verify_unattended`) do not belong here.
