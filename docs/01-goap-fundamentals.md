# 01 — GOAP Fundamentals

> Classic Goal-Oriented Action Planning: origins, architecture, algorithm, and how it compares to other agent-decision systems. This is the conceptual bedrock for everything else in this project.

**Related:** [`02-goal-oriented-planning-in-llm-agents.md`](02-goal-oriented-planning-in-llm-agents.md) (how this maps to LLM agents) · [`07-glossary-and-references.md`](07-glossary-and-references.md)

---

## 1. What GOAP is, in one paragraph

**Goal-Oriented Action Planning (GOAP)** is a real-time automated-planning architecture for autonomous agents. Instead of hard-coding *how* an agent behaves in every situation (as a finite-state machine does), you give the agent a set of **goals** (desired world states) and a pool of **actions** (atomic operators, each with **preconditions**, **effects**, and a **cost**). A **planner** then searches — using **A\*** over the space of world states — for the lowest-cost sequence of actions that transforms the current world state into one that satisfies the goal. When the world changes or an action fails, the agent **re-plans**. The defining principle is the **separation of domain knowledge (actions) from control logic (the planner)**: designers author actions; the planner figures out how to chain them.

Jeff Orkin's own definition: "a simplified STRIPS-like planning architecture specifically designed for real-time control of autonomous character behavior in games" ([ReGoap README, quoting Orkin](https://github.com/luxkun/ReGoap)).

---

## 2. Origins and lineage

### 2.1 STRIPS (1971) — the ancestor

