# repository-goal-packet@1

Compiles a repository inspection and user-requested goal into:

- repository judgment;
- evidence-backed findings;
- explicit goal relationship;
- one milestone;
- orchestrator design;
- validation and human gates;
- master prompt, persistent goal, and review prompt;
- integrity-checked ZIP.

The pack is read-only against the target repository.

## Phase 2 reconciliation

Phase 1 of this pack was authored before Worker A's contracts (`backend/src/contracts/`)
landed, using provisional placeholder names inferred from the guidance packet's JSON Schemas.
This section was corrected twice against the real Zod contracts, because
`contracts/orchestration.ts` itself changed mid-reconciliation (Worker A completing it further
after this worker's first read) — the second pass caught the drift before any compiler code
depended on the first pass's placeholder names, so no template ever shipped with the
intermediate, now-wrong shape. The corrections that stuck:

- `orchestration.waves[].teammates[]` is a real variable-length (1-3, per `maxActive`) typed
  array, so the Phase 1 fixed `ORCH_*_AGENT{1,2,3}_*` placeholders were replaced with per-wave
  list fragments (`{{ORCH_INVESTIGATION_TEAMMATES_LIST}}` etc.) that render exactly as many
  lines as there are teammates.
- The final `OrchestrationSpec` does carry `profileId`, `provider`, `teamMode`, `fallbackMode`,
  `mutationBoundaries[]`, and `validationOwnership`, and its `lead` carries `modelId` and
  `responsibilities[]` directly — the templates read these straight off `orchestration.*`, not
  off a separate `orchestrationProfile` render-context object (an intermediate design this pack
  briefly used and then dropped once the richer `OrchestrationSpec` landed).
- `GoalResolution` gained a required `selectedMilestoneId`.
- Every generic `{{ target.repository }}` placeholder was renamed to
  `{{ repoProfile.target.repository }}`, since no contract actually exposes a bare `target`
  object at the render root.

All corrections are logged inline in the tables below and in each affected template.

## Analysis-bundle handoff convention (`inspect` → `analyze` → `compile`)

`AnalyzeArgs` (`backend/src/cli/types.ts`) carries only `repoProfilePath`, not a path to
evidence or external research; `CompileArgs` carries only `assessmentPath`, not a
`repoProfilePath`, `goalResolutionPath`, `milestonePath`, or `orchestrationPath`. Neither CLI
interface hands every stage everything the next stage needs, so `backend/src/analysis/bundle.ts`
defines the one convention that bridges the gap — this is the canonical description; if it and a
module doc comment ever disagree, `bundle.ts`'s `BUNDLE_FILES` constant is authoritative:

- **`inspect`'s output directory** (the parent of `InspectResult.repoProfilePath`) is expected to
  also contain, as OPTIONAL siblings mirroring the compiled packet's own relative layout:
  `evidence/evidence.jsonl`, `evidence/research-sources.json`, `research/external-research.jsonl`.
  A missing sibling degrades to an empty array (an evidence gap, not a hard failure) — this
  module does not yet know worker B's real `inspectRepository` output shape, so it fails soft
  here rather than guessing wrong and blocking every analyze call.
- **`analyze`'s output directory** (`AnalyzeArgs.outputDir`) is a self-contained bundle: the three
  required outputs (`assessment.json`, `goal-resolution.json`, `milestone.json`) plus a
  deterministically-resolved `orchestration.json` (pack-policy resolution, not model judgment —
  see `backend/src/analysis/orchestration-defaults.ts`), a `provider.json` sidecar (`{providerId}`,
  not a contract file — lets `compile` attribute `PacketManifest.analysisModels` correctly without
  re-running analysis), and pass-through copies of `repository-profile.json` and the
  evidence/research siblings above.
- **`compile`** derives its input bundle directory as `path.dirname(assessmentPath)` and reads
  the same fixed sibling names. Unlike the `inspect` siblings, every file `compile` needs from this
  bundle is REQUIRED and produced only by this module's own `analyze` (`repository-profile.json`,
  `goal-resolution.json`, `milestone.json`, `orchestration.json`) — a missing one is a hard,
  structured failure naming the exact missing file (`BundleValidationError`, e.g.
  `"goal-resolution.json: cannot read <path>: ENOENT..."`), never a silent fallback or a default
  value. `provider.json` is required: a missing or empty `providerId` is a `BundleValidationError`,
  never a silent `"unknown"` provenance label.

