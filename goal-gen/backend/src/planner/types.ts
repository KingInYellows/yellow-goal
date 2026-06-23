/**
 * Canonical data model for the GOAL generator.
 * Source of truth: .claude/specs/planner.md (ADR-0004). Keep in sync with that spec.
 * The planner owns these types; extractor, orchestrator, api, and the eval harness import them.
 */

export type Primitive = boolean | number | string;
export type WorldState = Record<string, Primitive>;

export type ExecutorKind = 'claude-code' | 'codex' | 'antigravity' | 'mcp' | 'shell';

/** How "done" is judged for a goal. Extractor recommends; operator confirms (ADR-0008). */
export type CompletionPolicy = 'verify-only' | 'verify+signoff' | 'operator-defined';

export interface Action {
  id: string;
  name: string;
  cost: number; // > 0
  preconditions: Partial<WorldState>;
  effects: Partial<WorldState>; // intended; real effect is verified at runtime
  executor: ExecutorKind;
  payload: {
    prompt?: string;
    command?: string;
    mcpTool?: { name: string; args: unknown };
    repoPath?: string;
    permissionMode?: string;
  };
  /** REQUIRED ground-truth check (ADR-0004 / planner.md). No verify ⇒ not executable. */
  verify: { command?: string; successPredicate?: Partial<WorldState> };
}

export interface GoalSpec {
  goalText: string;
  initialState: WorldState;
  goalState: Partial<WorldState>; // definition of done
  constraints: string[];
  actions: Action[]; // candidate pool (LLM-authored; append-only across re-extractions)
  completionPolicy: CompletionPolicy;
}

export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface PlanStep {
  actionId: string;
  status: StepStatus;
  dependsOn: string[];
}

export interface Plan {
  id: string;
  goalSpecId: string;
  steps: PlanStep[];
  totalCost: number;
  createdFromState: WorldState;
  replanOf?: string;
}
