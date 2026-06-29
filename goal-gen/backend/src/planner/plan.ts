/**
 * Deterministic forward A* GOAP planner (ADR-0004, .claude/specs/planner.md).
 *
 * Pure and synchronous — no LLM, no I/O. Same input ⇒ identical Plan (determinism is a gated
 * invariant, PRD §8). Forward (progressive) A* over symbolic WorldState:
 *   g(n) = Σ action cost   ·   h(n) = unmetCount × minCost (astar) or 0 (bfs)   ·   f = g + h.
 * Returns the minimum-cost plan, or `null` (never throws) for an unsatisfiable goal.
 *
 * Heuristic mode (planner.md / ADR-0004): the unmet-predicate count is admissible AND consistent
 * only when each action satisfies ≤1 goal predicate. When some action satisfies several at once
 * (the multi-effect tier), it overestimates ⇒ inadmissible, so we fall back to BFS mode (h = 0,
 * i.e. uniform-cost / Dijkstra) which is always optimal. In astar mode the count is scaled by the
 * pool's minimum action cost (`h = unmetCount × minCost`) so it stays a true lower bound — and thus
 * admissible & consistent — for ANY positive costs, including fractional ones (cost < 1). The
 * default auto-selects between the two; both yield least-cost plans and differ only in search
 * efficiency. Callers may pin `opts.mode` to override.
 *
 * The module is self-contained (the spec says the planner "depends on: nothing"); it deliberately
 * re-implements its own `satisfies` rather than importing the eval oracle.
 */
import type { Action, GoalSpec, Plan, PlanStep, Primitive, WorldState } from './types';

/** Retained for API compatibility with the original stub; `plan()` no longer throws it. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export interface PlanOptions {
  /** Heuristic mode. Default: auto — `bfs` when any action satisfies >1 goal predicate, else `astar`. */
  mode?: 'astar' | 'bfs';
  /** Link this plan to the plan it replaces (orchestrator replanning). */
  replanOf?: string;
  /** Search bound: maximum nodes expanded before giving up (⇒ `null`). */
  maxNodes?: number;
}

const DEFAULT_MAX_NODES = 100_000;

// ─── Pure helpers ──────────────────────────────────────────────────────────────────────────────

/** True iff every predicate in `predicates` matches `state` exactly (mirrors simulate.satisfies). */
function satisfies(state: WorldState, predicates: Partial<WorldState>): boolean {
  for (const k of Object.keys(predicates)) {
    if (state[k] !== predicates[k]) return false;
  }
  return true;
}

/** Count of unmet goal predicates — the base of the A* heuristic. */
function unmetCount(state: WorldState, goalState: Partial<WorldState>): number {
  let n = 0;
  for (const k of Object.keys(goalState)) {
    if (state[k] !== goalState[k]) n++;
  }
  return n;
}

/**
 * Smallest action cost in the pool (1 if empty). Used to scale the unmet-predicate heuristic:
 * reaching the goal needs ≥ `unmetCount` more actions (astar mode ⇒ each clears ≤1 predicate),
 * each costing ≥ this floor, so `unmetCount × minCost` is a true lower bound on cost-to-go —
 * admissible & consistent even when costs are fractional (< 1).
 */
function minCost(actions: Action[]): number {
  let m = Infinity;
  for (const a of actions) if (a.cost < m) m = a.cost;
  return m === Infinity ? 1 : m;
}

/** Canonical, order-independent serialization of a state for the closed set / `bestG` keys. */
function stateKey(state: WorldState): string {
  const obj: Record<string, Primitive> = {};
  for (const k of Object.keys(state).sort()) {
    const v = state[k];
    if (v !== undefined) obj[k] = v;
  }
  return JSON.stringify(obj);
}

