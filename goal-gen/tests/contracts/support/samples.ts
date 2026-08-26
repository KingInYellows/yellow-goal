/** Canonical, hand-authored valid samples — one per contract — reused by the compatibility tests
 *  and (for `requestSample`) the intake tests. */

export const requestSample = {
  schemaVersion: 'yellow-goal/request/v1',
  requestId: 'req-sample-001',
  target: {
    repository: 'octocat/example',
    ref: 'main',
  },
  intent: {
    goal: 'Add a deterministic repository-profile inspector.',
  },
  mode: 'review-and-compile',
  pack: 'repository-goal-packet@1',
  orchestration: {
    permissionProfile: 'inspect',
    orchestrationProfile: 'claude-fable-opus-sonnet@1',
  },
};

/** Executable-run variant (RR1/RR2): `mode: 'approved-implementation'` with the strict
 *  `orchestration.execution` refinement populated — must stay valid under the verbatim vendored
 *  request.schema.json (the untyped `orchestration` bucket absorbs it). */
export const requestExecutionSample = {
  ...requestSample,
  requestId: 'req-sample-002',
  mode: 'approved-implementation',
  orchestration: {
    ...requestSample.orchestration,
    execution: {
      autoConfirmDod: true,
      model: 'haiku',
      guardrails: {
        maxBudgetUsd: 5,
        maxReplans: 2,
        maxReextractions: 1,
        maxRetriesPerAction: 2,
        actionTimeoutMs: 120_000,
      },
    },
  },
};

export const repoProfileSample = {
  schemaVersion: 'yellow-goal/repo-profile/v1',
  target: {
    repository: 'octocat/example',
    resolvedRef: 'main',
    headSha: '0123456789abcdef0123456789abcdef01234567',
    inspectedAt: '2026-08-22T00:00:00Z',
  },
  repositoryKinds: ['node', 'library'],
  instructionFiles: ['CLAUDE.md'],
  commands: [
    {
      id: 'cmd-test',
      argv: ['npm', 'test'],
      sourceEvidenceRef: 'ev-package-json',
      confidence: 'configured',
      sideEffectClass: 'workspace-only',
    },
  ],
  evidenceRefs: ['ev-package-json'],
};

export const evidenceRecordSample = {
  schemaVersion: 'yellow-goal/evidence/v1',
  id: 'ev-package-json',
  sourceType: 'repository-file',
  repository: 'octocat/example',
  ref: 'main',
  targetSha: '0123456789abcdef0123456789abcdef01234567',
  path: 'package.json',
  retrievedAt: '2026-08-22T00:00:00Z',
  contentHash: 'sha256-0123456789abcdef',
  sensitivity: 'public',
  facts: ['declares npm test as the test script'],
};

export const findingSample = {
  schemaVersion: 'yellow-goal/finding/v1',
  id: 'F-001',
  severity: 'high',
  classification: 'verified_defect',
  title: 'Executor falls back to bypassPermissions on unknown mode',
  evidenceRefs: ['ev-package-json'],
  consequence: 'Unknown permission modes silently escalate to full bypass.',
  requiredBehavior: 'Unknown modes must fail the run closed, never bypass.',
};

export const repositoryAssessmentSample = {
  schemaVersion: 'yellow-goal/repository-assessment/v1',
  executiveJudgment: {
    usefulness: 'Directly supports the stated goal.',
    functionality: 'Core paths verified by tests.',
    cohesion: 'Single coherent module boundary.',
    milestoneReadiness: 'Ready for one bounded milestone.',
  },
  ratings: [{ area: 'test-coverage', rating: 'adequate', evidenceRefs: ['ev-package-json'] }],
  findings: [],
  evidenceGaps: [],
  biggestConstraint: 'No CI currently enforces these gates.',
};

export const goalResolutionSample = {
  schemaVersion: 'yellow-goal/goal-resolution/v1',
  requestedGoal: 'Add a deterministic repository-profile inspector.',
  selectedGoal: 'Add a deterministic repository-profile inspector.',
  selectedMilestoneId: 'm-001',
  relationship: 'exact',
  rationale: 'The requested goal is already coherent, bounded, and next in sequence.',
  evidenceRefs: ['ev-package-json'],
};

export const milestoneSpecSample = {
  schemaVersion: 'yellow-goal/milestone/v1',
  goal: 'Add a deterministic repository-profile inspector.',
  whyNow: 'It is the highest-leverage gap before execution.',
  scope: ['backend/src/inspection'],
  nonGoals: ['target-repository edits'],
  acceptanceCriteria: [
    {
      id: 'AC-1',
      behavior: 'A valid request containing only repository and goal is accepted.',
      verification: { type: 'command', commandRef: 'cmd-test' },
    },
  ],
  terminalCondition: 'A schema-valid packet is produced without mutating the target.',
  humanGates: ['approve selected milestone'],
};

