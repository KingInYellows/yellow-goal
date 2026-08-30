---
title: 'Fail-Closed Request Hardening: Unconsulted Constraints, JSON Infinity, setTimeout Clamping, and argv Injection'
date: 2026-08-26
category: security-issues
track: bug
problem: 'Request-file constraints were declared but never consulted, budget/timeout fields accepted Infinity and clamp-triggering values, and a model string reached the claude subprocess argv unconstrained'
tags: [zod, fail-closed, json-infinity, settimeout-clamp, argv-injection, request-schema, guardrails, subprocess]
components: [backend/src/contracts/request.ts, backend/src/run/request-to-run.ts]
source: 'review:sweep-all across PR #15-#19 (KingInYellows/yellow-goal), fix commit 0fd946d'
---

# Fail-Closed Request Hardening: Unconsulted Constraints, JSON Infinity, setTimeout Clamping, and argv Injection

## Problem

Four independent hardening gaps were found together — by a security
reviewer (P0), an adversarial reviewer (P1), a type-design reviewer (P1),
and Codex (P2), all converging on the same request→run mapping surface —
in the schema and mapping code that turns an untrusted request file into
an executable run:

1. The canonical request schema (`schemas/vendored/request.schema.json`)
   defines `constraints.readOnlyTarget` / `constraints.allowTargetEdits`,
   but `requestToRunInputs` never read them. A request explicitly marked
   `readOnlyTarget: true` still mapped to a fully executable run.
2. `maxBudgetUsd: z.number().positive()` accepted `Infinity`: the JSON
   literal `1e400` parses to `Infinity` in JavaScript, and `Infinity` is
   both finite-looking and `.positive()` — it passes zod's `.positive()`
   check while permanently disabling every subsequent `remaining budget
   < maxBudgetUsd`-style comparison in the run.
3. `actionTimeoutMs: z.number().int().positive()` accepted any positive
   integer, including values above `2**31 - 1` (2,147,483,647). Node's
   `setTimeout` silently clamps delays past that value down to 1ms — so a
   request asking for a *longer* per-action timeout would, in practice,
   get an almost-instant kill instead.
4. `execution.model: z.string().min(1)` accepted any non-empty string.
   That string reaches the `claude` subprocess's argv immediately
   adjacent to `--model`, with no constraint on leading characters or
   whitespace — a value like `--dangerously-looking-flag` would be
   parseable by the child process's own argument parser as a second,
   attacker-controlled flag rather than a model name.

## Symptoms

- A request file with `constraints: { readOnlyTarget: true }` still
  produced a real, mutating run against the target repository — the
  declared intent and the actual behavior diverged silently.
- A request file with `guardrails: { maxBudgetUsd: 1e400 }` parsed
  successfully and every budget-guardrail check in the run was
  effectively a no-op from that point forward.
- A request file with `guardrails: { actionTimeoutMs: 3000000000 }`
  (intending a ~50-minute per-action timeout) would in practice time out
  actions almost immediately, because Node clamped the delay to 1ms.
- A request file with `execution.model` set to a string starting with
  `-` could inject an extra argument into the `claude` subprocess
  invocation.

## What Didn't Work / Root Cause

**Constraints:** the schema is `optional-without-defaults` by design —
zod's `.optional()` does not apply the vendored JSON Schema's documented
default values at parse time. That's a legitimate, deliberate divergence
(noted in a code comment and left for a spec follow-up: `plans/specs/`)
for *absent* constraints — but nothing in the mapping code checked
*explicitly present* constraint values either, which is a straightforward
oversight rather than an intentional trade-off. The two are easy to
conflate: "we don't apply undeclared defaults" is a documented decision;
"we ignore declared constraints entirely" is a bug.

**Infinity:** `Number.isFinite(Infinity)` is `false`, but
`z.number().positive()` alone doesn't call `Number.isFinite` — it only
checks `> 0`, which `Infinity` satisfies. `JSON.parse('1e400')` producing
`Infinity` rather than throwing is standard (spec-compliant) JSON
behavior, not a bug in the parser — the request format needed to reject
it explicitly.

**Timeout clamping:** this is documented Node.js behavior (`setTimeout`
delays are a 32-bit signed integer internally), but the schema had no
upper bound reflecting that platform constraint, so a value that is
perfectly valid JSON and perfectly valid by the schema's own rules
produces materially different runtime behavior than the requester
intended.

**Model argv:** the field was brand-new in this PR, so there was no
existing input format or compatibility constraint to preserve —
constraining it was a pure addition, not a breaking narrowing of
previously-accepted values.

## Solution

All four fixes are narrowing-only changes to fields introduced in this
same PR (no compatibility break for existing request files):

```ts
// backend/src/contracts/request.ts
maxBudgetUsd: z.number().positive().finite().optional(),
actionTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
model: z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'model must start with an alphanumeric character and contain only letters, digits, and ._:-')
  .optional(),
```

```ts
// backend/src/run/request-to-run.ts
const constraints = request.constraints;
if (constraints?.readOnlyTarget === true || constraints?.allowTargetEdits === false) {
  throw new IntakeValidationFailure([
    {
      code: 'RUN_CONSTRAINTS_FORBID_EXECUTION',
      message:
        "request constraints forbid an executable run — 'readOnlyTarget: true' / 'allowTargetEdits: false' cannot combine with an executable mode",
      field: 'constraints',
    },
  ]);
}
```

Absent constraints still pass through unchanged — this fix only fails
closed on *explicitly declared* non-writable flags; it does not attempt
to apply the vendored schema's documented defaults (that divergence
remains open, tracked separately).

## Why This Works

Each fix closes exactly the gap between "what the schema's type
signature suggests is validated" and "what is actually enforced at
runtime, including platform-specific numeric/argv edge cases" — without
touching any field's accepted range for values a well-formed request
would ever legitimately use. `.finite()` and `.max(2^31-1)` reject only
the pathological edge values; the model regex rejects only
argv-dangerous shapes (leading `-`, embedded whitespace) while accepting
every realistic model identifier. Failing closed on explicit
`readOnlyTarget`/`allowTargetEdits` values makes the mapping honor the
subset of the contract it *does* read, even though it doesn't yet apply
undeclared defaults.

## Prevention

- When a request/config schema field's *type* is only part of its real
  contract (e.g. "positive number" also implicitly means "and not
  Infinity", "and within platform timer limits"), encode the full
  contract in the schema (`.finite()`, `.max()`) rather than relying on
  downstream code to happen to behave safely on the edge values.
- Any string field that reaches a subprocess argv needs an explicit
  character-class constraint at the validation layer, not just
  non-emptiness — treat "adjacent to a CLI flag in argv" as an injection
  surface the same way you would treat SQL or shell string
  concatenation.
- When a schema is `optional-without-defaults` by design (values absent
  from input stay absent, rather than being backfilled from a spec's
  documented defaults), audit every place that reads those fields for
  whether it also handles the case where the value **is** explicitly
  present — an intentional "don't apply defaults" decision does not
  imply "ignore explicit values" is also safe.
- Cross-reviewer convergence (four different reviewer personas, four
  different angles, same surface) is a strong signal to treat the whole
  surface as under-hardened rather than fixing findings one at a time in
  isolation — see `docs/solutions/workflow/cross-reviewer-agreement-signal.md`.
