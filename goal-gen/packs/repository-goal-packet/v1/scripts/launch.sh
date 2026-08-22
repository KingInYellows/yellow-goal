#!/usr/bin/env bash
set -euo pipefail

# Usage: launch.sh <target-repo-path> [--mode review|implement] [--add-dir <path>]...
#
# Launches Claude Code against the target repository using this packet. Requires
# prompts/MASTER_IMPLEMENTATION_PROMPT.md and CHECKSUMS.sha256 at the packet root.
#
# review    -> --permission-mode plan       (read-only review of the packet/plan)
# implement -> --permission-mode acceptEdits (approved implementation)
#
# This script never passes bypassPermissions as a --permission-mode value, and never falls back
# to it. Only an explicitly human-approved autonomous-isolated profile may ever consider that
# mode, and it is not implemented here. A worktree is writer-collision isolation, not a sandbox.
# Merge, deployment, and secret rotation remain unauthorized regardless of this run's outcome.

MODE="review"
TARGET_REPO=""
EXTRA_ADD_DIRS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="$2"
      shift 2
      ;;
    --add-dir)
      EXTRA_ADD_DIRS+=("$2")
      shift 2
      ;;
    *)
      TARGET_REPO="$1"
      shift
      ;;
  esac
done

if [[ -z "$TARGET_REPO" ]]; then
  echo "usage: launch.sh <target-repo-path> [--mode review|implement] [--add-dir <path>]..." >&2
  exit 1
fi

command -v claude >/dev/null 2>&1 || {
  echo "claude CLI not found" >&2
  exit 1
}

PACKET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_REPO_ABS="$(cd "$TARGET_REPO" && pwd)"
MASTER_PROMPT="$PACKET_ROOT/prompts/MASTER_IMPLEMENTATION_PROMPT.md"
if [[ ! -f "$MASTER_PROMPT" ]]; then
  echo "missing prompts/MASTER_IMPLEMENTATION_PROMPT.md — refusing to launch without the packet goal" >&2
  exit 1
fi

echo "Verifying packet integrity before launch..."
if ! (cd "$PACKET_ROOT" && sha256sum -c CHECKSUMS.sha256 --quiet); then
  echo "Packet checksum verification FAILED — refusing to launch against a possibly-tampered or incomplete packet." >&2
  exit 1
fi

case "$MODE" in
  review)
    PERMISSION_MODE="plan"
    ;;
  implement)
    PERMISSION_MODE="acceptEdits"
    ;;
  *)
    echo "unknown --mode '$MODE' (expected review|implement)" >&2
    exit 1
    ;;
esac

# Lead model resolution order: explicit env override, then the packet's own resolved
# orchestration contract (contracts/orchestration.json lead.modelId — the source of truth),
# then the claude-fable-opus-sonnet@1 profile's documented lead as a last-resort literal.
ORCH_CONTRACT="$PACKET_ROOT/contracts/orchestration.json"
CONTRACT_LEAD=""
if [ -f "$ORCH_CONTRACT" ]; then
  CONTRACT_LEAD=$(sed -n 's/.*"modelId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ORCH_CONTRACT" | head -1)
fi
LEAD_MODEL="${YELLOW_GOAL_LEAD_MODEL:-${CONTRACT_LEAD:-claude-fable-5}}"

# The packet directory usually lives outside the target repository's worktree (it is a sibling
# artifact, not part of the repository it describes). When that is the case, pass --add-dir so
# the session can still read the packet's prompts/contracts/evidence.
ADD_DIR_ARGS=()
case "$TARGET_REPO_ABS" in
  "$PACKET_ROOT" | "$PACKET_ROOT"/*) ;;
  *)
    ADD_DIR_ARGS+=(--add-dir "$PACKET_ROOT")
    ;;
esac
for d in "${EXTRA_ADD_DIRS[@]:-}"; do
  [[ -n "$d" ]] && ADD_DIR_ARGS+=(--add-dir "$(cd "$d" && pwd)")
done

echo "Packet root: $PACKET_ROOT"
echo "Target repository: $TARGET_REPO_ABS"
echo "Mode: $MODE (--permission-mode $PERMISSION_MODE)"
echo "Lead model: $LEAD_MODEL"
echo
echo "NOTE: a worktree is writer-collision isolation, not a security sandbox. An agent running"
echo "here can still reach the host filesystem, credentials, network, and sibling repositories."
echo "Merge, deployment, and secret rotation remain unauthorized regardless of this run's outcome."

export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-1}"

cd "$TARGET_REPO_ABS"

set +e
claude \
  --model "$LEAD_MODEL" \
  --effort high \
  --permission-mode "$PERMISSION_MODE" \
  --teammate-mode in-process \
  "${ADD_DIR_ARGS[@]}" \
  "$(cat "$MASTER_PROMPT")"
CLAUDE_EXIT=$?
set -e

echo "Re-verifying packet integrity after launch (immutability check)..."
if ! (cd "$PACKET_ROOT" && sha256sum -c CHECKSUMS.sha256 --quiet); then
  echo "WARNING: packet checksums changed during this run. The packet is meant to be immutable" >&2
  echo "after sign-off; investigate before trusting this packet's contents further." >&2
fi

echo "NOTE: if --teammate-mode in-process could not start an agent team, the session falls back"
echo "to ordinary subagents. That fallback must be recorded in this run's evidence and must"
echo "never be reported as an agent team."

exit "$CLAUDE_EXIT"