export const orchestrationSpecSample = {
  schemaVersion: 'yellow-goal/orchestration/v1',
  profileId: 'claude-fable-opus-sonnet@1',
  provider: 'anthropic',
  lead: {
    role: 'lead',
    modelRole: 'highest-capability-orchestrator',
    modelId: 'claude-fable-5',
    responsibilities: [
      'sole integrator and final decision-maker for the run',
      'runs final validation before any integration',
    ],
  },
  teamMode: 'agent-team-preferred',
  fallbackMode: 'subagents',
  waves: [
    {
      name: 'implementation',
      maxActive: 3,
      readOnly: false,
      requiresPlanApproval: true,
      freshContext: true,
      teammates: [
        {
          role: 'implementation',
          modelRole: 'implementation',
          modelId: 'claude-sonnet-5',
          ownership: ['backend/src/contracts/**'],
        },
      ],
    },
  ],
  maxConcurrentWorkers: 3,
  mutationBoundaries: [
    'teammates may not stage changes',
    'teammates may not commit changes',
    'teammates may not push',
    'teammates may not merge',
    'teammates may not resolve review threads',
    'teammates may not change permissions',
    'teammates may not deploy',
  ],
  validationOwnership: 'the lead runs final validation before integration',
  stopConditions: ['target SHA drift detected'],
  humanApproval: ['approve implementation'],
};

export const packetManifestSample = {
  schemaVersion: 'yellow-goal/packet-manifest/v1',
  packetId: 'pkt-001',
  engineVersion: '0.1.0',
  pack: { id: 'repository-goal-packet', version: '1' },
  requestId: 'req-sample-001',
  target: {
    repository: 'octocat/example',
    requestedRef: 'AUTO',
    resolvedRef: 'main',
    headSha: '0123456789abcdef0123456789abcdef01234567',
  },
  inspectionStartedAt: '2026-08-22T00:00:00Z',
  inspectionCompletedAt: '2026-08-22T00:05:00Z',
  analysisModels: { 'evidence-mapping': 'claude-sonnet-5' },
  resolvedOrchestrationModels: { lead: 'claude-fable-5' },
  tools: { claudeCode: '1.0.0' },
  schemas: { request: 'yellow-goal/request/v1' },
  files: [{ path: '00_START_HERE.md', sha256: 'abc123', bytes: 512 }],
  humanGates: ['approve selected milestone'],
  evidenceGaps: [],
  timestampFields: ['inspectionStartedAt', 'inspectionCompletedAt'],
  targetMutationOccurred: false,
  validation: { status: 'passed' },
};

export const runEventSample = {
  schemaVersion: 'yellow-goal/run-event/v1',
  runId: 'run-001',
  sequence: 0,
  timestamp: '2026-08-22T00:00:00Z',
  type: 'inspection.started',
  payload: { requestId: 'req-sample-001' },
};

export const resolvedRepositoryTargetSample = {
  schemaVersion: 'yellow-goal/resolved-repository-target/v1',
  provider: 'github',
  identity: 'octocat/example',
  defaultBranch: 'main',
  requestedRef: 'AUTO',
  resolvedRef: 'main',
  sha: '0123456789abcdef0123456789abcdef01234567',
  inspectionTimestamp: '2026-08-22T00:00:00Z',
  accessLevel: 'full-read',
  toolLimitations: [],
};

export const commandRecordSample = {
  schemaVersion: 'yellow-goal/command-record/v1',
  id: 'cmd-test',
  argv: ['npm', 'test'],
  workingDir: '.',
  source: 'manifest-script',
  evidenceRefs: ['ev-package-json'],
  confidence: 'configured',
  sideEffectClass: 'test',
  executable: true,
};

export const externalResearchRecordSample = {
  schemaVersion: 'yellow-goal/external-research-record/v1',
  id: 'ext-anthropic-model-table',
  question: 'What are the current Claude model identifiers?',
  sourceUrl: 'https://docs.claude.com/en/docs/about-claude/models',
  sourceKind: 'official-docs',
  retrievedAt: '2026-08-22T00:00:00Z',
  summary: 'Confirms claude-opus-5/claude-sonnet-5/claude-fable-5 as current model ids.',
  evidenceId: 'ev-package-json',
};

export const modelRoleBindingSample = {
  schemaVersion: 'yellow-goal/model-role-binding/v1',
  role: 'implementation',
  modelId: 'claude-sonnet-5',
  provider: 'anthropic',
};

function binding(modelId: string): { modelId: string; provider: string } {
  return { modelId, provider: 'anthropic' };
}

export const orchestrationProfileSample = {
  schemaVersion: 'yellow-goal/orchestration-profile/v1',
  id: 'claude-fable-opus-sonnet@1',
  provider: 'anthropic',
  roleBindings: {
    lead: binding('claude-fable-5'),
    architecture: binding('claude-opus-5'),
    security: binding('claude-opus-5'),
    'complex-debugging': binding('claude-opus-5'),
    implementation: binding('claude-sonnet-5'),
    'unit-tests': binding('claude-sonnet-5'),
    documentation: binding('claude-sonnet-5'),
    'evidence-mapping': binding('claude-sonnet-5'),
    'release-review': binding('claude-opus-5'),
  },
  resolvedAt: '2026-08-22T00:00:00Z',
  docSource: '09_IMPLEMENTATION_MILESTONE.md',
};

export const validationResultSample = {
  schemaVersion: 'yellow-goal/validation-result/v1',
  checks: [
    {
      id: 'schema-request',
      description: 'request.json validates against request.schema.json',
      status: 'passed',
    },
  ],
  overall: 'passed',
};

export const finalHandoffSample = {
  schemaVersion: 'yellow-goal/final-handoff/v1',
  status: 'PR_READY_FOR_HUMAN_REVIEW',
  target: { repository: 'octocat/example', headSha: '0123456789abcdef0123456789abcdef01234567' },
  evidenceSummary: ['All required checks passed.'],
};
