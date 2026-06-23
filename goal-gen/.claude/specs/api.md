# Spec — API (REST + realtime)

**Component:** `backend/src/api/` · **Depends on:** extractor, planner, orchestrator, db. **Consumed by:** frontend.
**Principle:** thin transport over the domain modules; all heavy logic lives in those modules.

## REST endpoints
```
POST  /goals               { goalText, config? }        -> { goalSpecId, goalSpec } | { needsClarification, prompt }
PATCH /goals/:id/criteria  { goalState?, verifyEdits?, completionPolicy? } -> { goalSpec }   # confirm/edit definition of done
POST  /goals/:id/plan      { mode?: 'astar'|'bfs' }      -> { plan } | { plan: null, reason }
POST  /plans/:id/run       { mode: 'auto'|'step', runConfig? } -> { runId }
POST  /runs/:id/cancel                                   -> { ok }
POST  /runs/:id/step       { decision: 'approve'|'reject' }   -> { ok }   # step mode
POST  /runs/:id/accept     { decision: 'accept'|'reject' }    -> { ok }   # completion sign-off (completionPolicy)
POST  /steps/:id/reassign  { executor: ExecutorKind }    -> { ok }        # M2
GET   /plans/:id                                         -> { plan, steps, runs }
GET   /goals/:id                                         -> { goalSpec, plans[] }
GET   /runs/:id                                          -> { run, agentRuns[] }
GET   /history             ?limit&offset                 -> { goals[] }
```

## Realtime (WebSocket/SSE): `GET /stream/:planId`
Event union (also persisted):
```ts
type StreamEvent =
  | { type:'PlanGenerated'; plan: Plan }
  | { type:'StepStarted'; stepId:string; actionId:string; executor:ExecutorKind }
  | { type:'StepOutput'; stepId:string; chunk:string }              // streamed stdout
  | { type:'StepCompleted'; stepId:string; verified:boolean }
  | { type:'StepFailed'; stepId:string; error:string }
  | { type:'Replanned'; oldPlanId:string; newPlanId:string; reason:string; reextracted:boolean }
  | { type:'AwaitingAcceptance'; runId:string; goalState:Partial<WorldState> }   // completionPolicy needs sign-off
  | { type:'RunMetrics'; runId:string; tokens:number; costUsd:number; elapsedMs:number }
  | { type:'RunFinished'; runId:string; status:'succeeded'|'failed'|'cancelled'|'budget-exhausted' };
```

## Behavior
- `/goals` runs the extractor (may return `needsClarification`); `/goals/:id/criteria` lets the operator confirm/edit the definition of done (goalState + verify + `completionPolicy`) before planning; `/plan` runs the planner; `/run` starts the orchestrator and returns immediately, with progress over `/stream`. When `completionPolicy` requires sign-off, the run emits `AwaitingAcceptance` and waits for `/runs/:id/accept`.
- Validate all inputs (zod); return structured errors `{ error, code }`.
- **Auth: a single-admin login (session)** for v1 — the instance is single-user on a local LXC/VM behind that login, with no LAN-wide or public exposure (PRD §11). Keys/secrets never leave the server.

## Error / edge cases
- Planning fails → 200 with `{ plan: null, reason }` (not an HTTP error).
- Acting on a finished/cancelled run → 409 conflict.
- Stream reconnect → client resumes from last event id; server replays buffered events.

## Acceptance criteria
- Full happy path drivable via REST + one WebSocket subscription.
- Cancel/step/reassign reflected within realtime-latency target (PRD §9).
- Inputs validated; no secret ever appears in a response or log.

## Out of scope
Domain logic (lives in modules), rendering (frontend).
