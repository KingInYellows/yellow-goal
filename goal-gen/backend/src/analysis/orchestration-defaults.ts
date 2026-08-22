/**
 * Deterministic (non-LLM) resolution of the pack's default orchestration profile
 * `claude-fable-opus-sonnet@1` — `.claude/specs/packet-compiler.md` "Orchestration profile".
 * Orchestration is a fixed policy decision the pack ships, not something the analysis model
 * judges per-repository, so it lives here rather than in an `AnalysisProvider`. Both
 * `analyzeRepository` (to write `orchestration.json` into the analysis bundle) and
 * `compilePacket` (to render `06_ORCHESTRATION.md` / the master prompt) call these same pure
 * functions — no file handoff needed for the profile/spec themselves, which keeps compilation
 * deterministic without depending on an extra sibling-file convention.
 */
import type { OrchestrationProfile, OrchestrationSpec } from '../contracts';

export const DEFAULT_ORCHESTRATION_PROFILE_ID = 'claude-fable-opus-sonnet@1';

/** `role -> exact model ID`, per the profile's fixed role bindings. */
const ROLE_MODEL_IDS: Record<keyof OrchestrationProfile['roleBindings'], string> = {
  lead: 'claude-fable-5',
  architecture: 'claude-opus-5',
  security: 'claude-opus-5',
  'complex-debugging': 'claude-opus-5',
  implementation: 'claude-sonnet-5',
  'unit-tests': 'claude-sonnet-5',
  documentation: 'claude-sonnet-5',
  'evidence-mapping': 'claude-sonnet-5',
  'release-review': 'claude-opus-5',
};

/**
 * Resolves the profile's role → model bindings. `clock` is injected (never inline `Date.now()`
 * in an artifact-producing path — `.claude/specs/packet-compiler.md` invariant 7) so tests can
 * pin `resolvedAt` and the determinism test can normalize it via `PacketManifest.timestampFields`.
 */
export function resolveDefaultOrchestrationProfile(clock: () => Date): OrchestrationProfile {
  const roleBindings = Object.fromEntries(
    Object.entries(ROLE_MODEL_IDS).map(([role, modelId]) => [role, { modelId, provider: 'anthropic' }]),
  ) as OrchestrationProfile['roleBindings'];

  return {
    schemaVersion: 'yellow-goal/orchestration-profile/v1',
    id: DEFAULT_ORCHESTRATION_PROFILE_ID,
    provider: 'anthropic',
    roleBindings,
    resolvedAt: clock().toISOString(),
    docSource: 'Anthropic official model documentation (claude-api skill model table)',
  };
}

const STOP_CONDITIONS: readonly string[] = [
  'a secret value is exposed',
  'protected content must be read',
  'target mutation occurs in compiler mode',
  'exact SHA changes without reinspection',
  'a required contract is invalid',
  'a required packet file or reference is missing',
  'an executable command lacks provenance',
  'an unsafe permission fallback remains',
  'mandatory tests fail',
  'required validation is skipped or unavailable',
  'completion requires merge, deployment, or secret rotation',
  'existing user work would be overwritten',
];

const HUMAN_APPROVAL: readonly string[] = [
  'approve the selected milestone before implementation begins',
  'approve implementation (acceptEdits or a stricter explicit allowlist — never bypassPermissions)',
  'approve any permission escalation beyond the implement profile',
  'approve push or PR creation',
  'approve resolution of review threads',
  'approve merge',
  'approve deployment',
  'approve any destructive operation',
  'perform secret rotation',
];

/** Ownership cannot be assigned to real file globs at packet-compile time (that depends on how
 *  the lead breaks the milestone into work after the run starts), so each teammate's `ownership`
 *  is a single honest placeholder string rather than an empty array or an invented file glob. */
const OWNERSHIP_PLACEHOLDER = 'proposed at plan-approval; must not overlap other teammates in the same wave';

const MUTATION_BOUNDARIES: readonly string[] = [
  'investigation and verification waves are read-only against the target repository',
  'the implementation wave writes only within its approved, isolated worktree',
  'compiler-mode steps (inspect/analyze/compile/packet verify) write only under their own run/output directories, never the target repository',
  'no wave may stage, commit, push, merge, resolve review threads, change permissions, or deploy — only the lead performs those actions, and only after explicit human approval where required',
];

