#!/usr/bin/env bash
set -euo pipefail

# Usage: preflight.sh <target-repo-path>
#
# Read-only sanity checks run before scripts/launch.sh. Performs no writes to the packet or to
# the target repository.

TARGET_REPO="${1:-}"
if [[ -z "$TARGET_REPO" ]]; then
  echo "usage: preflight.sh <target-repo-path>" >&2
  exit 1
fi

PACKET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

check() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  [ok] $desc"
  else
    echo "  [FAIL] $desc"
    FAILED=1
  fi
}

echo "Preflight — $PACKET_ROOT"
echo

echo "Tool availability:"
check "claude CLI present" command -v claude
check "git present" command -v git
if command -v gh >/dev/null 2>&1; then
  echo "  [ok] gh CLI present (optional)"
else
  echo "  [warn] gh CLI not found — GitHub-API-derived evidence in this packet cannot be revalidated live"
fi

echo
echo "Packet integrity:"
if [[ -f "$PACKET_ROOT/CHECKSUMS.sha256" ]]; then
  if (cd "$PACKET_ROOT" && sha256sum -c CHECKSUMS.sha256 --quiet); then
    echo "  [ok] CHECKSUMS.sha256 verifies"
  else
    echo "  [FAIL] CHECKSUMS.sha256 does NOT verify — packet may be tampered or incomplete"
    FAILED=1
  fi
else
  echo "  [FAIL] CHECKSUMS.sha256 missing at packet root"
  FAILED=1
fi
if [[ -f "$PACKET_ROOT/MANIFEST.json" ]]; then
  echo "  [ok] MANIFEST.json present"
else
  echo "  [FAIL] MANIFEST.json missing at packet root"
  FAILED=1
fi

echo
echo "Target repository:"
if [[ -d "$TARGET_REPO" ]]; then
  echo "  [ok] target path exists"
  if (cd "$TARGET_REPO" && git rev-parse --is-inside-work-tree) >/dev/null 2>&1; then
    echo "  [ok] target is a git working tree"
    CURRENT_SHA="$(cd "$TARGET_REPO" && git rev-parse HEAD)"
    echo "  [info] current HEAD: $CURRENT_SHA"
    echo "  [info] compare this against contracts/request.json / evidence/repository-profile.json;"
    echo "  [info] a mismatch means the packet is stale and inspection should be rerun."
  else
    echo "  [FAIL] target is not a git working tree"
    FAILED=1
  fi
else
  echo "  [FAIL] target path does not exist: $TARGET_REPO"
  FAILED=1
fi

echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "Preflight PASSED. This check performed no writes to the packet or the target repository."
  exit 0
else
  echo "Preflight FAILED. Resolve the items above before running scripts/launch.sh."
  exit 1
fi
