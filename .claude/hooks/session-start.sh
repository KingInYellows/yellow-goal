#!/bin/bash
# Installs goal-gen dependencies in Claude Code cloud sessions so typecheck,
# test, and eval work from the first turn. Local sessions are left alone.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Preserve Phase 1 for fresh cloud checkouts. Never seed approval identities
# from repository-controlled content or replace an operator's local config.
config="$CLAUDE_PROJECT_DIR/yellow-plugins.local.md"
if [[ ! -e "$config" && ! -L "$config" ]]; then
  (set -C; printf '%s\n' '---' 'review_pipeline: workflow' '---' > "$config") ||
    [[ -f "$config" && ! -L "$config" ]]
fi

cd "$CLAUDE_PROJECT_DIR/goal-gen"
npm install --no-audit --no-fund
