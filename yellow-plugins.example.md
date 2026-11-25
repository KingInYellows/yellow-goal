---
review_pipeline: workflow
review_approval_gate: advisory
review_approval_humans: [KingInYellow18]
---

Copy this example to the ignored repository-root `yellow-plugins.local.md` in
each review checkout. Keep the approver list under operator control. The shared
gate reports its approval evidence in advisory mode. The repository merge
check in `scripts/check-merge-ready.py` enforces the Phase 2 human label rule.
