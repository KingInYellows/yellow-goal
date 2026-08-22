# Schemas

Two provenance tiers:

- `vendored/` — the 10 canonical JSON Schemas from the guidance packet
  (`yellow-goal-harness-guidance/schemas/*.schema.json`), copied as of the guidance packet
  dated 2026-08-21 (see the workspace's `09_IMPLEMENTATION_MILESTONE.md` audit anchor). Kept
  byte-identical except for the documented corrections below.
- `app/` — 7 net-new contracts (`ResolvedRepositoryTarget`, `CommandRecord`,
  `ExternalResearchRecord`, `ModelRoleBinding`, `OrchestrationProfile`, `ValidationResult`,
  `FinalHandoff`) with no guidance-packet predecessor. Authored fresh; not corrections of
  anything vendored.

Markdown is never canonical. Where guidance prose (task briefs, `09_IMPLEMENTATION_MILESTONE.md`,
`07_PACKET_CONTRACT.md`) and a vendored `.schema.json` file disagree, the schema file is
authoritative and the prose is treated as paraphrase/intent. The corrections below are the only
sanctioned exceptions, each made because a specific mission requirement (cited) could not
otherwise be expressed within `additionalProperties: false`.

## Corrections to vendored schemas

All five corrections are minimal, additive, and logged here per the workspace's hard boundary
("structured schemas and accepted ADRs govern architecture" — corrections must be documented,
not silent).

### `orchestration.schema.json` — typed `waves[]`

The guidance schema left `waves` as `{"type": "object"}` per item — explicitly flagged in the
implementation brief as safe to complete. Replaced with a typed `wave` definition:

```
wave: { name: investigation|implementation|verification, maxActive (1-3), readOnly,
        requiresPlanApproval, freshContext, teammates: [{role, modelRole, modelId, ownership}] }
```

### `orchestration.schema.json` — `profileId`/`provider`/`teamMode`/`fallbackMode`/
`mutationBoundaries`/`validationOwnership`, and a completed `lead`

The vendored `OrchestrationSpec` could not express several requirements the mission's own
orchestration-contract description (the original task brief's `OrchestrationSpec` bullet, echoed
in the lead ledger's synthesis decision S6) states are load-bearing:

- `profileId` (string) — which resolved `OrchestrationProfile.id` (e.g.
  `claude-fable-opus-sonnet@1`) this spec's model roles were bound from; without it an
  `OrchestrationSpec` cannot be traced back to the `OrchestrationProfile` that resolved its model
  ids.
- `provider` (string) — e.g. `anthropic`.
- `teamMode` (`const`-like enum of one: `agent-team-preferred`) and `fallbackMode` (enum of one:
  `subagents`) — the brief requires both be declared explicitly per run, not assumed.
- `mutationBoundaries` (non-empty string array) — the brief's explicit list of what teammates may
  never do: stage, commit, push, merge, resolve review threads, change permissions, deploy. This
  was previously nowhere in the contract despite being one of the workspace's hard boundaries
  ("Implementation, push, merge, deployment, and secret operations are separate approval
  transitions").
- `validationOwnership` (string) — who runs final validation before integration (the lead); the
  brief requires this be recorded, not implicit.
- `lead` extended with `modelId` (string) and `responsibilities` (non-empty string array) — the
  brief requires the lead's responsibilities include "sole integrator/final decision-maker"
  semantics; the vendored `lead` previously carried only `role`/`modelRole`, with no way to record
  either the resolved model or what the lead is actually responsible for. That semantic
  requirement (responsibilities must mention sole-integrator/final-decision-maker) is enforced at
  the zod contract layer via `.refine()`, not structurally in the JSON Schema (documented on the
  `responsibilities` property's `description`) — consistent with how `CommandRecord` and
  `FinalHandoff`'s cross-field invariants are handled below.

### `evidence-record.schema.json` — optional `targetSha`

Added `targetSha` (optional, `minLength: 7`) so an evidence record can carry the exact target
commit it was retrieved against, distinct from `ref` (a branch/tag name). Needed because findings
built on stale evidence (target SHA drift) must fail closed per
`06_SECURITY_PERMISSIONS_AND_HUMAN_GATES.md` ("Fail closed when: target SHA changes
unexpectedly").

### `goal-resolution.schema.json` — required `selectedMilestoneId`

Added `selectedMilestoneId` (required, `minLength: 1`). `MilestoneSpec` itself carries no `id`
field (a packet always contains exactly one milestone, per `07_PACKET_CONTRACT.md`'s output
layout — one `05_MILESTONE.md` / `contracts/milestone.json`), so this is a pipeline-assigned
identifier for the selected milestone, not a self-reference inside `milestone.schema.json`. Without
it, `GoalResolution` could not express which milestone was selected, only that one exists.

### `packet-manifest.schema.json` — completed to match `07_PACKET_CONTRACT.md`'s "Manifest
requirements" section

`07_PACKET_CONTRACT.md` is the accepted authority for what the manifest must record (AC-9 in the
milestone acceptance criteria). The vendored schema was missing several of the fields that
section enumerates. Added, all now required unless noted:

- `requestId` — "request ID"
- `target.requestedRef`, `target.resolvedRef` — "target ref" (alongside the existing required
  `target.headSha`, the "exact SHA")
- `inspectionStartedAt`, `inspectionCompletedAt` — "inspection start/end timestamps"
- `analysisModels`, `resolvedOrchestrationModels` (each `{role: modelId}`) — "analysis model
  identifiers" and "resolved orchestration model identifiers" are two distinct concepts in 07;
  replaced the vendored schema's single ambiguous optional `models` object with these two
  specifically-named required objects
- `evidenceGaps` — promoted from optional to required (07: "It must state them explicitly";
  an empty array is how a packet records "none")
- `timestampFields` (array of field-path strings) — 07's "Deterministic compilation" section:
  "Timestamp fields ... should be isolated so reproducibility tests can normalize them"; this is
  the manifest's declaration of which fields are timestamp-normalization points
- `files[].bytes` (optional) — file size alongside the existing required `path`/`sha256`
- `predecessorPacketId` (optional) — 07's "Immutability" section: "a recompiled packet must
  identify its predecessor"

`tools` (tool versions) was already present as an untyped optional object; promoted to required
only, left untyped since tool version shapes are host-specific.

## No changes needed

`finding.schema.json`'s vendored `classification` enum already covers all eight mission
classifications 1:1 (`verified_defect` = verified defect, `strongly_supported_risk` = supported
risk, `documentation_contradiction`, `missing_evidence`, `intentional_limitation`,
`obsolete_finding` = obsolete, `duplicate_finding` = duplicate, `unknown`). No `info` severity was
added — the vendored `severity` enum (`blocking|high|medium|low`) is kept verbatim per explicit
instruction.

`request.schema.json`'s nested `{target:{repository,...}, intent:{goal,...}, mode}` shape, and its
untyped `orchestration: {type:"object"}` bucket, are kept verbatim. The flat convenience input
described in some task prose (`{repository, goal, permissionProfile?, orchestrationProfile?}`) is
handled entirely at the `backend/src/intake` normalization layer, which expands it into this
canonical nested shape and places `permissionProfile`/`orchestrationProfile` inside the schema's
already-untyped `orchestration` object — no schema amendment needed since that property imposes
no structural constraints.

## App schema conventions

Each `app/*.schema.json` follows the vendored schemas' conventions: draft 2020-12,
`additionalProperties: false`, a `schemaVersion` `const`, and enum-typed status/kind fields. Three
cross-field/content invariants (one on a vendored schema, two on app schemas) are intentionally
left undeclared in the JSON Schema and enforced only at the zod contract layer (documented via
`description` in the schema instead, since the hand-rolled structural checker used by the
compatibility tests does not implement `if`/`then` or content-pattern checks on array elements):

- `CommandRecord`: `source == "model-suggested"` implies `executable == false` (model-suggested
  commands are never executable).
- `FinalHandoff`: `status == "READY_AFTER_ONE_NAMED_ACTION"` implies `remainingAction` is present.
- `OrchestrationSpec`: `lead.responsibilities` must include at least one entry expressing
  sole-integrator/final-decision-maker semantics (matched case-insensitively against "sole
  integrator" or "final decision").
