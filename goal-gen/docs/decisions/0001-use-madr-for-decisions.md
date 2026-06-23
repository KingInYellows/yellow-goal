---
status: accepted
date: 2026-06-23
decision-makers: KingInYellow
---

# 0001. Record architecture decisions using MADR

## Context and problem statement
This is a spec-driven build executed largely by Claude Code; a decision that isn't written in a file can't be honored by an agent. We need durable, legible, low-overhead decision records.

## Decision
Record each significant decision as a [MADR](https://adr.github.io/madr/)-format file in `docs/decisions/`, four-digit sequential numbering, immutable once `accepted` (supersede rather than edit). Use the `madr` template only — no Log4brains, no `adr-tools`.

## Alternatives considered
- **Nygard plain format** — good, but MADR adds the `Confirmation` field that links a decision to the eval/test proving it holds.
- **adr-tools** — effectively abandoned (last release 2018).
- **Log4brains** — heavier (static-site generator) than a solo repo needs.

## Consequences
- 👍 Decision memory for humans and agents; ADRs cross-link to specs and eval fixtures.
- 👎 Requires discipline to add/supersede ADRs as decisions evolve.

## Confirmation
`docs/decisions/` exists with this index; `CLAUDE.md`/`AGENTS.md` instruct reading the relevant ADR before changing a locked decision.

## Links
- doc 08 §3/§5; `CLAUDE.md`.
