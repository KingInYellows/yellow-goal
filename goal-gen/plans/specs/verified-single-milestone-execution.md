# Verified single-milestone execution — Yellow Harness outcome

Status: proposed design; documentation slice only at this revision.
Date: 2026-09-19. Owner: Yellow Goal (Yellow Harness coordination).
Decision: [ADR-0018](../../docs/decisions/0018-verified-single-milestone-execution.md).
Engine base: `09bcd16cd25ec249e3248d3ce7dcb4536a0d348e`.

## Outcome

Given one explicitly approved milestone, one named repository, and one immutable base
revision, Yellow Harness dispatches **one** bounded implementation worker and returns
either:

1. a reviewable patch on that base, plus independently checked acceptance evidence, or
2. an evidence-backed blocker.

No automatic merge, publication, or deployment.

A PR-readiness report alone is not this outcome. Cursor plugin parity is not a
prerequisite. Protocol v1 stays stub-only.

## Requirements

| ID | Requirement |
|---|---|
| VS-01 | One owner repository per milestone; plugins work is a separate milestone, never a dual-root write. |
| VS-02 | Base revision is recorded before the writer starts; the writer does not retarget main silently. |
| VS-03 | Coordinator is not the source writer. Reviewers stay `readonly: true`. |
| VS-04 | Acceptance checks are listed up front. Each is recorded as passed / failed / blocked / not-run with command, cwd, and revision. Exit status is required for passed/failed; blocked or not-run checks omit exit status or record null with a reason. Missing ≠ passed. |
| VS-05 | Independent verification consumes VS-04 plus the diff. Worker narrative cannot succeed the milestone. |
| VS-06 | Blockers include: missing evidence, checks not-run, stack-provider unresolved when mutation is required, overlapping unreviewed file conflict, attempt to use live `claude-code` / `npm run runner` / protocol real execution. |
| VS-07 | Compiler isolation and process-pin consumption are unchanged. No cross-repo TS import. |

## Non-goals

Live target-bound execution; Protocol v1 capability adds; HTTP/SSE; persistence/control-plane;
merge queue; subscriptions; CE config; publishing `goal-gen` or plugins; copying generated
Cursor plugins into `~/.cursor/plugins/local`.

## Smallest prerequisite implementation slice

**Owner:** yellow-goal. **This planning turn.**

Land only:

1. PRD amendment (FR-14–FR-17 + §12 note)
2. ADR-0018 (proposed → accepted only with explicit acceptance)
3. this spec under `goal-gen/plans/specs/`

No `backend/`, no protocol, no pin.ts, no yellow-plugins, no `.cursor/` files, no
`.compound-engineering/`.

**Verification (docs-only):**

```bash
cd goal-gen && git diff --check
```

Do not run `npm test` / `npm run eval` as a gate for a docs-only PR unless the worker also
touches code.

## Later code slice (not authorized, not a second spec)

Fixture-only acceptance-evidence record emitted by the engine process (JSON stdout, existing
error/exit contract), against a disposable git fixture, never the sibling plugins clone.
Deterministic local checks only. No protocol `capabilities` change. No live provider.

## Failure / blocked cases for the docs slice

| Case | Result |
|---|---|
| ADR-0018 number already used on refreshed main | Block; pick next free MADR number |
| PRD edit rewrites M1/M2/M3 or protocol advertised ops | Block; out of scope |
| Worker includes `.cursor/` or CE files | Block |
| Stack provider not READY and mutation is requested | Block; do not raw-push |
| Reviewer flipped off `readonly` to “just run tests” | Block |

## Four `.cursor` files

Not required for this milestone. Host bootstrap is a separate candidate after a content review.