**STRIPS** (STanford Research Institute Problem Solver) was created by **Richard Fikes and Nils Nilsson in 1971** to control Shakey the robot ([Wikipedia: STRIPS](https://en.wikipedia.org/wiki/Stanford_Research_Institute_Problem_Solver); [Fikes & Nilsson 1971](https://www.sciencedirect.com/science/article/abs/pii/0004370271900105)). Today "STRIPS" usually means its **action representation**, which became the base for most later planning languages. In STRIPS:

- A **state** is a conjunction of literals (facts).
- An **operator/action** has **preconditions** (literals that must hold), an **add list** (literals it makes true), and a **delete list** (literals it makes false).
- Applying an action: `s' = (s − DeleteList) ∪ AddList`.
- The planner searches for a sequence of operators transforming the **initial state** into a state satisfying the **goal**.

### 2.2 Jeff Orkin & F.E.A.R. (~2003–2005) — GOAP proper

GOAP was developed by **Jeff Orkin while at Monolith Productions** and shipped in the game **F.E.A.R. (2005)**, whose enemy AI could coordinate, take cover, flush the player out, and improvise — behavior that felt authored but was actually *planned at runtime* ([Orkin, "Three States and a Plan: The A.I. of F.E.A.R.", GDC 2006](https://www.gamedevs.org/uploads/three-states-plan-ai-of-fear.pdf)).

> **Dating/affiliation caveat:** Popularizer articles often say "2003, at MIT." The careful version: the foundational article *"Applying Goal-Oriented Action Planning to Games"* is dated **2003** in Orkin's own bibliography (the book *AI Game Programming Wisdom 2* is sometimes cataloged 2004); the work was done **at Monolith**, and Orkin's **MIT Media Lab** affiliation came *after* F.E.A.R. shipped. Use: "developed ~2003–2004 at Monolith, shipped in F.E.A.R. 2005." GOAP was named after the IGDA's "GOAP working group."

**Orkin's four deliberate deviations from textbook STRIPS** — the core engineering contribution:

1. **Cost per action.** Each action has a numeric cost, turning "find *a* plan" into "find the *cheapest* plan" → enables A\*.
2. **No add/delete lists.** Preconditions and effects are a **fixed-size array of world-state variables** (a vector), making it trivial to find "which action produces the effect I need."
3. **Procedural preconditions.** Each action also implements `CheckProceduralPreconditions()` — arbitrary code (e.g., "is there a valid path?") too complex for the symbolic vector.
4. **Procedural effects.** Effects aren't applied instantly; an action drives a simplified FSM (Goto / Animate) over time.

### 2.3 Where GOAP sits in the planning family

- **PDDL** (Planning Domain Definition Language, 1998) generalized STRIPS for academic planning competitions. GOAP is *inspired by* STRIPS/PDDL but does **not** use PDDL as a file format (F.E.A.R. encoded actions as C++ classes). The LLM-era hybrids in doc 02 *do* bring PDDL back.
- **Progression (forward) search** starts at the current state and applies applicable actions; **regression (backward) search** starts at the goal and works backward over actions that achieve it. Classic GOAP uses **regression** (see §4.3).
- GOAP is a **total-order, single-agent** planner. For parallel/squad behavior Orkin recommended **HTN** instead (see §6).

---

## 3. The five components

| Component | What it is |
|-----------|-----------|
| **World State** | The set of facts the planner reasons over — usually key/value pairs or a packed bitfield (e.g., `{weaponLoaded:false, enemyVisible:true}`). |
| **Goals** | Desired world-state conditions. Crucially, a GOAP goal contains **no embedded plan** — only the *condition to satisfy*. Goals compete for activation by **relevance/priority**. |
| **Actions** | Atomic operators. Each has **preconditions** (what must be true to run), **effects** (what becomes true after), and a **cost**. |
| **The Planner** | Runs A\* over world states to produce the cheapest valid action sequence. |
| **Execution + Replanning** | The agent executes actions in sequence; if an action fails or the world changes, it **re-plans** from the current state. |

### 3.1 World State representations (in practice)

- **Vector of variables / array of 4-byte slots** (F.E.A.R.): one slot per property; supports bool/enum/handle.
- **64-bit bitfield** (GPGOAP): one bit per boolean atom + a "care/don't-care" mask. Cheap bitwise set operations; **max 64 atoms**, booleans only.
- **`Dictionary<string,object>`** (ReGoap) or a plain key/value object (most JS/TS implementations).

A key Orkin principle: represent only the **minimal** set of properties relevant to the goal being solved. The planner solving `KillEnemy` doesn't need the shooter's health or location — just the facts on the path to "target dead."

### 3.2 Goals: selection and priority

An agent typically has many goals. Each goal knows how to compute its **relevance** and whether it's **satisfied**. The agent tries to satisfy the **highest-priority** goal for which a valid plan exists, falling back to lower-priority goals otherwise. (Orkin's example: a rat shares the soldier's goal set `{Patrol, KillEnemy}` but lacks attack actions, so `KillEnemy` produces no plan and it falls back to `Patrol`.)

### 3.3 Actions: the chaining mechanism

Preconditions and effects are what let the planner **chain** actions automatically:

- `Attack` requires `weaponLoaded = true`
- `Reload` has effect `weaponLoaded = true`
- ∴ the planner discovers `Reload → Attack` on its own — nobody wrote that transition.

Add an action or tweak a precondition and new behavior emerges without editing any control graph. This is GOAP's superpower.

---

## 4. The planner: A\* over world states

### 4.1 The core insight

A\* is a *general* graph-search algorithm, not just for navigation. In planning:

- **Nodes = world states**
- **Edges = actions** that transform one state into another

F.E.A.R. literally reused the same A\* code for both pathfinding and planning, just over different data structures.

### 4.2 A\* ingredients in GOAP

- **g(n)** = sum of action costs along the path to node *n*.
- **h(n)** (heuristic) = the **number of unsatisfied goal conditions** (count of properties whose value differs from the goal). This is the standard GOAP heuristic.
- **f = g + h**, with the usual **open list** (priority queue) and **closed list**.

> **Heuristic caveat:** the "count of unsatisfied literals" heuristic is intuitive but **not provably admissible** when a single action can satisfy several conditions at once. So "optimal/lowest-cost plan" guarantees in tutorials hold for their specific models but shouldn't be over-generalized. Some implementations sidestep this by using **breadth-first search** (guaranteed *shortest*, not cheapest-by-cost).

### 4.3 Backward (regressive) vs. forward (progressive) — and why it matters

**Classic GOAP searches backward** (regression), starting at the goal:

> Example: an unarmed character wants to kill an enemy with a mounted laser that needs power. **Forward search** blindly expands every applicable action and stumbles onto "turn on the generator first" only by brute force. **Backward search** starts at `targetDead`, sees `AttackMounted` produces it, then looks for actions satisfying `AttackMounted`'s preconditions (power on → activate generator), and so on. It only ever considers actions whose effects are *relevant to a currently-unsatisfied subgoal*, which dramatically prunes the search tree.

Mechanics: as the planner adds an action, it removes the conditions that action satisfies from the unsatisfied set and **appends that action's preconditions** as new subgoals. Search succeeds when the accumulated state matches the current world.

> **But this is genuinely contested by era.** Orkin (2003–2006) argued backward is "more efficient and intuitive." The academic literature notes backward search "complicates heuristic development, leading many systems to prefer forward search." And shipped AAA GOAP (*Deus Ex 3*, *Tomb Raider*) and Éric Jacopin's recommended design moved to **forward search "which seems easier to debug"** ([Jacopin, "Optimizing Practical Planning for Game AI", Game AI Pro 2, ch.13](https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter13_Optimizing_Practical_Planning_for_Game_AI.pdf)). All three views are correct in context — there is no single "right" direction. **For an LLM-era GOAL generator, forward search over a small, mostly-linear action set is simpler and more debuggable** (and is exactly what `goal.ruv.io` does — see doc 03).

### 4.4 Worked example (Orkin's `KillEnemy`)

Actions:
- `Attack` — precond `weaponLoaded=true`; effect `targetDead=true`
- `LoadWeapon` — precond `weaponArmed=true`; effect `weaponLoaded=true`
- `DrawWeapon` — precond (none); effect `weaponArmed=true`

Backward regression from goal `targetDead=true`:
1. Unsatisfied `targetDead` → `Attack` satisfies it; append precond `weaponLoaded`.
2. Unsatisfied `weaponLoaded` → `LoadWeapon`; append precond `weaponArmed`.
3. Unsatisfied `weaponArmed` → `DrawWeapon` (no preconds). Done.

Plan (reversed for execution): **`DrawWeapon → LoadWeapon → Attack`**.

### 4.5 A fuller worked example (GPGOAP soldier)

The canonical runnable example shows how the **goal and costs steer behavior without any control flow** ([GPGOAP README](https://github.com/stolk/GPGOAP)):

| Action | Preconditions | Effects |
|---|---|---|
| `scout` | `armedwithgun` | `enemyvisible` |
| `approach` | `enemyvisible` | `nearenemy` |
| `aim` | `enemyvisible` ∧ `weaponloaded` | `enemylinedup` |
| `shoot` | `enemylinedup` | `¬enemyalive` |
| `load` | `armedwithgun` | `weaponloaded` |
| `detonatebomb` | `armedwithbomb` ∧ `nearenemy` | `¬alive` ∧ `¬enemyalive` |
| `flee` | `enemyvisible` | `¬nearenemy` |

- **Goal `enemyalive=false`** → cheapest plan is the 3-action **suicide bombing** (`scout → approach → detonatebomb`) — but the soldier dies.
- **Goal `enemyalive=false ∧ alive=true`** → planner avoids the bomb: **`scout → load → aim → shoot`**.

You changed *behavior* by changing the *goal*, not by writing an if-statement. That is the entire value proposition.

---

## 5. Implementation & performance notes

- **State encoding:** bitfields (GPGOAP) make set operations cheap; comparing a state to a goal is `(state ^ goal) & care_mask == 0`. Jacopin benchmarks `std::array` for storage + `std::bitset` for the set math as a good combination.
- **The search graph is implicit/lazy:** you never materialize the whole state space — nodes and edges are generated on demand as A\* expands the frontier.
- **Scale is small in practice:** Jacopin reports GOAP-like planners generate **< 1 plan/second/agent** and plans are **≤ ~4 actions**, within a few-millisecond budget. Complexity grows with the number of actions and preconditions.
- **Mitigations** (borrowed from pathfinding): optimize A\*, cache previous plans, distribute planning across frames, prune early with cheap (procedural/context) preconditions.
- **Multithreading:** modern engines parallelize — crashkonijn/GOAP uses Unity's Job System and demos **2,000 agents**.

---

## 6. GOAP vs. other agent-decision architectures

| Architecture | Core idea | Strengths | Weaknesses |
|---|---|---|---|
| **FSM** | States + hand-authored transitions | Simple, fast, predictable | Transitions explode combinatorially; rigid |
| **Behavior Tree (BT)** | Hierarchy of composites re-ticked each frame | Intuitive, debuggable, reactive, industry-standard | Static structure; **less emergent**; grows intractable |
| **Utility AI** | Score each option with utility curves, pick the max | Smooth graded decisions among competing concerns | No look-ahead/sequencing; doesn't *plan* multi-step |
| **HTN** | Decompose high-level tasks into subtasks via designer "methods" | Scales to large action sets (methods constrain search); good for parallel/squad tasks | Designer must encode decomposition → less emergent |
| **GOAP** | Goal + atomic actions; planner chains them | **Emergent multi-step plans**; decouples goals from actions; designer-friendly; valid plans; dynamic replanning | Runtime planning cost; state-space scaling; harder to *predict/debug*; flat action pool scales worse than HTN |

**GOAP vs. HTN (planner-vs-planner):** HTN is a **forward** planner working from current state toward a solution using designer-provided decompositions; GOAP is (classically) a **backward** planner from goal to current state. HTN scales better to huge action sets but constrains creativity; GOAP improvises plans the designer never wrote. Orkin used **HTN for F.E.A.R.'s squad layer** because HTN handles parallel actions better.

**When GOAP wins:** dynamic environments where agents should improvise/recover; one goal satisfiable many ways; many character types built from shared modular actions; designers adding behaviors late.

**When GOAP loses:** tightly-scripted/cinematic AI; very simple AI (use a BT/FSM); enormous action sets (use HTN); when *predictable, debuggable* behavior matters more than emergence. In practice many systems **combine** methods (BT/FSM for macro-states, GOAP for action sequencing); hybrids like **GOBT** (Goal-Oriented Behavior Trees) and utility-guided GOAP are an active trend.

---

## 7. Notable open-source implementations (read these as "spec")

| Repo | Lang | License | Notes |
|---|---|---|---|
| [stolk/GPGOAP](https://github.com/stolk/GPGOAP) | C | Apache-2.0 | The classic minimal reference. 64-bit bitfield state; A\* over state space. Best "read the whole thing" implementation. |
| [crashkonijn/GOAP](https://github.com/crashkonijn/GOAP) | C# | Apache-2.0 | Most actively maintained (Unity). Multi-threaded via Job System; visual node debugger; 2,000-agent demos; v3.x in 2026. |
| [luxkun/ReGoap](https://github.com/luxkun/ReGoap) | C# | Apache-2.0 | Generic C# + Unity examples. `Dictionary<string,object>` state; sensors/memory; auto re-plan on failure. Stable but last release 2018. |
| [victorb/dogoap](https://github.com/victorb/dogoap) | Rust | MIT | Data-oriented; define states/actions/goals at **runtime**; `bevy_dogoap` for Bevy ECS. |
| [Excalibur.js GOAP](https://excaliburjs.com/blog/goal-oriented-action-planning/) | TS/JS | (article + demo) | High-quality TypeScript walkthrough; builds the plan graph by recursion, picks cheapest via Dijkstra. Good onboarding for a web build. |

(There are also Python — agoose77/GOAP — and JS — wmdmark/goap-js — implementations; verify their `LICENSE` files before reuse.)

---

## 8. The one-line takeaway for this project

GOAP is **a small, well-understood, deterministic search** (A\* over a symbolic state graph) that turns *declarative actions + a goal* into *an ordered, valid plan*. It is cheap to implement (~150 lines), it replans cleanly, and — critically for a GOAL generator — it gives you a **legible, inspectable plan tree** instead of an opaque chain-of-thought. The interesting modern question is how to pair that deterministic skeleton with an LLM that can author the actions and execute the steps. That's doc 02.
