#!/bin/bash
# Installs goal-gen dependencies in Claude Code cloud sessions so typecheck,
# test, and eval work from the first turn. Local sessions are left alone.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR/goal-gen"
npm install --no-audit --no-fund
