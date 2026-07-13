---
title: 'When `claude -p` Returns Action JSON With Wrong Types'
date: 2026-06-29
category: integration-issues
track: knowledge
problem: 'Zod repair prompt with per-field path errors fixes type mismatches in LLM-extracted Action JSON in one round, with the verify field being the most common violation.'
tags: [llm-extractor, zod-repair, goap, action-schema, claude-p, verify-field]
source: compound-staging
---

# When `claude -p` Returns Action JSON With Wrong Types

## Context

When `claude -p` returns Action JSON with wrong types, a zod repair prompt listing each field path error (e.g. "0.verify: Expected object, received string") fixes all errors in one round. The `verify` field is the most common violation: extractor returns a bare string but schema requires `{ command: string }`. Include an explicit object-shape example in the repair prompt.

## Source

Auto-promoted by yellow-core's compound-staging pipeline from session
`8c3e1162-6cae-4a34-bf22-f1fcc01a699c` (priority 0.75, category fact).
