/**
 * Zod schema for the LLM-authored `GoalSpec` / `Action[]`, derived from `planner/types.ts`.
 *
 * `claude -p` has NO server-side forced tool-use (unlike the Claude API), so strict JSON is
 * prompt-enforced and then validated here — the repair round in `llm-extractor.ts` is load-bearing,
 * not a rare path (CLAUDE.md invariant #4, goal-extractor.md).
 *
 * Layering with the planner (plan §"plan() throws"): this schema enforces STRUCTURE + the
 * verify-non-empty refinement (plan task 3.1). It deliberately does NOT enforce `cost > 0` or
 * pool-wide unique ids — those stay the planner's `validateIntake` throw, which the orchestrator
 * catches and routes to re-extraction (plan design decision #3). Empty verify is caught here (repair
 * → ExtractionError); cost ≤ 0 / duplicate id are caught at `plan()` (re-extraction).
 */
import { z } from 'zod';

const primitive = z.union([z.boolean(), z.number(), z.string()]);
/** WorldState and every `Partial<WorldState>` use (a total record satisfies the partial). */
const worldState = z.record(primitive);

const executorKind = z.enum(['claude-code', 'codex', 'antigravity', 'mcp', 'shell']);
const completionPolicy = z.enum(['verify-only', 'verify+signoff', 'operator-defined']);

/**
 * REQUIRED ground-truth check: a non-empty shell `command` whose exit code is the pass/fail gate.
 * `command` is mandatory (not "command OR successPredicate"): without it the orchestrator could only
 * gate on the agent's self-reported status — an LLM-declared effect, which CLAUDE.md invariant #2
 * forbids. `successPredicate` stays optional and ADDITIVE (the state hint applied on a verify PASS).
 */
const verifySchema = z
  .object({
    command: z.string().optional(),
    successPredicate: worldState.optional(),
  })
  .refine((v) => typeof v.command === 'string' && v.command.trim().length > 0, {
    message:
      'verify must have a non-empty `command` — a shell command whose exit code is the ground-truth gate (a successPredicate alone is an LLM self-report and is never sufficient; invariant #2)',
  });

const payloadSchema = z
  .object({
    prompt: z.string().optional(),
    command: z.string().optional(),
    mcpTool: z.object({ name: z.string(), args: z.unknown() }).optional(),
    repoPath: z.string().optional(),
    permissionMode: z.string().optional(),
  })
  .default({});

export const ActionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cost: z.number(),
  preconditions: worldState,
  effects: worldState,
  executor: executorKind,
  payload: payloadSchema,
  verify: verifySchema,
});

export const ActionArraySchema = z.array(ActionSchema);

export const GoalSpecSchema = z.object({
  goalText: z.string(),
  initialState: worldState,
  goalState: worldState,
  constraints: z.array(z.string()),
  actions: ActionArraySchema,
  completionPolicy,
});

export type ParsedGoalSpec = z.infer<typeof GoalSpecSchema>;
export type ParsedAction = z.infer<typeof ActionSchema>;

/** Compact, model-readable rendering of zod issues for the repair prompt. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `- ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}