const VALIDATION_OWNERSHIP =
  'each implementation teammate runs its own scoped validation commands before requesting plan approval or review; the lead alone performs full final validation across all changed areas before issuing the final recommendation, and a valid verification-wave blocker reopens implementation and requires a rerun of affected full validation gates';

export function resolveDefaultOrchestrationSpec(profile: OrchestrationProfile): OrchestrationSpec {
  const modelIdFor = (role: keyof OrchestrationProfile['roleBindings']): string =>
    profile.roleBindings[role].modelId;

  return {
    schemaVersion: 'yellow-goal/orchestration/v1',
    profileId: profile.id,
    provider: profile.provider,
    lead: {
      role: 'lead orchestrator and final integrator',
      modelRole: 'lead',
      modelId: modelIdFor('lead'),
      responsibilities: [
        'sole integrator and final decision-maker for this run',
        'synthesizes the investigation wave into one finding and implementation ledger before any edits begin',
        'approves each implementation teammate plan before it may edit',
        'performs full final validation, owns commits/pushes/PR text, and issues the final PR-ready/DO-NOT-MERGE/READY-AFTER-ONE-NAMED-ACTION recommendation',
      ],
    },
    teamMode: 'agent-team-preferred',
    fallbackMode: 'subagents',
    waves: [
      {
        name: 'investigation',
        maxActive: 3,
        readOnly: true,
        requiresPlanApproval: false,
        freshContext: false,
        teammates: [
          {
            role: 'architecture/contracts investigator',
            modelRole: 'architecture',
            modelId: modelIdFor('architecture'),
            ownership: [OWNERSHIP_PLACEHOLDER],
          },
          {
            role: 'security/operations investigator',
            modelRole: 'security',
            modelId: modelIdFor('security'),
            ownership: [OWNERSHIP_PLACEHOLDER],
          },
          {
            role: 'repository/tests/evidence mapper',
            modelRole: 'evidence-mapping',
            modelId: modelIdFor('evidence-mapping'),
            ownership: [OWNERSHIP_PLACEHOLDER],
          },
        ],
      },
      {
        name: 'implementation',
        maxActive: 3,
        readOnly: false,
        requiresPlanApproval: true,
        freshContext: false,
        teammates: [
          {
            role: 'code implementer',
            modelRole: 'implementation',
            modelId: modelIdFor('implementation'),
            ownership: [OWNERSHIP_PLACEHOLDER],
          },
          {
            role: 'tests/fixtures implementer',
            modelRole: 'unit-tests',
            modelId: modelIdFor('unit-tests'),
            ownership: [OWNERSHIP_PLACEHOLDER],
          },
          {
            role: 'docs/migration implementer',
            modelRole: 'documentation',
            modelId: modelIdFor('documentation'),
            ownership: [OWNERSHIP_PLACEHOLDER],
          },
        ],
      },
      {
        name: 'verification',
        maxActive: 3,
        readOnly: true,
        requiresPlanApproval: false,
        freshContext: true,
        teammates: [
          {
            role: 'security/release verifier',
            modelRole: 'release-review',
            modelId: modelIdFor('release-review'),
            ownership: [OWNERSHIP_PLACEHOLDER],
          },
          {
            role: 'architecture/CI verifier',
            modelRole: 'architecture',
            modelId: modelIdFor('architecture'),
            ownership: [OWNERSHIP_PLACEHOLDER],
          },
          {
            role: 'evidence/clean-run verifier',
            modelRole: 'evidence-mapping',
            modelId: modelIdFor('evidence-mapping'),
            ownership: [OWNERSHIP_PLACEHOLDER],
          },
        ],
      },
    ],
    maxConcurrentWorkers: 3,
    exclusiveFileOwnership: true,
    requirePlanApproval: true,
    mutationBoundaries: [...MUTATION_BOUNDARIES],
    validationOwnership: VALIDATION_OWNERSHIP,
    stopConditions: [...STOP_CONDITIONS],
    humanApproval: [...HUMAN_APPROVAL],
  };
}