This convention is not yet exercised against a real `inspectRepository` — only against this
worker's own fixtures (`tests/fixtures/analysis/`). If worker B's actual output directory shape
differs, `bundle.ts`'s `BUNDLE_FILES` constant and the two `read*Siblings`/`readAnalysisBundle`
functions are the only place that needs to change.

## Provenance

Vendored from `yellow-goal-harness-guidance/packs/repository-goal-packet/v1/` and
`yellow-goal-harness-guidance/templates/`, `prompts/`, `scripts/` on 2026-08-22, then corrected
and completed per the M1 lead's canonical file-list decision (see the lead's ledger, S2). The
guidance packet is architecture source, not a ready-to-ship pack — several of its own documents
(`07_PACKET_CONTRACT.md`, `08_PACK_SYSTEM.md`, `pack.json`) disagree with each other on the
exact required-output list, and its `.tmpl` templates use a Handlebars-style loop syntax this
pack does not use. This README records every correction so the divergence is traceable.

## Corrections vs. the guidance packet

### 1. `requiredOutputs` / `output-layout.json` completed to 30 files

Guidance's `packs/repository-goal-packet/v1/pack.json` and `output-layout.json` list 23 files
and omit six that `07_PACKET_CONTRACT.md`'s required layout, the guidance
`MANUAL_REPOSITORY_GOAL_PACKET_PROMPT.md` Phase 9 file list, and
`reference/PACKET_MANIFEST_EXAMPLE.json`'s `schemas` block all independently require:

- `evidence/research-sources.json` (present in `07_PACKET_CONTRACT.md`'s layout, absent from
  guidance `pack.json`);
- `research/external-research.jsonl` (present in the Phase 9 file list, absent from both
  guidance `pack.json` and `07_PACKET_CONTRACT.md`'s layout — external research needs its own
  raw ledger distinct from the filtered `evidence/research-sources.json` view);
- `contracts/repository-assessment.json` (the manifest example's `schemas` block declares an
  `assessment` schema and `01_EXECUTIVE_JUDGMENT.md`/`03_FINDINGS.md` render from a
  `RepositoryAssessment`, but no guidance layout lists the canonical JSON for it);
