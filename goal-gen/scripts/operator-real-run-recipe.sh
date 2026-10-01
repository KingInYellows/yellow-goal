#!/usr/bin/env bash
# Execute the documented rehearsal fences from docs/operator-real-run.md against the test-only
# harness and the fake worker (AGX-R33, ADR-0019). Zero spend: no real `claude`, no `run approve`
# (the harness mints approvals through the injected-terminal seam), no production real-run path.
# The worker is chosen only by the harness; this script never sets PATH or any worker variable.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNBOOK="$ROOT/docs/operator-real-run.md"
test -f "$RUNBOOK"
command -v jq >/dev/null
cd "$ROOT"

# A host credential or provider override would trip AUTH_MODE_MISMATCH in the harness.
for name in $(compgen -e); do
  case "$name" in ANTHROPIC_* | CLAUDE_CODE_*) unset "$name" ;; esac
done

extract_recipe() {
  local name="$1"
  awk -v name="$name" '
    index($0, "<!-- recipe:" name " -->") { found = 1; next }
    found && /^```bash/ { grab = 1; next }
    grab && /^```/ { exit }
    grab { print }
  ' "$RUNBOOK"
}

run_recipe() {
  local name="$1"
  local body
  body="$(extract_recipe "$name")"
  if [ -z "$body" ]; then
    echo "missing runbook recipe: $name" >&2
    return 1
  fi
  # AGX-R33: a fence may drive only the harness. This lint is defense in depth (the real fence is
  # that `harness` below is read-only and the sandboxed HOME carries no credentials). Join
  # continuation lines and strip quoting so `"run"`, `--executor=claude-code` and `${BIN}` match.
  local flat
  flat="$(printf '%s\n' "$body" | sed -e ':a' -e '/\\$/{N;s/\\\n[[:space:]]*/ /;ba' -e '}' | tr -d "\"'{}" | tr '=' ' ')"
  if printf '%s\n' "$flat" | grep -Eq 'run +approve|executor +claude-code|npm|tsx|cli\.mjs|bin/goal-gen|PATH|workerCommand|CLAUDE_|ANTHROPIC_|\(\)|function |alias |BIN +run|goal-gen +run'; then
    echo "recipe $name invokes a forbidden command, redefines the harness, or sets a worker/credential" >&2
    return 1
  fi
  # `agx-claude-code` may appear only on a command that goes through the harness.
  if printf '%s\n' "$flat" | grep 'agx-claude-code' | grep -v 'harness --mode protocol-v2'; then
    echo "recipe $name names agx-claude-code outside the harness" >&2
    return 1
  fi
  eval "$body"
}

# The fences get no host credentials: a subscription run would read ~/.claude.
harness() { node "$ROOT/node_modules/tsx/dist/cli.mjs" "$ROOT/tests/harness/real-run-harness.ts" "$@"; }
readonly -f harness

REH="$(mktemp -d)"
cleanup() { rm -rf -- "$REH"; }
trap cleanup EXIT
export REH
mkdir "$REH/home"
export HOME="$REH/home"
# The fences call "$BIN" for the non-spending verbs. Default: this checkout's bin shim, the same
# entry the installed package exposes (override BIN to rehearse against an installed tarball).
BIN="${BIN:-$ROOT/bin/goal-gen.mjs}"
test -x "$BIN"
export BIN

run_recipe rehearsal-setup
run_recipe rehearsal-success
run_recipe rehearsal-wrong-repair
run_recipe rehearsal-budget-stop
run_recipe rehearsal-reused-approval
run_recipe rehearsal-reproduce

types() { jq -r '.type' "$1" | paste -sd, -; }
summary() { jq -c 'select(.type == "run.summary") | .payload' "$1"; }
errcode() { jq -r '.error.code' "$1"; }
worker_runs() { grep -c . "$REH/worker.jsonl"; }

# success: verified, exit 0, the v2 stream, a bundle, one ledger line.
test "$(cat "$REH/exit-success")" = 0
test ! -s "$REH/err-success.txt"
test "$(types "$REH/out-success.jsonl")" = "run.start,run.spend,run.summary"
test "$(jq -r 'select(.type == "run.start") | .payload.protocolVersion' "$REH/out-success.jsonl")" = "yellow-goal/provider-protocol/v2"
test "$(jq -r 'select(.type == "run.start") | .payload.simulation' "$REH/out-success.jsonl")" = "false"
test "$(summary "$REH/out-success.jsonl" | jq -r .outcome)" = verified
test -f "$REH/b-success/COMPLETE"
test "$(grep -c . "$REH/l-success.jsonl")" = 1
test "$(jq -r .approvalId "$REH/mint-success.json")" = "$(jq -r 'select(.type == "run.start") | .payload.approvalId' "$REH/out-success.jsonl")"

# wrong-repair: the verifier rejects, with a bundle and exit 1.
test "$(cat "$REH/exit-wrong")" = 1
test "$(types "$REH/out-wrong.jsonl")" = "run.start,run.spend,run.summary"
test "$(summary "$REH/out-wrong.jsonl" | jq -r .outcome)" = verification-rejected
test -f "$REH/b-wrong/COMPLETE"
test "$(errcode "$REH/err-wrong.txt")" = RUN_VERIFICATION_REJECTED

# budget-stop: worker-failed, spend recorded, no bundle.
test "$(cat "$REH/exit-budget")" = 1
test "$(types "$REH/out-budget.jsonl")" = "run.start,run.spend,run.summary"
test "$(summary "$REH/out-budget.jsonl" | jq -r .outcome)" = worker-failed
test "$(summary "$REH/out-budget.jsonl" | jq 'has("bundleDir")')" = false
test ! -e "$REH/b-budget"
test "$(grep -c . "$REH/l-budget.jsonl")" = 1
test "$(errcode "$REH/err-budget.txt")" = RUN_WORKER_FAILED

# reused approval: refused with zero stdout bytes and no extra worker invocation.
test "$(cat "$REH/exit-reused")" = 1
test ! -s "$REH/out-reused.jsonl"
test "$(errcode "$REH/err-reused.txt")" = APPROVAL_CONSUMED
test "$(worker_runs)" = 3

# step 4: the verified bundle reproduces in a fresh process.
test "$(jq -r .decision.accepted "$REH/reproduce.json")" = true

echo "operator-real-run-recipe: rehearsal fences (fake worker, zero spend) passed"
