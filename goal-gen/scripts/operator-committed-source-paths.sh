#!/usr/bin/env bash
# Execute the documented Path A / Path B fences (and the Pack→Install
# state analog) from docs/operator-committed-source.md. The runbook
# invokes this file; CI runs the same helper. Temporary fixtures only.
# Does not npm pack recorded 6ac355f. Does not npm run runner.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNBOOK="$ROOT/docs/operator-committed-source.md"
test -f "$RUNBOOK"
command -v jq >/dev/null
command -v sha256sum >/dev/null

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
  eval "$body"
}

assert_trap_immediately_after_add() {
  local name="$1"
  local body next
  body="$(extract_recipe "$name")"
  next="$(printf '%s\n' "$body" | awk '
    /worktree add "\$PACK_SRC" HEAD/ { getline; print; exit }
  ')"
  if [ "$next" != '  trap pack_src_cleanup EXIT' ]; then
    echo "trap not immediately after worktree add in recipe $name: ${next:-<missing>}" >&2
    return 1
  fi
}

WORKDIR="$(mktemp -d /tmp/cs-recipe.XXXXXX)"
PATH_B_REPO=""
# Ignore caller-exported pack paths. cleanup_helper may worktree-remove
# only a checkout this process created (recipes assign these later).
unset PACK_SRC PACK_REPO PACK_SRC_ROOT || true
PACK_SRC=""
PACK_REPO=""
PACK_SRC_ROOT=""
cleanup_helper() {
  if [ -n "${PACK_SRC:-}" ] && [ -d "$PACK_SRC" ]; then
    pack_repo="${PACK_REPO:-}"
    if [ -z "$pack_repo" ]; then
      pack_repo="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    fi
    unregistered=0
    if [ -n "$pack_repo" ]; then
      if git -C "$pack_repo" worktree remove --force "$PACK_SRC"; then
        unregistered=1
      fi
    fi
    if [ "$unregistered" -eq 1 ] && [ -n "${PACK_SRC_ROOT:-}" ]; then
      rm -rf -- "$PACK_SRC_ROOT" || true
    fi
  fi
  if [ -n "${PATH_B_REPO:-}" ] && [ -d "$PATH_B_REPO" ]; then
    rm -rf -- "$PATH_B_REPO"
  fi
  rm -rf -- "$WORKDIR"
}
trap cleanup_helper EXIT

if [ -z "${BIN:-}" ]; then
  tarball="$WORKDIR/$(
    cd "$ROOT"
    npm pack --pack-destination "$WORKDIR" | tail -n 1
  )"
  test -f "$tarball"
  consumer="$WORKDIR/consumer"
  mkdir "$consumer"
  test ! -L "$consumer"
  (
    cd "$consumer"
    npm init -y >/dev/null
    npm install --no-audit --no-fund "$tarball" >/dev/null
  )
  BIN="$consumer/node_modules/.bin/goal-gen"
fi
test -x "$BIN"
export BIN

run_recipe pack-state-handshake
run_recipe pack-state-missing
run_recipe pack-state-trap
run_recipe pack-state-pretrap-node
run_recipe pack-state-pretrap-alloc
assert_trap_immediately_after_add pack-state-unregister-fail
assert_trap_immediately_after_add pack-state-unregister-after-add
run_recipe pack-state-unregister-fail
run_recipe pack-state-unregister-after-add
run_recipe path-b-bytes-fail
run_recipe path-b-symlink-mode-fail
run_recipe path-b-dir-mtime-fail
run_recipe path-a-pretrap-mktemp
run_recipe path-a-pretrap-commit
run_recipe path-b-seed-pretrap-mktemp
run_recipe path-b-seed-pretrap-commit
unset DURABLE CS_PACK_STATE || true

