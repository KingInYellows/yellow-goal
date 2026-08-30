# Concepts

Shared domain vocabulary for this project — entities, named processes, and
status concepts with project-specific meaning. Accretes as
`/flow:compound` processes learnings; direct edits are fine. Glossary
only, not a spec or catch-all.

## run-event/v1

The JSON Lines protocol stream emitted on stdout by the M1 runner and the
`run` verb entry points to communicate machine-parsed run progress and
terminal outcomes. Because it is machine-parsed, nothing else may write
human-facing prose to the same stdout stream for these entry points —
interactive prompts and diagnostic output must go to stderr instead.

## terminal event

The final event in a `run-event/v1` stream (a `run.summary` event) that
signals a run has concluded. Every code path through a run — including
extraction-failure and abort paths that occur before the run has fully
initialized — must emit exactly one terminal event, or a downstream
consumer reading the stream has no way to detect that the run ended.

## DoD gate

The interactive confirmation step where the operator confirms a run's
definition-of-done before execution proceeds. On EOF stdin (an
unattended/non-interactive invocation) it declines rather than hanging,
since declining before any spend happens costs nothing.

*Avoid: confirm-DoD, stdinConfirm (implementation names, not the concept)*

## acceptance gate

*Avoid: sign-off gate*

The interactive confirmation step that gates whether a completed run's
output is accepted or sent back for remediation. Unlike the DoD gate, it
must fail loudly rather than silently decide on the operator's behalf on
EOF stdin, because resolving to "reject" re-enters the remediation loop
and spends real LLM budget with nobody present to have authorized it.
