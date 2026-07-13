---
title: 'During GOAP Re-Extraction (Append-Only Action Authoring After a Verify Failure): Code Fences and String verify Field'
date: 2026-06-30
category: integration-issues
track: knowledge
problem: 'LLM extractor wraps re-extracted actions in markdown code fences and returns verify as a plain string instead of the required { command: string } object during GOAP re-extraction'
tags: [llm-extractor, re-extraction, goap, verify-field, code-fences, orchestrator, e2e-probe]
source: compound-staging
---

# During GOAP Re-Extraction (Append-Only Action Authoring After a Verify Failure): Code Fences and String verify Field

## Context

During GOAP re-extraction (append-only action authoring after a verify failure), the LLM extractor (`claude -p`) returns new actions wrapped in markdown code fences even when explicitly instructed not to, and also returns the `verify` field as a plain string instead of the required `{ command: string }` object. The re-extraction prompt should explicitly warn about both: (1) no code fences around the JSON array, and (2) verify must be an object with a `command` key. Re-extraction is triggered when `verifyExitCode != 0` and the planner can no longer reach `goalState` with the existing action pool. The append-only constraint means existing action ids in the pool must be listed in the prompt and must not appear in the returned array. Injected verify-fail probes (for e2e testing) trigger re-extraction correctly, confirming the orchestrator replan path works end-to-end.

## Source

Auto-promoted by yellow-core's compound-staging pipeline from session
`1bef32ed-f853-4850-b9eb-4d6ca9741bd1` (priority 0.72, category fact).
