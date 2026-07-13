---
title: 'The LLM Extractor (claude -p) Is Non-Deterministic Across Calls for the Same Goal'
date: 2026-06-30
category: integration-issues
track: knowledge
problem: 'LlmExtractor must strip markdown fences as a mandatory pre-parse step before JSON.parse; without it, valid JSON inside fences causes a parse error and triggers an unnecessary repair round.'
tags: [llm-extractor, fence-stripping, goap, action-pool, claude-p, non-determinism, json-parse]
source: compound-staging
---

# The LLM Extractor (claude -p) Is Non-Deterministic Across Calls for the Same Goal

## Context

The LLM extractor (`claude -p`) is non-deterministic across calls for the same goal: one call returns a minimal 1-action pool, another returns 3 alternative actions (e.g., echo-redirect, tee-pipe variants). The GOAP planner handles variable pool sizes correctly. Fence-stripping before zod validation is essential: the extractor wraps valid JSON in ```json ... ``` fences even when instructed to return only JSON. The `LlmExtractor` must strip fences as a mandatory pre-parse step before passing to `JSON.parse`. Without fence-stripping, valid JSON inside fences causes a parse error and triggers an unnecessary repair round. The extractor is also biased toward the example GoalSpec in the prompt — providing a hello.txt example causes the extractor to mirror that structure closely for similar goals.

## Source

Auto-promoted by yellow-core's compound-staging pipeline from session
`fe72cf24-1259-4b44-9156-ca11ef70869e` (priority 0.65, category fact).
