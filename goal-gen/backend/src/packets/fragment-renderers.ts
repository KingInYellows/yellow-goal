/**
 * Pure functions turning contract arrays into pre-rendered Markdown fragments — the
 * `{{FRAGMENT_NAME}}` placeholders documented in `packs/repository-goal-packet/v1/README.md`.
 * This is where every guidance `{{#each}}` loop was flattened to (see that README's "no logic
 * in templates" section): all iteration happens here, in code, before substitution — the
 * template renderer (`backend/src/packs/template-renderer.ts`) never evaluates a loop itself.
 *
 * Untrusted-content discipline (`06_SECURITY_PERMISSIONS_AND_HUMAN_GATES.md`): any text that
 * originates from the target repository (paths, commands, PR/issue records, evidence excerpts)
 * is bounded in length and rendered as inline code or a fenced block, never interpolated as
 * free-form prose that could be mistaken for this document's own structure.
 */
import type {
  EvidenceRecord,
  Finding,
  MilestoneSpec,
  OrchestrationSpec,
  RepositoryAssessment,
  RepoProfile,
} from '../contracts';

const MAX_EXCERPT_CHARS = 2_000;
const MAX_CELL_CHARS = 300;

function bound(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

/** Table cells must not contain a raw `|` or newline — both break Markdown table parsing. */
function cell(text: string): string {
  return bound(text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '), MAX_CELL_CHARS);
}

function bulletList(items: readonly string[], emptyText = '(none)'): string {
  if (items.length === 0) return `- ${emptyText}`;
  return items.map((item) => `- ${item}`).join('\n');
}

function codeBulletList(items: readonly string[], emptyText = '(none)'): string {
  if (items.length === 0) return `- ${emptyText}`;
  return items.map((item) => `- \`${bound(item, MAX_CELL_CHARS)}\``).join('\n');
}

// ---------------------------------------------------------------------------
// 00_START_HERE.md / 03_FINDINGS.md — evidence gaps
// ---------------------------------------------------------------------------

export function renderEvidenceGapsList(evidenceGaps: readonly string[]): string {
  return bulletList(evidenceGaps, 'no evidence gaps recorded');
}

// ---------------------------------------------------------------------------
// 01_EXECUTIVE_JUDGMENT.md — ratings
// ---------------------------------------------------------------------------

export function renderRatingsTableRows(ratings: RepositoryAssessment['ratings']): string {
  if (ratings.length === 0) return '| _(none)_ | | | |';
  return ratings
    .map(
      (r) =>
        `| ${cell(r.area)} | ${cell(r.rating)} | ${cell(r.whatRaisesIt ?? '')} | ${cell((r.evidenceRefs ?? []).join(', '))} |`,
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// 02_REPOSITORY_STATE.md — deterministic inspection facts
// ---------------------------------------------------------------------------

export function renderRepoKindsList(kinds: readonly string[]): string {
  return bulletList(kinds, 'no repository kinds detected');
}

export function renderInstructionFilesList(files: readonly string[]): string {
  return codeBulletList(files, 'no instruction files found');
}

export function renderCommandsTableRows(commands: RepoProfile['commands']): string {
  if (commands.length === 0) return '| _(none)_ | | | | | |';
  return commands
    .map(
      (c) =>
        `| ${cell(c.id)} | \`${cell(c.argv.join(' '))}\` | ${cell(c.cwd ?? '.')} | ${cell(c.confidence)} | ${cell(c.sideEffectClass)} | ${cell(c.sourceEvidenceRef)} |`,
    )
    .join('\n');
}

/** `openPullRequests`/`ciWorkflows`/`releaseSignals` are `z.record(z.unknown())[]` in
 *  `RepoProfileSchema` — loosely typed. Renders known common fields when present, otherwise a
 *  bounded JSON fallback so nothing is silently dropped. */
function renderUnknownRecordList(records: readonly Record<string, unknown>[] | undefined, emptyText: string): string {
  const items = records ?? [];
  if (items.length === 0) return `- ${emptyText}`;
  return items
    .map((record) => {
      const label =
        (typeof record.title === 'string' && record.title) ||
        (typeof record.name === 'string' && record.name) ||
        (typeof record.number === 'number' && `#${record.number}`) ||
        null;
      const text = label ? `${label} — \`${bound(JSON.stringify(record), 200)}\`` : bound(JSON.stringify(record), MAX_CELL_CHARS);
      return `- ${text}`;
    })
    .join('\n');
}

export function renderOpenPullRequestsList(prs: RepoProfile['openPullRequests']): string {
  return renderUnknownRecordList(prs, 'no open pull requests');
}

export function renderCiWorkflowsList(workflows: RepoProfile['ciWorkflows']): string {
  return renderUnknownRecordList(workflows, 'no CI workflows detected');
}

export function renderReleaseSignalsList(signals: RepoProfile['releaseSignals']): string {
  return renderUnknownRecordList(signals, 'no release signals detected');
}

export function renderProtectedPathsList(paths: readonly string[] | undefined): string {
  return codeBulletList(paths ?? [], 'no protected paths declared');
}

/**
 * Closing fence must be longer than any backtick run in the excerpt — a README that contains
 * ``` would otherwise terminate a fixed ```text fence and inject the rest as packet-authored Markdown.
 */
export function fenceLongerThanContent(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  let longest = 2;
  for (const run of runs) {
    if (run.length > longest) longest = run.length;
  }
  return '`'.repeat(longest + 1);
}

/** Fences and bounds every evidence record that carries a bounded excerpt. Never inlines an
 *  excerpt unfenced — this is the one place raw repository-derived text can appear in a report. */
export function renderRepoExcerptsFencedBlock(evidence: readonly EvidenceRecord[]): string {
  const withExcerpts = evidence.filter((e): e is EvidenceRecord & { excerpt: string } => typeof e.excerpt === 'string' && e.excerpt.length > 0);
  if (withExcerpts.length === 0) return '_(no bounded excerpts recorded)_';
  return withExcerpts
    .map((e) => {
      const label = e.citationLabel ?? e.path ?? e.url ?? e.id;
      const excerpt = bound(e.excerpt, MAX_EXCERPT_CHARS);
      const fence = fenceLongerThanContent(excerpt);
      return `**${e.id}** (${e.sourceType}, ${label}):\n\n${fence}text\n${excerpt}\n${fence}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// 03_FINDINGS.md / templates/FINDING_LEDGER.md
// ---------------------------------------------------------------------------

export interface FindingsSummary {
  blockingCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

export function summarizeFindings(findings: readonly Finding[]): FindingsSummary {
  const summary: FindingsSummary = { blockingCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
  for (const f of findings) {
    if (f.severity === 'blocking') summary.blockingCount++;
    else if (f.severity === 'high') summary.highCount++;
    else if (f.severity === 'medium') summary.mediumCount++;
    else summary.lowCount++;
  }
  return summary;
}

/** 03_FINDINGS.md's 7-column table (adds an "Affected files" column beyond the ledger's 6). */
export function renderFindingsTableRows(findings: readonly Finding[]): string {
  if (findings.length === 0) return '| _(none)_ | | | | | | |';
  return findings
    .map(
      (f) =>
        `| ${cell(f.id)} | ${cell(f.severity)} | ${cell(f.classification)} | ${cell(f.title)} | ${cell(f.evidenceRefs.join(', '))} | ${cell((f.affectedFiles ?? []).join(', '))} | ${cell(f.status ?? 'open')} |`,
    )
    .join('\n');
}

/** templates/FINDING_LEDGER.md's 6-column working-copy table — same source data, one fewer
 *  column, status explicitly defaulted to `open` for a freshly-compiled packet. */
export function renderFindingLedgerRows(findings: readonly Finding[]): string {
  if (findings.length === 0) return '| _(none)_ | | | | | |';
  return findings
    .map(
      (f) =>
        `| ${cell(f.id)} | ${cell(f.severity)} | ${cell(f.classification)} | ${cell(f.title)} | ${cell(f.evidenceRefs.join(', '))} | ${cell(f.status ?? 'open')} |`,
    )
    .join('\n');
}

export function renderFindingsDetailSections(findings: readonly Finding[]): string {
  if (findings.length === 0) return '_(no findings recorded)_';
  return findings
    .map((f) => {
      const lines = [
        `### ${f.id} — ${f.title}`,
        '',
        `**Consequence:** ${f.consequence}`,
        '',
        `**Required behavior:** ${f.requiredBehavior}`,
      ];
      if (f.regressionRequirement) lines.push('', `**Regression requirement:** ${f.regressionRequirement}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// 04_GOAL_RESOLUTION.md
// ---------------------------------------------------------------------------

export function renderGoalResolutionBlockedByList(blockedBy: readonly string[] | undefined): string {
  return bulletList(blockedBy ?? [], 'not blocked');
}

export function renderGoalResolutionEvidenceList(evidenceRefs: readonly string[]): string {
  return codeBulletList(evidenceRefs, 'no evidence references recorded');
}

// ---------------------------------------------------------------------------
// 05_MILESTONE.md
// ---------------------------------------------------------------------------

export function renderMilestoneScopeList(scope: readonly string[]): string {
  return bulletList(scope);
}

export function renderMilestoneNonGoalsList(nonGoals: readonly string[]): string {
  return bulletList(nonGoals);
}

export function renderMilestoneAcceptanceCriteriaList(criteria: MilestoneSpec['acceptanceCriteria']): string {
  return bulletList(criteria.map((c) => `**${c.id}:** ${c.behavior}`));
}

export function renderMilestoneRisksList(risks: readonly string[] | undefined): string {
  return bulletList(risks ?? [], 'no risks recorded');
}

export function renderMilestoneHumanGatesList(humanGates: readonly string[]): string {
  return bulletList(humanGates, 'no milestone-specific human gates beyond the standing gates');
}

// ---------------------------------------------------------------------------
// 06_ORCHESTRATION.md / MASTER_IMPLEMENTATION_PROMPT.md
// ---------------------------------------------------------------------------

export function renderOrchestrationLeadResponsibilitiesList(responsibilities: readonly string[]): string {
  return bulletList(responsibilities);
}

export function renderOrchestrationMutationBoundariesList(boundaries: readonly string[]): string {
  return bulletList(boundaries);
}

function renderTeammateLine(teammate: OrchestrationSpec['waves'][number]['teammates'][number], index: number): string {
  const ownership = teammate.ownership.join('; ');
  return `${index + 1}. ${teammate.role} — model \`${teammate.modelId}\` (model role: \`${teammate.modelRole}\`, owns: ${ownership})`;
}

export function renderOrchestrationWavesSection(waves: OrchestrationSpec['waves']): string {
  return waves
    .map((wave) => {
      const title = wave.name[0]!.toUpperCase() + wave.name.slice(1);
      const teammates = wave.teammates.map((t, i) => renderTeammateLine(t, i)).join('\n');
      return [
        `### ${title}`,
        '',
        `- maxActive: ${wave.maxActive}`,
        `- readOnly: ${wave.readOnly}`,
        `- requiresPlanApproval: ${wave.requiresPlanApproval}`,
        `- freshContext: ${wave.freshContext}`,
        '',
        'Teammates:',
        '',
        teammates.length > 0 ? teammates : '_(no teammates assigned)_',
      ].join('\n');
    })
    .join('\n\n');
}

function renderWaveTeammatesList(waves: OrchestrationSpec['waves'], name: OrchestrationSpec['waves'][number]['name']): string {
  const wave = waves.find((w) => w.name === name);
  const teammates = wave?.teammates ?? [];
  if (teammates.length === 0) return '_(no teammates assigned to this wave)_';
  return teammates.map((t, i) => renderTeammateLine(t, i)).join('\n');
}

export function renderInvestigationTeammatesList(waves: OrchestrationSpec['waves']): string {
  return renderWaveTeammatesList(waves, 'investigation');
}

export function renderImplementationTeammatesList(waves: OrchestrationSpec['waves']): string {
  return renderWaveTeammatesList(waves, 'implementation');
}

export function renderVerificationTeammatesList(waves: OrchestrationSpec['waves']): string {
  return renderWaveTeammatesList(waves, 'verification');
}

export function renderOrchestrationStopConditionsList(stopConditions: readonly string[]): string {
  return bulletList(stopConditions);
}

export function renderOrchestrationHumanApprovalList(humanApproval: readonly string[]): string {
  return bulletList(humanApproval);
}

// ---------------------------------------------------------------------------
// 07_VALIDATION_PLAN.md / templates/VALIDATION_MATRIX.md
// ---------------------------------------------------------------------------

export function renderValidationAcceptanceCriteriaRows(criteria: MilestoneSpec['acceptanceCriteria']): string {
  if (criteria.length === 0) return '| _(none)_ | | | | |';
  return criteria
    .map((c) => {
      const ref = c.verification.commandRef ?? c.verification.workflowRef ?? '';
      return `| ${cell(c.id)} | ${cell(c.verification.type)} | ${cell(c.verification.environment ?? '')} | ${cell(ref)} | ${cell(c.verification.evidenceRequirement ?? '')} |`;
    })
    .join('\n');
}

export function renderValidationMatrixRows(criteria: MilestoneSpec['acceptanceCriteria']): string {
  if (criteria.length === 0) return '| _(none)_ | | | | |';
  return criteria
    .map((c) => `| ${cell(c.id)} | ${cell(c.verification.type)} | ${cell(c.verification.environment ?? '')} | NOT RUN | |`)
    .join('\n');
}

const REQUIRED_VALIDATION_GATE_NAMES: readonly string[] = [
  'dependency installation from the repository\'s own lockfile',
  'typecheck',
  'full unit and integration tests',
  'any existing eval suites',
  'new tests added for this milestone',
  'adversarial/security tests where applicable',
  'a read-only target-mutation proof for any compiler-mode step',
  'a deterministic double-compile comparison where packet compilation is involved',
];

/** Static, compiler-authored list — not derived from any contract array (see the pack README's
 *  note on `{{VALIDATION_GATES_LIST}}`). */
export function renderValidationGatesList(): string {
  return bulletList(REQUIRED_VALIDATION_GATE_NAMES);
}