# Path A — owned disposable fixture, independent of Path B.
(
  set -euo pipefail
  export BIN
  REPO=""
  CS_SCRATCH=""
  path_a_cleanup() {
    rc=$?
    rm -rf -- "${REPO:-}"
    rm -rf -- "${CS_SCRATCH:-}"
    return "$rc"
  }
  trap path_a_cleanup EXIT
  run_recipe path-a-1
  run_recipe path-a-fail
  run_recipe path-a-2
  run_recipe path-a-3
  run_recipe path-a-4-extra
  run_recipe path-a-4-unauth
  run_recipe path-a-5
  trap - EXIT
)

# Existing clone for Path B: A.1 generation only (no canaries).
PATH_B_REPO="$(
  set -euo pipefail
  export BIN
  REPO=""
  CS_SCRATCH=""
  path_b_seed_cleanup() {
    rc=$?
    if [ "$rc" -ne 0 ]; then
      rm -rf -- "${REPO:-}"
      rm -rf -- "${CS_SCRATCH:-}"
    fi
    return "$rc"
  }
  trap path_b_seed_cleanup EXIT
  run_recipe path-a-1
  printf '%s\n' "$REPO"
  rm -rf -- "$CS_SCRATCH"
)"
test -d "$PATH_B_REPO"
test ! -L "$PATH_B_REPO"
PATH_B_HEAD="$(GIT_OPTIONAL_LOCKS=0 git -C "$PATH_B_REPO" rev-parse HEAD)"
test "${#PATH_B_HEAD}" -eq 40
PATH_B_INDEX="$(
  gitdir="$(GIT_OPTIONAL_LOCKS=0 git -C "$PATH_B_REPO" rev-parse --absolute-git-dir)"
  index_file="$gitdir/index"
  test ! -L "$index_file"
  if [ -e "$index_file" ]; then
    test -f "$index_file"
    sha256sum "$index_file" | awk '{print $1}'
  else
    printf 'absent\n'
  fi
)"
path_b_helper_worktree_manifest() {
  repo="$1"
  (
    cd "$repo" || exit 1
    find . -path './.git' -prune -o \( -type f -o -type l -o -type d \) \
      -printf '%y\t%m\t%p\t%l\n' \
      | LC_ALL=C sort
    find . -path './.git' -prune -o -type f -printf '%T@\t%p\n' \
      | LC_ALL=C sort
    find . -path './.git' -prune -o -type f -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 -r sha256sum --
  )
}
PATH_B_TREE="$WORKDIR/path-b-before-worktree.txt"
path_b_helper_worktree_manifest "$PATH_B_REPO" > "$PATH_B_TREE"

# Path B — existing-clone non-mutation against the clone created above.
(
  set -euo pipefail
  export BIN
  export REPO="$PATH_B_REPO"
  path_b_cleanup() {
    rc=$?
    if [ -n "${CS_SCRATCH:-}" ]; then
      rm -rf -- "$CS_SCRATCH"
    fi
    return "$rc"
  }
  trap path_b_cleanup EXIT
  run_recipe path-b-1
  run_recipe path-b-fail
  run_recipe path-b-2
  run_recipe path-b-3
  run_recipe path-b-4-extra
  run_recipe path-b-4-unauth
  run_recipe path-b-5
  trap - EXIT
)

test -d "$PATH_B_REPO"
test "$(GIT_OPTIONAL_LOCKS=0 git -C "$PATH_B_REPO" rev-parse HEAD)" = "$PATH_B_HEAD"
after_index="$(
  gitdir="$(GIT_OPTIONAL_LOCKS=0 git -C "$PATH_B_REPO" rev-parse --absolute-git-dir)"
  index_file="$gitdir/index"
  test ! -L "$index_file"
  if [ -e "$index_file" ]; then
    test -f "$index_file"
    sha256sum "$index_file" | awk '{print $1}'
  else
    printf 'absent\n'
  fi
)"
test "$after_index" = "$PATH_B_INDEX"
path_b_helper_worktree_manifest "$PATH_B_REPO" > "$WORKDIR/path-b-after-worktree.txt"
cmp -s "$PATH_B_TREE" "$WORKDIR/path-b-after-worktree.txt"

echo "operator-committed-source-paths: Path A, Path B, and pack-state analog passed"