- `prompts/REVIEW_PROMPT.md` (rendered from `prompts/PACKET_REVIEW_PROMPT.md`; present in the
  Phase 9 list and in `07_PACKET_CONTRACT.md`'s layout, absent from guidance `pack.json`);
- `scripts/preflight.sh` and `scripts/preflight.ps1` (present in both file lists above; no
  guidance preflight script exists anywhere in the guidance packet — authored new, see below).

This pack's `pack.json` and `output-layout.json` list exactly this canonical set of 30 required
output files, matching `07_PACKET_CONTRACT.md`'s required layout plus the six additions above.
Adding a pack **asset** (a template, script, or config file that lives under this
`packs/repository-goal-packet/v1/` directory) is fine and does not change `requiredOutputs` —
`requiredOutputs`/`output-layout.json` describe only the files a *compiled packet* must contain.

### 2. `01_EXECUTIVE_JUDGMENT.md.tmpl` field paths corrected

Guidance's template reads `{{ assessment.usefulness }}` etc. directly off `assessment`. The
`RepositoryAssessment` schema (`schemas/repository-assessment.schema.json`) nests these fields
under `executiveJudgment` (`assessment.executiveJudgment.usefulness`, `.functionality`,
`.cohesion`, `.milestoneReadiness`), and additionally requires `ratings[]` and
`biggestConstraint`, neither of which the guidance template rendered. Corrected and completed
here.

### 3. `scripts/launch-review.sh` + `scripts/launch-implementation.sh` consolidated into one `scripts/launch.sh`

The required output layout has one `scripts/launch.sh` / `scripts/launch.ps1` pair, not two
mode-specific scripts. This pack's `launch.sh`/`launch.ps1` take `--mode review|implement` and
resolve to `--permission-mode plan` / `acceptEdits` respectively, and add the hardening the M1
lead's charter requires beyond guidance's originals: absolute-path resolution of both the
packet root and target repo, `--add-dir <packet-root>` when the packet lives outside the target
worktree, pre-launch and post-launch `CHECKSUMS.sha256` verification (immutability), an explicit
statement that `bypassPermissions` is never used or fallen back to, an explicit
worktree-is-not-a-sandbox statement, an explicit statement that merge/deploy/secret operations
remain unauthorized, and an explicit note that a `--teammate-mode in-process` → subagent
fallback must be recorded in run evidence and never silently reported as an agent team.

### 4. `scripts/preflight.sh` / `preflight.ps1` authored new

No guidance script performs pre-launch checks. Authored a read-only tool-availability +
packet-checksum + target-repository sanity check that performs no writes anywhere.

### 5. `compatibility.json` added

`08_PACK_SYSTEM.md`'s pack layout lists `compatibility.json` as a top-level pack file; the
guidance `packs/repository-goal-packet/v1/` directory does not actually contain one. Added a
minimal file that mirrors the compatibility-relevant subset of `pack.json`
(`compatibleEngine`, `requiredSchemas`). `pack.json` remains the single canonical source for
these values — `compatibility.json` must be regenerated if they change.

### 6. Four new numbered report templates authored

Guidance ships `.tmpl` files for `00`, `01`, `04`, `05`, `08` only. `02_REPOSITORY_STATE.md.tmpl`,
`03_FINDINGS.md.tmpl`, `06_ORCHESTRATION.md.tmpl`, and `07_VALIDATION_PLAN.md.tmpl` are authored
new, in the same placeholder style, against the `RepoProfile`, `Finding`,
`RepositoryAssessment`, and `OrchestrationSpec` schemas in
`yellow-goal-harness-guidance/schemas/`.

## Template placeholder syntax — no logic in templates

Guidance's `.tmpl` files use Handlebars-style `{{#each ...}}...{{/each}}` loops (e.g.
`FINDING_LEDGER.md.tmpl`, `VALIDATION_MATRIX.md.tmpl`, `05_MILESTONE.md.tmpl`,
`08_HUMAN_GATES.md.tmpl`). This pack does not: the renderer performs plain `{{PLACEHOLDER}}`
substitution only, with no loops or conditionals evaluated inside a template, and fails if any
**required** placeholder is left unresolved.

Every loop in a guidance template has been flattened into a single **fragment placeholder**
— an all-caps, underscore-separated token (e.g. `{{FINDINGS_TABLE_ROWS}}`) that the compiler
fills with an already-formatted Markdown fragment (a set of table rows, a bullet list, or a
larger pre-rendered block) computed in code from the underlying contract array. The template
itself never iterates; all iteration happens in the Phase 2 compiler before substitution.

Two placeholder kinds are used, distinguished by naming convention:

- **Scalar path placeholders** — `{{ dotted.path }}` (spaces inside the braces, lowercase
  camelCase segments) — a single leaf value read directly off a named contract object
  (`target`, `repoProfile`, `assessment`, `goalResolution`, `milestone`, `orchestration`,
  `manifest`, `request`). Dotted-path access is substitution, not logic — no branching or
  iteration is implied.
- **Fragment placeholders** — `{{SCREAMING_SNAKE_CASE}}` (no spaces inside the braces) — a
  compiler-computed, pre-rendered Markdown fragment standing in for what was a loop in
  guidance. Documented per-file below with its source array and rendering.

The renderer must treat every placeholder occurring in a `.tmpl` file as **required** unless a
future pack version explicitly marks it optional in this README; an unresolved required
placeholder is a render failure, not a silently-blank substitution.

## Placeholder inventory

### Scalar path placeholders