/** Sorted, undefined-free entries of a (partial) state — for stable content hashing. */
function sortedEntries(rec: Partial<WorldState>): Array<[string, Primitive]> {
  const out: Array<[string, Primitive]> = [];
  for (const k of Object.keys(rec).sort()) {
    const v = rec[k];
    if (v !== undefined) out.push([k, v]);
  }
  return out;
}

/**
 * Deterministic 64-bit hash → 16-hex string. Two FNV-1a lanes with distinct offset bases keep ids
 * pure and stable (no Date/random) while making content collisions negligible — so distinct
 * GoalSpecs/Plans get distinct ids, which matters once plans are persisted (M1).
 */
function hash64(input: string): string {
  let h1 = 0x811c9dc5; // 32-bit FNV-1a offset basis
  let h2 = 0xcbf29ce4; // distinct basis (low 32 bits of the 64-bit FNV basis) ⇒ decorrelated lane
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; // FNV-1a 32-bit prime
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0; // same prime; the distinct basis decorrelates this lane
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Recursively stringify an unknown value with sorted object keys so the result is deterministic
 * regardless of property insertion order. Used for `payload.mcpTool.args` which is typed `unknown`.
 */
function stableStringify(val: unknown): string {
  if (val === null || val === undefined) return String(val);
  if (typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(stableStringify).join(',')}]`;
  const obj = val as Record<string, unknown>;
  const pairs = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

/** Content-derived, stable id for a GoalSpec. */
function goalSpecId(goalSpec: GoalSpec): string {
  const canonical = JSON.stringify({
    goalText: goalSpec.goalText,
    initial: sortedEntries(goalSpec.initialState),
    goal: sortedEntries(goalSpec.goalState),
    constraints: goalSpec.constraints,
    completionPolicy: goalSpec.completionPolicy,
    actions: goalSpec.actions.map((a) => ({
      id: a.id,
      name: a.name,
      cost: a.cost,
      executor: a.executor,
      pre: sortedEntries(a.preconditions),
      eff: sortedEntries(a.effects),
      payload: stableStringify(a.payload),
      verify: {
        command: a.verify.command,
        successPredicate: a.verify.successPredicate
          ? sortedEntries(a.verify.successPredicate)
          : undefined,
      },
    })),
  });
  return `goal_${hash64(canonical)}`;
}

/** Content-derived, stable id for a produced Plan. */
function planId(
  gsId: string,
  actionIds: string[],
  initialState: WorldState,
  replanOf: string | undefined,
): string {
  const canonical = JSON.stringify({
    gsId,
    steps: actionIds,
    from: sortedEntries(initialState),
    replanOf: replanOf ?? null,
  });
  return `plan_${hash64(canonical)}`;
}

/** True iff some action sets ≥2 goal predicates to their goal values (the inadmissibility edge). */
function hasMultiGoalAction(actions: Action[], goalState: Partial<WorldState>): boolean {
  const goalKeys = Object.keys(goalState);
  for (const a of actions) {
    let satisfied = 0;
    for (const k of goalKeys) {
      if (a.effects[k] === goalState[k] && ++satisfied > 1) return true;
    }
  }
  return false;
}

/**
 * Reject malformed pools at intake (CLAUDE.md invariant #3 + planner.md data model): cost > 0,
 * verify required, and unique action ids. Unique ids matter because the search and dependency reference
 * actions by id (assemblePlan's `byId` would otherwise silently keep only the last colliding
 * action) — and the pool is LLM-authored and append-only across re-extractions, so a colliding id
 * is a realistic extractor output rather than a theoretical one.
 */
function validateIntake(goalSpec: GoalSpec): void {
  const seen = new Set<string>();
  for (const a of goalSpec.actions) {
    if (!(a.cost > 0)) {
      throw new Error(`planner intake: action "${a.id}" must have cost > 0 (got ${a.cost})`);
    }
    const v = a.verify;
    const hasVerify =
      !!v &&
      ((typeof v.command === 'string' && v.command.trim().length > 0) ||
        (v.successPredicate != null && Object.keys(v.successPredicate).length > 0));
    if (!hasVerify) {
      throw new Error(
        `planner intake: action "${a.id}" is missing or has an empty verify check (invariant)`,
      );
    }
    if (seen.has(a.id)) {
      throw new Error(`planner intake: duplicate action id "${a.id}" in the candidate pool`);
    }
    seen.add(a.id);
  }
}

// ─── Search ──────────────────────────────────────────────────────────────────────────────────--

interface SearchNode {
  key: string;
  state: WorldState;
  g: number; // cost so far
  h: number; // heuristic estimate to goal
  action: string | null; // action taken to reach this node (null at the root)
  parent: SearchNode | null;
  seq: number; // monotonic insertion order — final, deterministic tie-breaker
}

/** Total, deterministic order: lower f, then lower h (dive toward goal), then earlier insertion. */
function lessThan(a: SearchNode, b: SearchNode): boolean {
  const fa = a.g + a.h;
  const fb = b.g + b.h;
  if (fa !== fb) return fa < fb;
  if (a.h !== b.h) return a.h < b.h;
  return a.seq < b.seq;
}

/** Minimal binary min-heap over SearchNodes (the A* open list). */
class MinHeap {
  private readonly items: SearchNode[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: SearchNode): void {
    const items = this.items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const cur = items[i]!;
      const par = items[parent]!;
      if (!lessThan(cur, par)) break;
      items[i] = par;
      items[parent] = cur;
      i = parent;
    }
  }

  pop(): SearchNode | undefined {
    const items = this.items;
    const n = items.length;
    if (n === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (n > 1) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < items.length && lessThan(items[l]!, items[smallest]!)) smallest = l;
        if (r < items.length && lessThan(items[r]!, items[smallest]!)) smallest = r;
        if (smallest === i) break;
        const a = items[i]!;
        items[i] = items[smallest]!;
        items[smallest] = a;
        i = smallest;
      }
    }
    return top;
  }
}

/** Walk parent pointers from a goal node back to the root, returning forward-ordered action ids. */
function reconstruct(goal: SearchNode): string[] {
  const ids: string[] = [];
  let cur: SearchNode | null = goal;
  while (cur && cur.action !== null) {
    ids.push(cur.action);
    cur = cur.parent;
  }
  ids.reverse();
  return ids;
}

/**
 * Causal dependency links for the orchestrator: each precondition (k,v) of step `i` depends on the
 * latest earlier step that establishes it. Preconditions met only by the initial state add none.
 * All edges point strictly backward ⇒ acyclic and precedence-correct by construction.
 */
function deriveDependsOn(ordered: Action[], i: number): string[] {
  const action = ordered[i];
  if (!action) return [];
  const deps = new Map<number, string>(); // producer index -> id (dedupes shared producers)
  for (const k of Object.keys(action.preconditions)) {
    const need = action.preconditions[k];
    if (need === undefined) continue;
    for (let j = i - 1; j >= 0; j--) {
      const producer = ordered[j];
      if (producer && producer.effects[k] === need) {
        deps.set(j, producer.id);
        break;
      }
    }
  }
  return [...deps.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
}

/** Assemble the ordered action ids into a fully-formed, deterministic Plan. */
function assemblePlan(
  gsId: string,
  actionIds: string[],
  goalSpec: GoalSpec,
  opts: PlanOptions,
): Plan {
  const byId = new Map(goalSpec.actions.map((a) => [a.id, a]));
  const ordered: Action[] = actionIds.map((id) => {
    const a = byId.get(id);
    if (!a) throw new Error(`internal: planned action "${id}" missing from pool`);
    return a;
  });

  const steps: PlanStep[] = ordered.map(
    (action, i): PlanStep => ({
      actionId: action.id,
      status: 'pending',
      dependsOn: deriveDependsOn(ordered, i),
    }),
  );

  const result: Plan = {
    id: planId(gsId, actionIds, goalSpec.initialState, opts.replanOf),
    goalSpecId: gsId,
    steps,
    totalCost: ordered.reduce((sum, a) => sum + a.cost, 0),
    createdFromState: { ...goalSpec.initialState },
  };
  if (opts.replanOf !== undefined) result.replanOf = opts.replanOf;
  return result;
}

// ─── Public API ────────────────────────────────────────────────────────────────────────────────

/**
 * Plan from `goalSpec.initialState` to `goalSpec.goalState` over the candidate action pool.
 * Returns the least-cost valid plan, or `null` if the goal is unreachable. Pure & deterministic.
 */
export function plan(goalSpec: GoalSpec, opts: PlanOptions = {}): Plan | null {
  validateIntake(goalSpec);

  const { goalState, initialState, actions } = goalSpec;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const gsId = goalSpecId(goalSpec);

  // Mode: explicit override, else auto — bfs (h=0, always optimal) when the unmet-predicate
  // heuristic could be inadmissible (an action satisfies >1 goal predicate), else astar.
  const mode: 'astar' | 'bfs' =
    opts.mode ?? (hasMultiGoalAction(actions, goalState) ? 'bfs' : 'astar');
  const costFloor = minCost(actions); // scales the astar heuristic ⇒ admissible for fractional costs
  const heuristic = (state: WorldState): number =>
    mode === 'bfs' ? 0 : unmetCount(state, goalState) * costFloor;

  // Already satisfied ⇒ the empty plan is optimal (cost 0).
  const start: WorldState = { ...initialState };
  if (satisfies(start, goalState)) {
    return assemblePlan(gsId, [], goalSpec, opts);
  }

  const root: SearchNode = {
    key: stateKey(start),
    state: start,
    g: 0,
    h: heuristic(start),
    action: null,
    parent: null,
    seq: 0,
  };

  const open = new MinHeap();
  open.push(root);
  const bestG = new Map<string, number>([[root.key, 0]]);
  const closed = new Set<string>();
  let seq = 1;
  let expanded = 0;

  while (open.size > 0) {
    const node = open.pop()!;
    // Drop stale heap entries: already finalized, or superseded by a cheaper path to this state.
    if (closed.has(node.key)) continue;
    const recordedG = bestG.get(node.key);
    if (recordedG !== undefined && node.g > recordedG) continue;

    // Both modes use a consistent heuristic (bfs: h=0; astar: unmetCount×costFloor), so the
    // first goal node popped is optimal.
    if (satisfies(node.state, goalState)) {
      return assemblePlan(gsId, reconstruct(node), goalSpec, opts);
    }

    closed.add(node.key);
    if (++expanded > maxNodes) return null; // search bound tripped ⇒ no plan

    for (const action of actions) {
      if (!satisfies(node.state, action.preconditions)) continue;
      const nextState: WorldState = { ...node.state };
      Object.assign(nextState, action.effects); // ground-model effect application (intended)
      const nextKey = stateKey(nextState);
      if (closed.has(nextKey)) continue;
      const nextG = node.g + action.cost;
      const knownG = bestG.get(nextKey);
      if (knownG !== undefined && nextG >= knownG) continue; // not an improvement
      bestG.set(nextKey, nextG);
      open.push({
        key: nextKey,
        state: nextState,
        g: nextG,
        h: heuristic(nextState),
        action: action.id,
        parent: node,
        seq: seq++,
      });
    }
  }

  return null; // open list exhausted ⇒ goal unreachable
}

/** Eval-harness guard: true once `plan` no longer throws NotImplementedError. */
export function isPlannerImplemented(): boolean {
  try {
    plan({
      goalText: '',
      initialState: {},
      goalState: {},
      constraints: [],
      actions: [],
      completionPolicy: 'verify-only',
    });
    return true;
  } catch (err) {
    return !(err instanceof NotImplementedError);
  }
}
