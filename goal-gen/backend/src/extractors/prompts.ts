/**
 * Prompts for the headless `claude -p` extractor (goal-extractor.md). `claude -p` has no
 * forced-tool-use, so strict JSON is PROMPT-enforced: lead with "return ONLY JSON", inline the exact
 * TS shape, give one concrete few-shot, and pin "start with `{`/`[`, end with `}`/`]`". Determinism
 * is requested in-prompt (claude -p exposes no temperature flag).
 */
import type { Action, WorldState } from '../planner/types';
import type { ExtractRequest, FailureEvidence } from '../types';

/** The exact target shape, inlined so the model authors to it precisely. */
const SCHEMA_BLOCK = `type Primitive = boolean | number | string;
type WorldState = Record<string, Primitive>;       // use boolean facts, e.g. {"tests_pass": true}
type ExecutorKind = 'claude-code' | 'codex' | 'antigravity' | 'mcp' | 'shell';
type CompletionPolicy = 'verify-only' | 'verify+signoff' | 'operator-defined';
interface Action {
  id: string;            // unique, kebab-case
  name: string;          // short human label
  cost: number;          // positive integer effort estimate
  preconditions: WorldState; // facts that must hold before this action runs
  effects: WorldState;       // facts this action makes true (chained toward goalState)
  executor: ExecutorKind;    // use 'claude-code'
  payload: { prompt?: string; command?: string }; // prompt = the instruction for the coding agent
  verify: { command: string; successPredicate?: WorldState }; // REQUIRED: command's exit code is the ground-truth gate
}
interface GoalSpec {
  goalText: string;
  initialState: WorldState;  // goal-relevant facts true at the start
  goalState: WorldState;     // the definition of done
  constraints: string[];
  actions: Action[];         // a MINIMAL but sufficient candidate pool
  completionPolicy: CompletionPolicy;
}`;

/** One concrete few-shot GoalSpec so the model copies the exact field conventions. */
const FEW_SHOT = `Example goal: "create a file hello.txt containing the word hello"
Example GoalSpec:
{
  "goalText": "create a file hello.txt containing the word hello",
  "initialState": { "file_exists": false, "content_correct": false },
  "goalState": { "file_exists": true, "content_correct": true },
  "constraints": [],
  "actions": [
    {
      "id": "write-hello-file",
      "name": "Write hello.txt",
      "cost": 1,
      "preconditions": { "file_exists": false },
      "effects": { "file_exists": true, "content_correct": true },
      "executor": "claude-code",
      "payload": { "prompt": "Create a file named hello.txt whose contents are exactly: hello" },
      "verify": { "command": "grep -qx hello hello.txt" }
    }
  ],
  "completionPolicy": "verify-only"
}`;

const RULES = `Rules:
- Return ONLY the JSON object. No prose, no markdown, no code fences. Start with \`{\` and end with \`}\`.
- Every action MUST have a non-empty \`verify.command\` — a shell command whose exit code is the
  ground-truth pass/fail check. \`successPredicate\` is OPTIONAL and additive (never a substitute).
- preconditions/effects must chain so the actions can reach goalState from initialState.
- Keep the pool minimal but sufficient; cost is a positive integer.
- Prefer completionPolicy "verify-only" when the verify checks are unambiguous.
- Be deterministic: same goal => same GoalSpec.`;

/**
 * Escape XML metacharacters in untrusted free-text before interpolating into XML-delimited prompt
 * sections. Prevents delimiter-breakout injection (e.g. a goalText containing `</goal>` closing the
 * tag early). Order matters: escape `&` first to avoid double-escaping.
 */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build the first-pass extraction prompt for a goal. */
export function extractionPrompt(req: ExtractRequest): string {
  const constraints = req.config?.constraints?.length
    ? `\nOperator constraints (honor these):\n${req.config.constraints.map((c) => `- ${escapeXml(c)}`).join('\n')}`
    : '';
  const depth = req.config?.depth ? `\nRequested depth: ${req.config.depth}.` : '';
  return [
    'You are a planning-graph extractor for a deterministic GOAP planner. Convert the plain-English',
    'goal into a single JSON "GoalSpec" the planner can search over.',
    '',
    'The JSON MUST match this TypeScript shape exactly:',
    '',
    SCHEMA_BLOCK,
    '',
    RULES,
    '',
    FEW_SHOT,
    '',
    `Now extract a GoalSpec for this goal:${depth}${constraints}`,
    `<goal>${escapeXml(req.goalText)}</goal>`,
  ].join('\n');
}

/** Re-prompt after a validation failure, feeding the model its own bad output + the zod issues. */
export function repairPrompt(previousOutput: string, issues: string): string {
  return [
    'Your previous response was NOT valid. Here is exactly what you returned:',
    '<previous>',
    previousOutput,
    '</previous>',
    '',
    'It failed validation with these issues:',
    issues,
    '',
    'Return a corrected response that fixes EVERY issue. Return ONLY the JSON (start with `{` or `[`,',
    'end with `}` or `]`). No prose, no code fences.',
  ].join('\n');
}

/**
 * Build the re-extraction prompt: author ADDITIONAL actions (append-only) grounded in the REAL
 * failure evidence, with ids disjoint from the existing pool (goal-extractor.md `expand`).
 */
export function expandPrompt(
  goalText: string,
  currentState: WorldState,
  failureEvidence: FailureEvidence,
  existingPool: Action[],
): string {
  // Summarise existing actions so the model can author genuinely NEW, non-duplicate actions that are
  // grounded in what already exists (id, human name, and the verify command that is already covered).
  const existingActionSummary = existingPool.map((a) => ({
    id: a.id,
    name: a.name,
    verifyCommand: a.verify.command,
  }));

  // Cap untrusted shell output (verifyStdout / verifyStderr) before interpolation — these come
  // directly from command execution and can be arbitrarily large or contain adversarial content.
  const MAX_SHELL_OUTPUT = 2000;
  const cappedEvidence: FailureEvidence = {
    ...failureEvidence,
    ...(failureEvidence.verifyStdout !== undefined && {
      verifyStdout: failureEvidence.verifyStdout.slice(0, MAX_SHELL_OUTPUT),
    }),
    ...(failureEvidence.verifyStderr !== undefined && {
      verifyStderr: failureEvidence.verifyStderr.slice(0, MAX_SHELL_OUTPUT),
    }),
  };

  return [
    'You previously authored a GoalSpec for the goal below, but executing it FAILED and the',
    'deterministic planner can no longer reach the goal with the existing actions. Author ADDITIONAL',
    'actions (append-only — never restate or drop existing ones) that, combined with the existing',
    'pool, let the planner reach goalState.',
    '',
    'Return ONLY a JSON ARRAY of new Action objects (same Action shape as before). Start with `[` and',
    'end with `]`. No prose, no code fences.',
    '',
    'Rules:',
    '- Each new action id MUST differ from every existing id in the pool (see existing actions below).',
    '- Do NOT duplicate what an existing action already does — author actions that cover genuinely new',
    '  ground (e.g. a missing dependency => an install step; a failing command => its prerequisite).',
    '- Ground each new action in the REAL failure evidence.',
    '- Every new action MUST have a non-empty verify.',
    '',
    `Goal: ${goalText}`,
    `Current world state: ${JSON.stringify(currentState)}`,
    `Existing actions (id / name / verify command): ${JSON.stringify(existingActionSummary)}`,
    `Failure evidence: ${JSON.stringify(cappedEvidence)}`,
  ].join('\n');
}