| Placeholder | Source | Used in |
|---|---|---|
| `{{ repoProfile.target.repository }}` | RepoProfile.target | 00, 02, MASTER_IMPLEMENTATION_PROMPT, PERSISTENT_GOAL, REVIEW_PROMPT |
| `{{ repoProfile.target.defaultBranch }}` | RepoProfile.target | 02 |
| `{{ repoProfile.target.requestedRef }}` | RepoProfile.target | 02 |
| `{{ repoProfile.target.resolvedRef }}` | RepoProfile.target | 02 |
| `{{ repoProfile.target.headSha }}` | RepoProfile.target | 00, 02, MASTER_IMPLEMENTATION_PROMPT, PERSISTENT_GOAL, REVIEW_PROMPT |
| `{{ repoProfile.target.inspectedAt }}` | RepoProfile.target | 00, 02 |
| `{{ manifest.packetId }}` | PacketManifest | 00, PERSISTENT_GOAL, REVIEW_PROMPT |
| `{{ assessment.executiveJudgment.usefulness }}` | RepositoryAssessment | 01 |
| `{{ assessment.executiveJudgment.functionality }}` | RepositoryAssessment | 01 |
| `{{ assessment.executiveJudgment.cohesion }}` | RepositoryAssessment | 01 |
| `{{ assessment.executiveJudgment.milestoneReadiness }}` | RepositoryAssessment | 01 |
| `{{ assessment.biggestConstraint }}` | RepositoryAssessment | 01 |
| `{{ findingsSummary.blockingCount }}`, `{{ findingsSummary.highCount }}`, `{{ findingsSummary.mediumCount }}`, `{{ findingsSummary.lowCount }}` | compiler-computed tally of `assessment.findings[].severity` | 03 |
| `{{ goalResolution.requestedGoal }}` | GoalResolution | 00, 04, MASTER_IMPLEMENTATION_PROMPT, PERSISTENT_GOAL, REVIEW_PROMPT |
| `{{ goalResolution.selectedGoal }}` | GoalResolution | 00, 04 |
| `{{ goalResolution.selectedMilestoneId }}` | GoalResolution (required field added per `schemas/README.md`'s documented correction — links to the packet's one milestone; `MilestoneSpec` carries no self-id) | 04, PERSISTENT_GOAL |
| `{{ goalResolution.relationship }}` | GoalResolution | 00, 04, MASTER_IMPLEMENTATION_PROMPT, PERSISTENT_GOAL, REVIEW_PROMPT |
| `{{ goalResolution.rationale }}` | GoalResolution | 04 |
| `{{ goalResolution.preservedIntent }}` | GoalResolution | 04 |
| `{{ milestone.goal }}` | MilestoneSpec | 05, MASTER_IMPLEMENTATION_PROMPT, PERSISTENT_GOAL |
| `{{ milestone.whyNow }}` | MilestoneSpec | 05 |
| `{{ milestone.terminalCondition }}` | MilestoneSpec | 05 |
| `{{ orchestration.profileId }}` | `OrchestrationSpec.profileId` (e.g. `claude-fable-opus-sonnet@1`) | 06, MASTER_IMPLEMENTATION_PROMPT |
| `{{ orchestration.provider }}` | `OrchestrationSpec.provider` (e.g. `anthropic`) | 06, MASTER_IMPLEMENTATION_PROMPT |
| `{{ orchestration.lead.role }}` | `OrchestrationSpec.lead.role` | 06, MASTER_IMPLEMENTATION_PROMPT |
| `{{ orchestration.lead.modelRole }}` | `OrchestrationSpec.lead.modelRole` — a semantic role key (one of `OrchestrationProfile.roleBindings`'s keys: `lead`, `architecture`, `security`, `complex-debugging`, `implementation`, `unit-tests`, `documentation`, `evidence-mapping`, `release-review`) | 06, MASTER_IMPLEMENTATION_PROMPT |
| `{{ orchestration.lead.modelId }}` | `OrchestrationSpec.lead.modelId` — the exact resolved model ID (e.g. `claude-fable-5`), carried directly on the spec | 06, MASTER_IMPLEMENTATION_PROMPT |
| `{{ orchestration.maxConcurrentWorkers }}` | OrchestrationSpec | 06 |
| `{{ orchestration.exclusiveFileOwnership }}` | OrchestrationSpec (optional field) | 06 |
| `{{ orchestration.requirePlanApproval }}` | OrchestrationSpec (optional field) | 06 |
| `{{ orchestration.validationOwnership }}` | OrchestrationSpec | 06, MASTER_IMPLEMENTATION_PROMPT |
| `{{ orchestration.teamMode }}` | `OrchestrationSpec.teamMode` (currently the single enum value `agent-team-preferred`) | 06, MASTER_IMPLEMENTATION_PROMPT |
| `{{ orchestration.fallbackMode }}` | `OrchestrationSpec.fallbackMode` (currently the single enum value `subagents`) | 06, MASTER_IMPLEMENTATION_PROMPT |

The default orchestration profile this pack expects the compiler to resolve
(`claude-fable-opus-sonnet@1`, absent a request-level override) is: lead
`claude-fable-5`; investigation wave `claude-opus-5` (architecture/contracts),
`claude-opus-5` (security/operations), `claude-sonnet-5` (repository/tests/evidence); 3x
`claude-sonnet-5` implementation wave (code / tests+fixtures / docs+migration); verification
wave `claude-opus-5` (security/release), `claude-opus-5` (architecture/CI), `claude-sonnet-5`
(evidence/clean-run) — matching `.claude/specs/packet-compiler.md`'s "Orchestration profile"
section and `OrchestrationProfile.roleBindings`.

### Fragment placeholders

| Placeholder | Rendered from | Used in |
|---|---|---|
| `{{EVIDENCE_GAPS_LIST}}` | `assessment.evidenceGaps[]` → bullet list | 00, 03 |
| `{{RATINGS_TABLE_ROWS}}` | `assessment.ratings[]` → table rows | 01 |
| `{{REPO_KINDS_LIST}}` | `repoProfile.repositoryKinds[]` → bullet list | 02 |
| `{{REPO_INSTRUCTION_FILES_LIST}}` | `repoProfile.instructionFiles[]` → bullet list | 02 |
| `{{REPO_COMMANDS_TABLE_ROWS}}` | `repoProfile.commands[]` → table rows | 02 |
| `{{REPO_OPEN_PULL_REQUESTS_LIST}}` | `repoProfile.openPullRequests[]` → bullet list | 02 |
| `{{REPO_CI_WORKFLOWS_LIST}}` | `repoProfile.ciWorkflows[]` → bullet list | 02 |
| `{{REPO_RELEASE_SIGNALS_LIST}}` | `repoProfile.releaseSignals[]` → bullet list | 02 |
| `{{REPO_PROTECTED_PATHS_LIST}}` | `repoProfile.protectedPaths[]` → bullet list | 02 |
| `{{REPO_EXCERPTS_FENCED_BLOCK}}` | compiler-assembled, fenced and length-bounded excerpts of repository-authored text cited as evidence — never unfenced, never unbounded | 02 |
| `{{FINDINGS_TABLE_ROWS}}` | `assessment.findings[]` → table rows. `RepositoryAssessmentSchema.findings` is typed as `z.array(z.record(z.unknown()))` (loosely typed at the assessment-container level); the compiler must individually validate each element against `FindingSchema` before rendering — a finding that fails that validation is a defect, not a renderable row | 03 |
| `{{FINDINGS_DETAIL_SECTIONS}}` | `assessment.findings[].consequence` + `.requiredBehavior` → per-finding subsections | 03 |
| `{{GOAL_RESOLUTION_BLOCKED_BY_LIST}}` | `goalResolution.blockedBy[]` → bullet list | 04 |
| `{{GOAL_RESOLUTION_EVIDENCE_LIST}}` | `goalResolution.evidenceRefs[]` → bullet list | 04 |
| `{{MILESTONE_SCOPE_LIST}}` | `milestone.scope[]` → bullet list | 05 |
| `{{MILESTONE_NON_GOALS_LIST}}` | `milestone.nonGoals[]` → bullet list | 05, MASTER_IMPLEMENTATION_PROMPT |
| `{{MILESTONE_ACCEPTANCE_CRITERIA_LIST}}` | `milestone.acceptanceCriteria[]` → `**id:** behavior` bullet list | 05 |
| `{{MILESTONE_RISKS_LIST}}` | `milestone.risks[]` → bullet list | 05 |
| `{{MILESTONE_HUMAN_GATES_LIST}}` | `milestone.humanGates[]` → bullet list | 05, 08 |
| `{{ORCHESTRATION_LEAD_RESPONSIBILITIES_LIST}}` | `orchestration.lead.responsibilities[]` → bullet list | 06, MASTER_IMPLEMENTATION_PROMPT |
| `{{ORCHESTRATION_MUTATION_BOUNDARIES_LIST}}` | `orchestration.mutationBoundaries[]` → bullet list | 06, MASTER_IMPLEMENTATION_PROMPT |
| `{{ORCHESTRATION_WAVES_SECTION}}` | `orchestration.waves[]` → per-wave subsection: name, `maxActive`, `readOnly`, `requiresPlanApproval`, `freshContext`, then each wave's `teammates[]` (role, `modelRole`, exact `modelId`, `ownership[]`) as a numbered list. `teammates[]` is variable-length (1-3, per `maxActive`) — the fragment renders exactly as many lines as there are teammates, no fixed count | 06 |
| `{{ORCH_INVESTIGATION_TEAMMATES_LIST}}` | `orchestration.waves[]` filtered to `name === 'investigation'`, its `teammates[]` → numbered "role — model `modelId` (owns: ...)" lines, variable length | MASTER_IMPLEMENTATION_PROMPT |
| `{{ORCH_IMPLEMENTATION_TEAMMATES_LIST}}` | same, `name === 'implementation'` | MASTER_IMPLEMENTATION_PROMPT |
| `{{ORCH_VERIFICATION_TEAMMATES_LIST}}` | same, `name === 'verification'` | MASTER_IMPLEMENTATION_PROMPT |
| `{{ORCHESTRATION_STOP_CONDITIONS_LIST}}` | `orchestration.stopConditions[]` → bullet list | 06, MASTER_IMPLEMENTATION_PROMPT |
| `{{ORCHESTRATION_HUMAN_APPROVAL_LIST}}` | `orchestration.humanApproval[]` → bullet list | 06 |
| `{{VALIDATION_ACCEPTANCE_CRITERIA_ROWS}}` | `milestone.acceptanceCriteria[]` (id, verification.type, verification.environment, commandRef/workflowRef, evidenceRequirement) → table rows | 07 |
| `{{VALIDATION_GATES_LIST}}` | compiler-authored bullet list of required validation-gate *names* (dependency install, typecheck, unit/integration tests, etc. — see `07_VALIDATION_PLAN.md.tmpl`'s static prose for the base set); not derived from the `ValidationResult` contract, which records actual per-check outcomes and belongs to a later run, not the compiled packet's `contracts/` output (not in the canonical 30-file list) | 07, MASTER_IMPLEMENTATION_PROMPT |
| `{{FINDING_LEDGER_ROWS}}` | same source array as `FINDINGS_TABLE_ROWS`, rendered with `Status` reset to each finding's initial `status` | templates/FINDING_LEDGER.md |
| `{{VALIDATION_MATRIX_ROWS}}` | same source array as `VALIDATION_ACCEPTANCE_CRITERIA_ROWS`, rendered with `Result` fixed to `NOT RUN` and `Evidence` blank | templates/VALIDATION_MATRIX.md |

`templates/FINAL_HANDOFF.md.tmpl` has no placeholders — it ships as a blank headers-only form
for the lead to fill in after implementation, matching the guidance original exactly.

## File naming convention

Pack-asset templates carry a `.tmpl` suffix (e.g. `templates/00_START_HERE.md.tmpl`); the
compiler strips the suffix when it writes the rendered file into the compiled packet (e.g.
`00_START_HERE.md`). `scripts/*.sh` and `scripts/*.ps1` are not per-repo templated — they are
copied into every compiled packet unchanged, since their only per-run inputs are supplied as
CLI arguments or environment variables at launch time, not baked in at compile time.

## Golden fixtures

Per `08_PACK_SYSTEM.md`, this pack should have golden fixtures for a Python/web application, a
Node/plugin repository, and an infrastructure repository at minimum. Fixture repositories and
the recorded-analysis fixtures that drive them belong to Worker B (`tests/fixtures/repositories/`)
and this worker's own `tests/fixtures/analysis/`; golden expected-packet output belongs under
`tests/fixtures/golden/` (Phase 2, gated on contracts).
