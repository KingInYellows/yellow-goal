# Operator runbook — committed-source capture (landed `main`)

Local installable tarball of Graphite-merged `#41`. Not a public release.
Not a registry publish. Not `npm run runner`. Not live execution. Not
verified single-milestone execution completed. Do not rewrite ADR-0018.

Landed trunk: `origin/main` `ec8f33ce94047088c332dee03b666d92a591981e`
(unrelated `#42` CI allowlist, then `#43` runbook). Dest-mkdir leftover rollback remains
Graphite-merged `#44` `3d658276cc89801ae6556e99349a43084c02e9dc`
(same tree as reviewed `051e030`; ancestor of current `main`).
Recorded pack identity remains Graphite-merged `#41`
`6ac355f416b5f2ddaf9820b353d61b62b60b953d` (squash of packed origin
`6c5e7548391a44205a99055575466b683614bf21`; same tree
`bc9d332fe7cc47aeaeaebfcb22de8f95568a8cbd`).

Profile: `package-manifest-lockfile`. Dest `--bundle-dir` may be missing
(created) or empty, and must be outside the captured source worktree,
per-worktree git dir, and common Git directory. Unrelated git used only as
evidence storage is allowed. Dest inside the live captured source is
`USAGE_ERROR`. Honest missing-parent dest outside source still persist
`COMPLETE`. Dest-mkdir leftover rollback of created intermediates landed
as `#44` `3d658276cc89801ae6556e99349a43084c02e9dc`
(same tree as reviewed `051e030`; now an ancestor of `origin/main`
`ec8f33c`). The recorded `6ac355f` BIN
(`28dcde91…`) this runbook installs does not include that rollback;
leftover parent directories can remain in the source on containment /
`USAGE_ERROR`. Do not pack `3d65827`, `f9974a86`, `ec8f33c`, or this
runbook branch as the recorded `28dcde91` artifact. Retarget pack
identity before advertising leftover-absent on `$BIN`.

The recorded tarball is packed from `6ac355f`, not from this runbook
revision, landed `#44`, `f9974a86`, or `ec8f33c`. Packing those heads
yields a different SHA-256. Do not treat that as the recorded artifact.

Expected pack identity:

- `HEAD` `6ac355f416b5f2ddaf9820b353d61b62b60b953d`
- SHA-256 `28dcde91b5d6505f6c798ae919c93a6991bce7c7c1ad52ddc4f330f8340446dd`
- npm filename `goal-gen-0.2.0.tgz`
- publish dest: operator-owned real directory
  (`mktemp -d /tmp/goal-gen-artifacts.XXXXXX`). Not
  `/opt/cursor/artifacts` — that path is a symlink ancestor here.

## Choose exactly one capture path

Run **Path A** or **Path B**. They are independent recipes. Do not
concatenate them. Do not continue from Path B setup into Path A writes.
A prose warning above a shared write block is not a split.

- **Path A — disposable owned self-test.** This invocation creates a
  uniquely named private fixture and retains ownership. Canaries, tracked
  dirt, and wrapper tests that plant dirt live only here. Baseline after
  that intentional setup. Cleanup only owned resources.
- **Path B — existing local clone.** Pinned commit. Evidence only to
  approved external destinations. No canary, append, touch, chmod, git
  add/commit, stash, reset, checkout, clean, fetch, index refresh, or
  restore-after-modify. A pre-existing canary name is user content.
  Dirty, staged, and untracked files stay untouched and are **not
  assessed** by committed-source capture. Do not run `git status`,
  `git diff`, `git diff-files`, or `git diff-index` on this clone.
  Observe HEAD with `GIT_OPTIONAL_LOCKS=0 git rev-parse`. If the
  on-disk index already exists, sha256 that file from outside git; if
  it is absent, record `absent` and do not create or refresh it.
  Missing inputs fail closed. Do not require a canary to exist. Do not
  hash a missing index.

Non-mutation observations start before any source-affecting setup.
Inspection output stays external (`$CS_SCRATCH`, durable BIN, consumer).
Pack worktree registration is not a read-only operation on a Path B
captured source. Do not `git worktree add` against that clone.

Acceptance commands exit 0 for both `decision.accepted=true` and
`accepted=false`. `set -euo pipefail` continues after a domain reject.
Capture each JSON response under `$CS_SCRATCH` and assert
`.decision.accepted` plus the expected reason with `jq -e` before
proceeding. `jq -e '.decision.accepted == true'` after unauthorized
overlay exits 1. `jq -e` on the JSON does not prove the source was
left alone.

CI and operators invoke the same helper for Path A, Path B, and the
Pack→Install state analog. That helper extracts and executes the
`<!-- recipe:... -->` fences in this document. It does not
`npm run runner`. `$BIN` is an installed `goal-gen` bin.

```bash
BIN=/path/to/goal-gen bash scripts/operator-committed-source-paths.sh
```

When `$BIN` is unset, the helper packs the current checkout into a
scratch consumer. Temporary fixtures only. Path A and Path B still
run in independent shells. Do not concatenate them by hand.

## Pack (from recorded `6ac355f`, not this revision, not Path B `$REPO`)

Work from a clean worktree of the recorded commit. `npm pack` packages
the current worktree; this runbook branch is dest-mkdir + docs. Create
the pack worktree from a yellow-goal checkout that already has
`6ac355f` — do not fetch. That checkout must not be the Path B captured
`$REPO`. If the durable tarball already matches `28dcde91…`, skip this
block and go to Install.

Do not `PACK_DEST=/tmp/goal-gen-pack-6ac355f` then `mkdir -p`. That
follows a pre-existing dest symlink, and `npm pack` follows a
pre-existing `goal-gen-0.2.0.tgz` symlink before any checksum. Allocate
a private dest with `mktemp -d`, or fail unless the dest and packed
name are absent (`test ! -e` / `test ! -L`).

Do not `PACK_SRC=/tmp/goal-gen-pack-src-6ac355f`. A second
`git worktree add` of that path exits 128 `fatal: already exists`.
Allocate a unique missing worktree path under a private `mktemp -d`,
or fail unless the path is absent, and `git worktree remove` it on
cleanup. After `git worktree add` succeeds, install an `EXIT` trap
before a later `test -d "$PACK_SRC"` so a failing existence check or
a later `set -e` failure (SHA-gate, durable publish, or provenance)
still unregisters `$PACK_SRC`. Cleanup only at the end of the block,
or a trap after that `test -d`, leaves a registered worktree on those
paths.

Run the pack block in an isolated subshell so its `EXIT` trap cannot
prune, reset, or clean a later Path A/B shell, and so a later Path
failure does not fire pack cleanup. The trap preserves the primary
`set -e` status and surfaces a cleanup failure if the primary
succeeded. It does not `git worktree prune`, `git reset`, or
`git clean`. `EXIT` does not run on `SIGKILL`; a leftover owned
`$PACK_SRC` then needs a later `git worktree remove` of that path
only.

The isolated subshell cannot export `DURABLE` to the parent. The
parent creates `$CS_PACK_STATE` (a regular file) before the
subshell. After a successful publish, the subshell writes the
artifact path there. Printing `DURABLE=...` does not export.
Install reads that file when `DURABLE` is unset and fails closed
if it is missing, empty, or a symlink. Do not drop the isolated
`EXIT` trap to leak the variable.

Do not `mkdir -p /opt/cursor/artifacts`. That follows a symlink
ancestor; leaf `test ! -L "$DURABLE"` still passes and `mv -T`
publishes through the link. Fail closed before publish if the
destination directory or any existing ancestor is a symlink. Publish
into an operator-owned real directory from `mktemp -d`. The live
`/opt/cursor/artifacts` symlink is not a safe publish dest.

Do not `cp -f "$PACKED" "$DURABLE"`. That follows a pre-existing
durable symlink and the following checksum reads the overwritten
target. Fail if `$DURABLE` is a symlink or exists as the wrong type.
Publish through a regular temp file and `mv -T` into place.

Do not `open(..., "w")` of `$PROVENANCE`. That follows a pre-existing
provenance symlink and the following `json.load` reads the overwritten
target. Fail if `$PROVENANCE` is a symlink or exists as the wrong type.
Publish through a regular temp file and `mv -T` into place.

<!-- recipe:pack -->
```bash
# Parent creates the state path before the isolated pack subshell.
CS_PACK_STATE="$(mktemp /tmp/cs-pack-state.XXXXXX)"
test -f "$CS_PACK_STATE"
test ! -L "$CS_PACK_STATE"
(
set -euo pipefail
pack_src_cleanup() {
  rc=$?
  cleanup_rc=0
  unregistered=0
  if [ -n "${PACK_REPO:-}" ] && [ -n "${PACK_SRC:-}" ] && [ -d "$PACK_SRC" ]; then
    if git -C "$PACK_REPO" worktree remove --force "$PACK_SRC"; then
      unregistered=1
    else
      cleanup_rc=$?
    fi
  else
    unregistered=1
  fi
  if [ "$unregistered" -eq 1 ] && [ -n "${PACK_SRC_ROOT:-}" ]; then
    if [ "$rc" -eq 0 ]; then
      rmdir "$PACK_SRC_ROOT" || true
    else
      rm -rf -- "$PACK_SRC_ROOT" || true
    fi
  fi
  if [ "$rc" -ne 0 ]; then
    if [ -n "${PACK_DEST:-}" ]; then
      rm -rf -- "$PACK_DEST" || true
    fi
    if [ -n "${ARTIFACT_ROOT:-}" ]; then
      rm -rf -- "$ARTIFACT_ROOT" || true
    fi
    if [ -n "${CS_PACK_STATE:-}" ]; then
      rm -f -- "$CS_PACK_STATE" || true
    fi
  fi
  if [ "$cleanup_rc" -ne 0 ]; then
    echo "pack worktree cleanup failed: $PACK_SRC" >&2
    if [ "$rc" -eq 0 ]; then
      return "$cleanup_rc"
    fi
  fi
  return "$rc"
}
trap pack_src_cleanup EXIT
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
EXPECTED_NODE=v22.22.2
EXPECTED_NPM=10.9.7
OBSERVED_NODE="$(node -v)"
OBSERVED_NPM="$(npm -v)"
test "$OBSERVED_NODE" = "$EXPECTED_NODE"
test "$OBSERVED_NPM" = "$EXPECTED_NPM"

RECORDED=6ac355f416b5f2ddaf9820b353d61b62b60b953d
EXPECTED_SHA=28dcde91b5d6505f6c798ae919c93a6991bce7c7c1ad52ddc4f330f8340446dd
PACK_REPO="$(git rev-parse --show-toplevel)"
PACK_SRC_ROOT="$(mktemp -d /tmp/goal-gen-pack-src.XXXXXX)"
PACK_SRC="$PACK_SRC_ROOT/src"
PACK_DEST="$(mktemp -d /tmp/goal-gen-pack.XXXXXX)"
PACKED="$PACK_DEST/goal-gen-0.2.0.tgz"
ARTIFACT_ROOT="$(mktemp -d /tmp/goal-gen-artifacts.XXXXXX)"
DURABLE="$ARTIFACT_ROOT/goal-gen-0.2.0-6ac355f.tgz"
PROVENANCE="$ARTIFACT_ROOT/goal-gen-0.2.0-6ac355f.provenance.json"

fail_if_symlink_dir_or_ancestor() {
  cur="$1"
  while [ -n "$cur" ] && [ "$cur" != "/" ]; do
    if [ -L "$cur" ]; then
      echo "symlink dest or ancestor: $cur" >&2
      return 1
    fi
    next="$(dirname "$cur")"
    [ "$next" = "$cur" ] && break
    cur="$next"
  done
}

test -d "$PACK_DEST"
test ! -L "$PACK_DEST"
test ! -e "$PACKED"
test ! -L "$PACKED"
test ! -e "$PACK_SRC"
test ! -L "$PACK_SRC"
test -d "$ARTIFACT_ROOT"
test ! -L "$ARTIFACT_ROOT"
fail_if_symlink_dir_or_ancestor "$ARTIFACT_ROOT"
fail_if_symlink_dir_or_ancestor "$DURABLE"
fail_if_symlink_dir_or_ancestor "$PROVENANCE"

git -C "$PACK_REPO" worktree add "$PACK_SRC" "$RECORDED"
cd "$PACK_SRC"
test "$(git rev-parse HEAD)" = "$RECORDED"
test -z "$(git status --porcelain)"

cd "$PACK_SRC/goal-gen"
npm pack --pack-destination "$PACK_DEST"

test -f "$PACKED"
test "$(sha256sum "$PACKED" | awk '{print $1}')" = "$EXPECTED_SHA"
fail_if_symlink_dir_or_ancestor "$DURABLE"
test ! -L "$DURABLE"
if [ -e "$DURABLE" ]; then
  test -f "$DURABLE"
fi
DURABLE_TMP="$(mktemp "${DURABLE}.XXXXXX")"
test -f "$DURABLE_TMP"
test ! -L "$DURABLE_TMP"
cp "$PACKED" "$DURABLE_TMP"
test "$(sha256sum "$DURABLE_TMP" | awk '{print $1}')" = "$EXPECTED_SHA"
mv -T "$DURABLE_TMP" "$DURABLE"
test -f "$DURABLE"
test ! -L "$DURABLE"
test "$(sha256sum "$DURABLE" | awk '{print $1}')" = "$EXPECTED_SHA"
fail_if_symlink_dir_or_ancestor "$PROVENANCE"
test ! -L "$PROVENANCE"
if [ -e "$PROVENANCE" ]; then
  test -f "$PROVENANCE"
fi
PROVENANCE_TMP="$(mktemp "${PROVENANCE}.XXXXXX")"
test -f "$PROVENANCE_TMP"
test ! -L "$PROVENANCE_TMP"
python3 - "$DURABLE" "$EXPECTED_SHA" "$PROVENANCE_TMP" "$RECORDED" \
  "$PACK_SRC/goal-gen" "$PACK_DEST" "$OBSERVED_NODE" "$OBSERVED_NPM" <<'PY'
import json
import os
import sys

durable, sha, provenance, recorded, pack_cwd, pack_dest, node, npm = sys.argv[1:9]
doc = {
    "artifact": durable,
    "npm_pack_filename": "goal-gen-0.2.0.tgz",
    "sha256": sha,
    "bytes": os.path.getsize(durable),
    "origin_main": recorded,
    "pack_cwd": pack_cwd,
    "pack_command": ["npm", "pack", "--pack-destination", pack_dest],
    "node": node,
    "npm": npm,
    "public_release": False,
}
with open(provenance, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2)
    fh.write("\n")
PY
mv -T "$PROVENANCE_TMP" "$PROVENANCE"
test -f "$PROVENANCE"
test ! -L "$PROVENANCE"
python3 - "$PROVENANCE" "$EXPECTED_SHA" "$EXPECTED_NODE" "$EXPECTED_NPM" <<'PY'
import json
import sys

doc = json.load(open(sys.argv[1], encoding="utf-8"))
assert doc["sha256"] == sys.argv[2]
assert doc["node"] == sys.argv[3]
assert doc["npm"] == sys.argv[4]
PY
test -f "$CS_PACK_STATE"
test ! -L "$CS_PACK_STATE"
printf '%s\n' "$DURABLE" > "$CS_PACK_STATE"
test -s "$CS_PACK_STATE"
printf '%s\n' "DURABLE=$DURABLE" "PROVENANCE=$PROVENANCE"
cd "$PACK_REPO"
git worktree remove --force "$PACK_SRC"
rmdir "$PACK_SRC_ROOT"
trap - EXIT
)
```

`set -euo pipefail` makes a failed `HEAD`, cleanliness, SHA-256, or
runtime-version `test` stop the block before `cp`, install, or provenance
write. Observed `node -v` / `npm -v` must equal `v22.22.2` / `10.9.7`
before writing `$PROVENANCE`; do not record a different runtime as those
values. After the verified copy, write `$PROVENANCE` for that same
SHA-256 so the documented provenance path exists and cannot lag an older
record. Copy or install only after those checks pass. A unique
`mktemp -d` pack dest does not follow `/tmp/goal-gen-pack-6ac355f`.
`test ! -e "$PACKED"` / `test ! -L "$PACKED"` stop before `npm pack`
replaces a pre-seeded packed-name symlink. A unique missing `$PACK_SRC`
under `mktemp -d` does not collide with
`/tmp/goal-gen-pack-src-6ac355f`; `git worktree remove` drops it after
provenance. An isolated `EXIT` trap at the start of the pack subshell,
before Node/npm checks and dest allocations, unregisters `$PACK_SRC`
when a later `set -e` test fails, keeps the primary status, and reports
cleanup failure without blanket prune/reset/clean. A version mismatch or
a failed `git worktree add` also removes `$CS_PACK_STATE` and any
allocated `$PACK_SRC_ROOT`, `$PACK_DEST`, and `$ARTIFACT_ROOT`. After a
later Pack failure, `$PACK_SRC_ROOT` is removed only after
`git worktree remove` unregisters `$PACK_SRC`. If unregister fails, keep
that directory and surface the cleanup failure. A successful Pack leaves
`$CS_PACK_STATE` for Install.
`test ! -L "$DURABLE"` plus `mv -T` of a regular temp file does not
follow a durable symlink. `test ! -L "$PROVENANCE"` plus `mv -T` of a
regular temp file does not follow a provenance symlink. A
`fail_if_symlink_dir_or_ancestor` walk plus an operator-owned
`mktemp -d` artifact root refuse a symlink dest or ancestor before
publish. Do not `mkdir -p` through `/opt/cursor/artifacts`. The
parent-created `$CS_PACK_STATE` is how Install sees `$DURABLE`
after the isolated subshell returns.

## Install (scratch consumer; not this checkout)

Do not `mkdir -p /tmp/cs-consumer`. That reuses a pre-existing project:
`npm init -y` keeps stale scripts/deps, and a symlink redirects the
install. Create a new directory with `mktemp -d`, or fail unless the
path is absent (`test ! -e` / `test ! -L` / `mkdir`, not `mkdir -p`).

<!-- recipe:install -->
```bash
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
EXPECTED_SHA=28dcde91b5d6505f6c798ae919c93a6991bce7c7c1ad52ddc4f330f8340446dd
# After pack, DURABLE is unset in this parent. Read the parent-created
# state file. When skipping pack, point DURABLE at a regular file
# whose digest is EXPECTED_SHA. Fail closed if the state file is
# missing, empty, or a symlink. Do not mkdir -p. Do not publish
# through /opt/cursor/artifacts.
if [ -z "${DURABLE:-}" ]; then
  test -n "${CS_PACK_STATE:-}"
  test -f "$CS_PACK_STATE"
  test ! -L "$CS_PACK_STATE"
  IFS= read -r DURABLE < "$CS_PACK_STATE"
  test -n "${DURABLE:-}"
fi
test -f "$DURABLE"
test "$(sha256sum "$DURABLE" | awk '{print $1}')" = "$EXPECTED_SHA"
CONSUMER="$(mktemp -d /tmp/cs-consumer.XXXXXX)"
test -d "$CONSUMER"
test ! -L "$CONSUMER"
cd "$CONSUMER"
npm init -y
npm install --no-audit --no-fund "$DURABLE"
BIN="$CONSUMER/node_modules/.bin/goal-gen"
"$BIN" version --json
```

Checksum immediately before `npm install`. `set -euo pipefail` stops
the block on a digest mismatch, so `npm install` does not run. Do not
install a tarball whose digest does not match. Drive the installed
`goal-gen` bin. Do not `npm run cli` from the product checkout for
these steps.

## Pack → Install state analog (CI; not recorded `6ac355f`)

The helper `scripts/operator-committed-source-paths.sh` executes these
fences. It clears inherited `$PACK_SRC`, `$PACK_REPO`, and
`$PACK_SRC_ROOT` before its `EXIT` trap, so a caller-exported checkout
is not `git worktree remove --force`d. Cleanup may unregister a
worktree only after this process creates one. They use the same
parent-created state file, isolated `EXIT` trap, and fail-closed
Install read as Pack/Install above. They do not `npm pack` recorded
`6ac355f`, do not `npm run runner`, and do not
`mkdir -p /opt/cursor/artifacts`.

<!-- recipe:pack-state-handshake -->
```bash
set -euo pipefail
CS_PACK_STATE="$(mktemp /tmp/cs-pack-state.XXXXXX)"
test -f "$CS_PACK_STATE"
test ! -L "$CS_PACK_STATE"
test ! -s "$CS_PACK_STATE"
PACK_SRC_ROOT="$(mktemp -d /tmp/goal-gen-pack-src.XXXXXX)"
PACK_SRC="$PACK_SRC_ROOT/src"
mkdir "$PACK_SRC"
test -d "$PACK_SRC"
test ! -L "$PACK_SRC"
(
set -euo pipefail
pack_src_cleanup() {
  rc=$?
  cleanup_rc=0
  rm -rf -- "$PACK_SRC" || cleanup_rc=$?
  rmdir "$PACK_SRC_ROOT" || true
  if [ "$cleanup_rc" -ne 0 ]; then
    echo "pack analog cleanup failed: $PACK_SRC" >&2
    if [ "$rc" -eq 0 ]; then
      return "$cleanup_rc"
    fi
  fi
  return "$rc"
}
trap pack_src_cleanup EXIT
ARTIFACT_ROOT="$(mktemp -d /tmp/goal-gen-artifacts.XXXXXX)"
test -d "$ARTIFACT_ROOT"
test ! -L "$ARTIFACT_ROOT"
DURABLE="$ARTIFACT_ROOT/goal-gen-0.2.0-analog.tgz"
: > "$DURABLE"
test -f "$DURABLE"
test ! -L "$DURABLE"
test -f "$CS_PACK_STATE"
test ! -L "$CS_PACK_STATE"
printf '%s\n' "$DURABLE" > "$CS_PACK_STATE"
test -s "$CS_PACK_STATE"
rm -rf -- "$PACK_SRC"
rmdir "$PACK_SRC_ROOT"
trap - EXIT
)
test -z "${DURABLE:-}"
if [ -z "${DURABLE:-}" ]; then
  test -n "${CS_PACK_STATE:-}"
  test -f "$CS_PACK_STATE"
  test ! -L "$CS_PACK_STATE"
  IFS= read -r DURABLE < "$CS_PACK_STATE"
  test -n "${DURABLE:-}"
fi
test -f "$DURABLE"
test ! -L "$DURABLE"
rm -f -- "$DURABLE"
rmdir "$(dirname "$DURABLE")" || true
rm -f -- "$CS_PACK_STATE"
```

<!-- recipe:pack-state-missing -->
```bash
set -euo pipefail
unset DURABLE
CS_PACK_STATE="$(mktemp /tmp/cs-pack-state.XXXXXX)"
rm -f -- "$CS_PACK_STATE"
if (
  set -euo pipefail
  if [ -z "${DURABLE:-}" ]; then
    test -n "${CS_PACK_STATE:-}"
    test -f "$CS_PACK_STATE"
    test ! -L "$CS_PACK_STATE"
    IFS= read -r DURABLE < "$CS_PACK_STATE"
    test -n "${DURABLE:-}"
  fi
  test -f "$DURABLE"
); then
  echo "missing pack state must fail closed" >&2
  exit 1
fi
```

<!-- recipe:pack-state-trap -->
```bash
set -euo pipefail
CS_PACK_STATE="$(mktemp /tmp/cs-pack-state.XXXXXX)"
PACK_SRC_ROOT="$(mktemp -d /tmp/goal-gen-pack-src.XXXXXX)"
PACK_SRC="$PACK_SRC_ROOT/src"
mkdir "$PACK_SRC"
set +e
(
  set -euo pipefail
  pack_src_cleanup() {
    rc=$?
    rm -rf -- "$PACK_SRC" || true
    rmdir "$PACK_SRC_ROOT" || true
    return "$rc"
  }
  trap pack_src_cleanup EXIT
  false
  printf '%s\n' "/should-not-write" > "$CS_PACK_STATE"
)
trap_rc=$?
set -e
test "$trap_rc" -ne 0
test ! -e "$PACK_SRC"
test ! -s "$CS_PACK_STATE"
rm -f -- "$CS_PACK_STATE"
rmdir "$PACK_SRC_ROOT" 2>/dev/null || true
```

<!-- recipe:pack-state-pretrap-node -->
```bash
set -euo pipefail
CS_PACK_STATE="$(mktemp /tmp/cs-pack-state.XXXXXX)"
test -f "$CS_PACK_STATE"
test ! -L "$CS_PACK_STATE"
set +e
(
  set -euo pipefail
  pack_src_cleanup() {
    rc=$?
    if [ "$rc" -ne 0 ] && [ -n "${CS_PACK_STATE:-}" ]; then
      rm -f -- "$CS_PACK_STATE" || true
    fi
    return "$rc"
  }
  trap pack_src_cleanup EXIT
  test "$(node -v 2>/dev/null || printf '%s\n' missing)" = "v0.0.0"
)
pretrap_rc=$?
set -e
test "$pretrap_rc" -ne 0
test ! -e "$CS_PACK_STATE"
```

<!-- recipe:pack-state-pretrap-alloc -->
```bash
set -euo pipefail
CS_PACK_STATE="$(mktemp /tmp/cs-pack-state.XXXXXX)"
PACK_SRC_ROOT="$(mktemp -d /tmp/goal-gen-pack-src.XXXXXX)"
PACK_SRC="$PACK_SRC_ROOT/src"
PACK_DEST="$(mktemp -d /tmp/goal-gen-pack.XXXXXX)"
ARTIFACT_ROOT="$(mktemp -d /tmp/goal-gen-artifacts.XXXXXX)"
PACK_REPO="$(git rev-parse --show-toplevel)"
test -f "$CS_PACK_STATE"
test -d "$PACK_SRC_ROOT"
test -d "$PACK_DEST"
test -d "$ARTIFACT_ROOT"
set +e
(
  set -euo pipefail
  pack_src_cleanup() {
    rc=$?
    if [ "$rc" -ne 0 ]; then
      if [ -n "${PACK_SRC_ROOT:-}" ]; then
        rm -rf -- "$PACK_SRC_ROOT" || true
      fi
      if [ -n "${PACK_DEST:-}" ]; then
        rm -rf -- "$PACK_DEST" || true
      fi
      if [ -n "${ARTIFACT_ROOT:-}" ]; then
        rm -rf -- "$ARTIFACT_ROOT" || true
      fi
      if [ -n "${CS_PACK_STATE:-}" ]; then
        rm -f -- "$CS_PACK_STATE" || true
      fi
    fi
    return "$rc"
  }
  trap pack_src_cleanup EXIT
  git -C "$PACK_REPO" worktree add "$PACK_SRC" "0000000000000000000000000000000000000000"
)
pretrap_rc=$?
set -e
test "$pretrap_rc" -ne 0
test ! -e "$CS_PACK_STATE"
test ! -e "$PACK_SRC_ROOT"
test ! -e "$PACK_DEST"
test ! -e "$ARTIFACT_ROOT"
```

<!-- recipe:pack-state-unregister-fail -->
```bash
set -euo pipefail
PACK_REPO="$(git rev-parse --show-toplevel)"
PACK_SRC_ROOT="$(mktemp -d /tmp/goal-gen-pack-src.XXXXXX)"
PACK_SRC="$PACK_SRC_ROOT/src"
CS_PACK_STATE="$(mktemp /tmp/cs-pack-state.XXXXXX)"
PACK_DEST="$(mktemp -d /tmp/goal-gen-pack.XXXXXX)"
ARTIFACT_ROOT="$(mktemp -d /tmp/goal-gen-artifacts.XXXXXX)"
REAL_GIT="$(command -v git)"
test -x "$REAL_GIT"
WRAP="$(mktemp -d /tmp/cs-git-wrap.XXXXXX)"
cat > "$WRAP/git" <<EOF
#!/bin/bash
case " \$* " in
  *" worktree remove "*)
    echo "wrapped git: refuse worktree remove" >&2
    exit 1
    ;;
esac
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$WRAP/git"
set +e
(
  set -euo pipefail
  pack_src_cleanup() {
    rc=$?
    cleanup_rc=0
    unregistered=0
    if [ -n "${PACK_REPO:-}" ] && [ -n "${PACK_SRC:-}" ] && [ -d "$PACK_SRC" ]; then
      if git -C "$PACK_REPO" worktree remove --force "$PACK_SRC"; then
        unregistered=1
      else
        cleanup_rc=$?
      fi
    else
      unregistered=1
    fi
    if [ "$unregistered" -eq 1 ] && [ -n "${PACK_SRC_ROOT:-}" ]; then
      if [ "$rc" -eq 0 ]; then
        rmdir "$PACK_SRC_ROOT" || true
      else
        rm -rf -- "$PACK_SRC_ROOT" || true
      fi
    fi
    if [ "$rc" -ne 0 ]; then
      if [ -n "${PACK_DEST:-}" ]; then
        rm -rf -- "$PACK_DEST" || true
      fi
      if [ -n "${ARTIFACT_ROOT:-}" ]; then
        rm -rf -- "$ARTIFACT_ROOT" || true
      fi
      if [ -n "${CS_PACK_STATE:-}" ]; then
        rm -f -- "$CS_PACK_STATE" || true
      fi
    fi
    if [ "$cleanup_rc" -ne 0 ]; then
      echo "pack worktree cleanup failed: $PACK_SRC" >&2
      if [ "$rc" -eq 0 ]; then
        return "$cleanup_rc"
      fi
    fi
    return "$rc"
  }
  "$REAL_GIT" -C "$PACK_REPO" worktree add "$PACK_SRC" HEAD
  trap pack_src_cleanup EXIT
  test -d "$PACK_SRC"
  export PATH="$WRAP:$PATH"
  false
)
unregister_rc=$?
set -e
test "$unregister_rc" -ne 0
test -d "$PACK_SRC"
test -d "$PACK_SRC_ROOT"
test ! -e "$CS_PACK_STATE"
test ! -e "$PACK_DEST"
test ! -e "$ARTIFACT_ROOT"
"$REAL_GIT" -C "$PACK_REPO" worktree remove --force "$PACK_SRC"
rmdir "$PACK_SRC_ROOT"
rm -rf -- "$WRAP"
```

<!-- recipe:pack-state-unregister-after-add -->
```bash
set -euo pipefail
PACK_REPO="$(git rev-parse --show-toplevel)"
PACK_SRC_ROOT="$(mktemp -d /tmp/goal-gen-pack-src.XXXXXX)"
PACK_SRC="$PACK_SRC_ROOT/src"
CS_PACK_STATE="$(mktemp /tmp/cs-pack-state.XXXXXX)"
PACK_DEST="$(mktemp -d /tmp/goal-gen-pack.XXXXXX)"
ARTIFACT_ROOT="$(mktemp -d /tmp/goal-gen-artifacts.XXXXXX)"
REAL_GIT="$(command -v git)"
test -x "$REAL_GIT"
set +e
(
  set -euo pipefail
  pack_src_cleanup() {
    rc=$?
    cleanup_rc=0
    unregistered=0
    if [ -n "${PACK_REPO:-}" ] && [ -n "${PACK_SRC:-}" ] && [ -d "$PACK_SRC" ]; then
      if git -C "$PACK_REPO" worktree remove --force "$PACK_SRC"; then
        unregistered=1
      else
        cleanup_rc=$?
      fi
    else
      unregistered=1
    fi
    if [ "$unregistered" -eq 1 ] && [ -n "${PACK_SRC_ROOT:-}" ]; then
      rm -rf -- "$PACK_SRC_ROOT" || true
    fi
    if [ "$rc" -ne 0 ]; then
      if [ -n "${PACK_DEST:-}" ]; then
        rm -rf -- "$PACK_DEST" || true
      fi
      if [ -n "${ARTIFACT_ROOT:-}" ]; then
        rm -rf -- "$ARTIFACT_ROOT" || true
      fi
      if [ -n "${CS_PACK_STATE:-}" ]; then
        rm -f -- "$CS_PACK_STATE" || true
      fi
    fi
    if [ "$cleanup_rc" -ne 0 ]; then
      echo "pack worktree cleanup failed: $PACK_SRC" >&2
    fi
    return "$rc"
  }
  "$REAL_GIT" -C "$PACK_REPO" worktree add "$PACK_SRC" HEAD
  trap pack_src_cleanup EXIT
  test -d "$PACK_SRC"
  test -d "$PACK_SRC/missing-child"
)
after_add_rc=$?
set -e
test "$after_add_rc" -ne 0
test ! -e "$PACK_SRC"
test ! -e "$PACK_SRC_ROOT"
test ! -e "$CS_PACK_STATE"
test ! -e "$PACK_DEST"
test ! -e "$ARTIFACT_ROOT"
if "$REAL_GIT" -C "$PACK_REPO" worktree list --porcelain | grep -Fqx "worktree $PACK_SRC"; then
  echo "leftover registered worktree: $PACK_SRC" >&2
  exit 1
fi
```

---

## Path A — disposable owned self-test

This invocation creates a uniquely named private fixture with
`mktemp -d /tmp/cs-owned-fixture.XXXXXX` and retains ownership. Do not
reuse `/tmp/cs-owned-fixture`. Canaries, tracked dirt, and wrapper tests
that plant dirt run only in this path. Take the capture baseline after
that intentional setup. Cleanup removes only this fixture and this
`$CS_SCRATCH`. Do not `rm -rf` an existing clone. Do not point `$REPO`
at a Path B checkout.

Never fetch. Never live `main` as a CI pin. `COMMIT` is this fixture's
full 40-hex HEAD. Dest paths below are missing (`new` does not exist);
persist creates parents and still writes `COMPLETE`. Allocate a unique
scratch root per run (`mktemp -d /tmp/cs-scratch.XXXXXX`). Reusing
`/tmp/cs-scratch` leaves `$MOVED` as an existing directory; GNU `mv`
then nests the new capture and `reproduce "$MOVED"` can read the old
`COMPLETE`. Write overlay candidates under `$CS_SCRATCH`, not
`/tmp/cs-extra.json` or `/tmp/cs-unauth.json`. Those predictable paths
can already exist as files or symlinks; `cat >` follows them. Capture
acceptance JSON under `$CS_SCRATCH` too; exit 0 does not mean
`accepted: true`.

Generation (`printf` into `goal-gen/package.json`, `package-lock.json`,
and `bin/goal-gen.mjs`, then `git add goal-gen` / `commit -qm fixture`)
is only for this newly created disposable repository. Pack-block
porcelain does not guard this block. `test ! -e "$REPO"` and
`mkdir "$REPO"` fail closed if the path already exists.

Do not set dest inside `$REPO`, `$REPO/.git`, or the common Git
directory. Those stay `USAGE_ERROR`.

### A.1 Create owned fixture and scratch

<!-- recipe:path-a-1 -->
```bash
set -euo pipefail
export REPO="$(mktemp -d /tmp/cs-owned-fixture.XXXXXX)"
export CS_SCRATCH="$(mktemp -d /tmp/cs-scratch.XXXXXX)"
export CAPTURE="$CS_SCRATCH/capture/new/evidence"
export MOVED="$CS_SCRATCH/capture-moved"
export OVERLAY="$CS_SCRATCH/overlay/new/evidence"
export UNAUTH="$CS_SCRATCH/unauth/new/evidence"
export EXTRA_CANDIDATE="$CS_SCRATCH/cs-extra.json"
export UNAUTH_CANDIDATE="$CS_SCRATCH/cs-unauth.json"

test -d "$REPO"
test ! -L "$REPO"
test -z "$(ls -A "$REPO")"
git -C "$REPO" init -q
mkdir -p "$REPO/goal-gen/bin"
printf '%s\n' '{' \
  '  "name": "goal-gen",' \
  '  "version": "0.2.0",' \
  '  "bin": {' \
  '    "goal-gen": "bin/goal-gen.mjs"' \
  '  }' \
  '}' > "$REPO/goal-gen/package.json"
printf '%s\n' '{' \
  '  "name": "goal-gen",' \
  '  "version": "0.2.0",' \
  '  "lockfileVersion": 3,' \
  '  "packages": {' \
  '    "": {' \
  '      "name": "goal-gen",' \
  '      "version": "0.2.0"' \
  '    }' \
  '  }' \
  '}' > "$REPO/goal-gen/package-lock.json"
printf '%s\n' '#!/usr/bin/env node' 'export {};' \
  > "$REPO/goal-gen/bin/goal-gen.mjs"
git -C "$REPO" add goal-gen
git -C "$REPO" -c user.email=op@example.test -c user.name=op \
  commit -qm fixture
export COMMIT="$(git -C "$REPO" rev-parse HEAD)"
test "${#COMMIT}" -eq 40
```

A later Path A fence can fail before A.5, and this block can fail
after the mktemps or before `commit`. The helper registers an
`EXIT` trap **before** those allocations so `$REPO` and
`$CS_SCRATCH` are removed when Path A or the Path B seed aborts.
Do not leave those fixtures. The Path B seed must not wait for
`$PATH_B_REPO` to be assigned.

<!-- recipe:path-a-pretrap-mktemp -->
```bash
set -euo pipefail
NAMES="$(mktemp /tmp/cs-patha-pretrap-names.XXXXXX)"
set +e
(
  set -euo pipefail
  REPO=""
  CS_SCRATCH=""
  path_a_cleanup() {
    rc=$?
    rm -rf -- "${REPO:-}"
    rm -rf -- "${CS_SCRATCH:-}"
    return "$rc"
  }
  trap path_a_cleanup EXIT
  export REPO="$(mktemp -d /tmp/cs-owned-fixture.XXXXXX)"
  export CS_SCRATCH="$(mktemp -d /tmp/cs-scratch.XXXXXX)"
  printf '%s\n' "$REPO" > "$NAMES"
  printf '%s\n' "$CS_SCRATCH" >> "$NAMES"
  false
)
pretrap_rc=$?
set -e
test "$pretrap_rc" -ne 0
while IFS= read -r p; do
  test -n "$p"
  test ! -e "$p"
done < "$NAMES"
rm -f -- "$NAMES"
```

<!-- recipe:path-a-pretrap-commit -->
```bash
set -euo pipefail
NAMES="$(mktemp /tmp/cs-patha-pretrap-names.XXXXXX)"
set +e
(
  set -euo pipefail
  REPO=""
  CS_SCRATCH=""
  path_a_cleanup() {
    rc=$?
    rm -rf -- "${REPO:-}"
    rm -rf -- "${CS_SCRATCH:-}"
    return "$rc"
  }
  trap path_a_cleanup EXIT
  export REPO="$(mktemp -d /tmp/cs-owned-fixture.XXXXXX)"
  export CS_SCRATCH="$(mktemp -d /tmp/cs-scratch.XXXXXX)"
  printf '%s\n' "$REPO" > "$NAMES"
  printf '%s\n' "$CS_SCRATCH" >> "$NAMES"
  git -C "$REPO" init -q
  mkdir -p "$REPO/goal-gen"
  printf '%s\n' '{"name":"goal-gen"}' > "$REPO/goal-gen/package.json"
  git -C "$REPO" add goal-gen
  git -C "$REPO" false
)
pretrap_rc=$?
set -e
test "$pretrap_rc" -ne 0
while IFS= read -r p; do
  test -n "$p"
  test ! -e "$p"
done < "$NAMES"
rm -f -- "$NAMES"
```

<!-- recipe:path-b-seed-pretrap-mktemp -->
```bash
set -euo pipefail
NAMES="$(mktemp /tmp/cs-pathb-seed-pretrap-names.XXXXXX)"
PATH_B_REPO=""
set +e
PATH_B_REPO="$(
  set -euo pipefail
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
  export REPO="$(mktemp -d /tmp/cs-owned-fixture.XXXXXX)"
  export CS_SCRATCH="$(mktemp -d /tmp/cs-scratch.XXXXXX)"
  printf '%s\n' "$REPO" > "$NAMES"
  printf '%s\n' "$CS_SCRATCH" >> "$NAMES"
  false
)"
pretrap_rc=$?
set -e
test "$pretrap_rc" -ne 0
test -z "${PATH_B_REPO:-}"
while IFS= read -r p; do
  test -n "$p"
  test ! -e "$p"
done < "$NAMES"
rm -f -- "$NAMES"
```

<!-- recipe:path-b-seed-pretrap-commit -->
```bash
set -euo pipefail
NAMES="$(mktemp /tmp/cs-pathb-seed-pretrap-names.XXXXXX)"
PATH_B_REPO=""
set +e
PATH_B_REPO="$(
  set -euo pipefail
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
  export REPO="$(mktemp -d /tmp/cs-owned-fixture.XXXXXX)"
  export CS_SCRATCH="$(mktemp -d /tmp/cs-scratch.XXXXXX)"
  printf '%s\n' "$REPO" > "$NAMES"
  printf '%s\n' "$CS_SCRATCH" >> "$NAMES"
  git -C "$REPO" init -q
  mkdir -p "$REPO/goal-gen"
  printf '%s\n' '{"name":"goal-gen"}' > "$REPO/goal-gen/package.json"
  git -C "$REPO" add goal-gen
  git -C "$REPO" false
)"
pretrap_rc=$?
set -e
test "$pretrap_rc" -ne 0
test -z "${PATH_B_REPO:-}"
while IFS= read -r p; do
  test -n "$p"
  test ! -e "$p"
done < "$NAMES"
rm -f -- "$NAMES"
```

### A.1b Failure cleanup (dest inside `$REPO`)

Dest inside the live captured source is `USAGE_ERROR`. Current trunk
`$BIN` (dest-mkdir leftover rollback from `#44`) must leave no created
intermediates under `$REPO`. Do not advertise leftover-absent on the
recorded `6ac355f` BIN.

<!-- recipe:path-a-fail -->
```bash
set -euo pipefail
FAIL_DEST="$REPO/new/evidence"
test ! -e "$REPO/new"
set +e
"$BIN" acceptance capture-source package-manifest-lockfile \
  "$REPO" "$COMMIT" --json --bundle-dir "$FAIL_DEST" \
  > "$CS_SCRATCH/fail-inside.json" 2>"$CS_SCRATCH/fail-inside.err"
fail_code=$?
set -e
test "$fail_code" -eq 2
test ! -s "$CS_SCRATCH/fail-inside.json"
jq -e '.error.code == "USAGE_ERROR"' \
  < <(tail -n 1 "$CS_SCRATCH/fail-inside.err") >/dev/null
test ! -e "$FAIL_DEST"
test ! -e "$REPO/new"
test ! -e "$REPO/evidence"
```

### A.2 Plant canaries, then capture

HEAD/index snapshots and dirty/untracked canaries belong only here. The
dirty selected-file canary must change the worktree digest versus the
committed blob; trailing JSON whitespace is not enough.

<!-- recipe:path-a-2 -->
```bash
set -euo pipefail
BEFORE_HEAD="$(git -C "$REPO" rev-parse HEAD)"
INDEX_FILE="$(git -C "$REPO" rev-parse --absolute-git-dir)/index"
test -f "$INDEX_FILE"
BEFORE_INDEX="$(sha256sum "$INDEX_FILE" | awk '{print $1}')"
DIRTY_CANARY="$REPO/goal-gen/package.json"
UNTRACKED_CANARY="$REPO/CANARY_UNTRACKED.txt"
test -f "$DIRTY_CANARY"
test ! -e "$UNTRACKED_CANARY"
COMMITTED_DIGEST="$(git -C "$REPO" show "$COMMIT:goal-gen/package.json" | sha256sum | awk '{print $1}')"
COMMITTED_GITSHA="$(git -C "$REPO" rev-parse "$COMMIT:goal-gen/package.json")"
printf '%s\n' '{' \
  '  "name": "goal-gen",' \
  '  "version": "9.9.9",' \
  '  "bin": {' \
  '    "goal-gen": "bin/goal-gen.mjs"' \
  '  }' \
  '}' > "$DIRTY_CANARY"
printf 'untracked-canary\n' > "$UNTRACKED_CANARY"
BEFORE_DIRTY="$(sha256sum "$DIRTY_CANARY" | awk '{print $1}')"
BEFORE_UNTRACKED="$(sha256sum "$UNTRACKED_CANARY" | awk '{print $1}')"
test "$BEFORE_DIRTY" != "$COMMITTED_DIGEST"
"$BIN" acceptance capture-source package-manifest-lockfile \
  "$REPO" "$COMMIT" --json --bundle-dir "$CAPTURE" \
  > "$CS_SCRATCH/capture.json"
jq -e '.decision.accepted == true' "$CS_SCRATCH/capture.json" >/dev/null
jq -e '.decision.reasons == ["all required checks observed passed for captured source"]' \
  "$CS_SCRATCH/capture.json" >/dev/null
jq -e '.schemaVersion == "yellow-goal/committed-source-capture/v1"' \
  "$CS_SCRATCH/capture.json" >/dev/null
jq -e --arg sha "$COMMITTED_DIGEST" \
  '.source.captured[] | select(.path == "goal-gen/package.json") | .sha256 == $sha' \
  "$CS_SCRATCH/capture.json" >/dev/null
jq -e --arg gitsha "$COMMITTED_GITSHA" \
  '.source.captured[] | select(.path == "goal-gen/package.json") | .gitSha == $gitsha' \
  "$CS_SCRATCH/capture.json" >/dev/null
test "$(sha256sum "$CAPTURE/blobs/goal-gen/package.json" | awk '{print $1}')" = "$COMMITTED_DIGEST"
test "$(sha256sum "$CAPTURE/blobs/goal-gen/package.json" | awk '{print $1}')" != "$BEFORE_DIRTY"
cmp -s <(git -C "$REPO" show "$COMMIT:goal-gen/package.json") \
  "$CAPTURE/blobs/goal-gen/package.json"
test "$(git -C "$REPO" rev-parse HEAD)" = "$BEFORE_HEAD"
test "$(sha256sum "$INDEX_FILE" | awk '{print $1}')" = "$BEFORE_INDEX"
test "$(sha256sum "$DIRTY_CANARY" | awk '{print $1}')" = "$BEFORE_DIRTY"
test "$(sha256sum "$UNTRACKED_CANARY" | awk '{print $1}')" = "$BEFORE_UNTRACKED"
test -f "$UNTRACKED_CANARY"
```

Expect `accepted: true` with that captured-source reason, schema
`yellow-goal/committed-source-capture/v1`, and `COMPLETE` at
`$CAPTURE/COMPLETE` even though `$CAPTURE` and parent `new` were missing.
The dirty canary is a version bump to `9.9.9`, so a live-worktree read
would capture a different digest than the committed `0.2.0` blob. The
bundle blob and `.source.captured` sha256/gitSha must match
`git show "$COMMIT:goal-gen/package.json"`, not the dirty bytes. Source
HEAD, index, dirty canary, and untracked canary must match the before
hashes. Exit 0 alone does not establish acceptance.

### A.3 Reproduce (moved bundle)

Require `$MOVED` not to exist. GNU `mv SOURCE DIRECTORY` nests when
the destination already exists, and `reproduce "$MOVED"` then reads the
old top-level `COMPLETE`. `mv -T` refuses that directory form.

<!-- recipe:path-a-3 -->
```bash
set -euo pipefail
test ! -e "$MOVED"
test ! -L "$MOVED"
mv -T "$CAPTURE" "$MOVED"
"$BIN" acceptance reproduce "$MOVED" --json \
  > "$CS_SCRATCH/moved-reproduce.json"
jq -e '.decision.accepted == true' "$CS_SCRATCH/moved-reproduce.json" >/dev/null
jq -e '.decision.reasons == ["all required checks observed passed for captured source"]' \
  "$CS_SCRATCH/moved-reproduce.json" >/dev/null
```

Expect `accepted: true` with that captured-source reason for an honest
capture. Dispatch is by `COMPLETE` schema. Exit 0 alone does not
establish acceptance.

### A.4 Overlay (`--from-capture`)

Candidate is `yellow-goal/candidate-file-content/v1`. Overlay dest may be
missing (created) or empty, not the source. Dest inside the live captured
source stays `USAGE_ERROR`. Honest missing-parent dest outside source
still persist `COMPLETE`. Dest-mkdir leftover rollback of created
intermediates landed as `#44` on `main` `3d65827`. The recorded
`6ac355f` BIN (`28dcde91…`) this runbook installs as `$BIN` does not
include that rollback. Do not pack `3d65827` as `28dcde91`.

Authorized extra-field alternative (allowlisted `goal-gen/package.json`).
Write under `$CS_SCRATCH`. Do not `cat > /tmp/cs-extra.json`: that
follows a pre-seeded symlink and can be replaced before
`verify-candidate`.

<!-- recipe:path-a-4-extra -->
```bash
set -euo pipefail
test ! -e "$EXTRA_CANDIDATE"
test ! -L "$EXTRA_CANDIDATE"
cat > "$EXTRA_CANDIDATE" <<'EOF'
{"schemaVersion":"yellow-goal/candidate-file-content/v1","files":{"goal-gen/package.json":"{\n  \"name\": \"goal-gen\",\n  \"version\": \"0.2.0\",\n  \"bin\": {\n    \"goal-gen\": \"bin/goal-gen.mjs\"\n  },\n  \"description\": \"captured-base extra-field alternative\"\n}\n"}}
EOF

"$BIN" acceptance verify-candidate package-manifest-lockfile \
  "$EXTRA_CANDIDATE" --from-capture "$MOVED" --json --bundle-dir "$OVERLAY" \
  > "$CS_SCRATCH/extra-overlay.json"
jq -e '.decision.accepted == true' "$CS_SCRATCH/extra-overlay.json" >/dev/null
jq -e '.decision.reasons == ["all required checks observed passed for captured source"]' \
  "$CS_SCRATCH/extra-overlay.json" >/dev/null
"$BIN" acceptance reproduce "$OVERLAY" --json \
  > "$CS_SCRATCH/extra-reproduce.json"
jq -e '.decision.accepted == true' "$CS_SCRATCH/extra-reproduce.json" >/dev/null
jq -e '.decision.reasons == ["all required checks observed passed for captured source"]' \
  "$CS_SCRATCH/extra-reproduce.json" >/dev/null
```

Unauthorized extra.txt stays `unauthorized-path` (CS-13 is not weakened).
That reject still exits 0. Assert `accepted: false` and the reason;
`jq -e '.decision.accepted == true'` here exits 1.

<!-- recipe:path-a-4-unauth -->
```bash
set -euo pipefail
test ! -e "$UNAUTH_CANDIDATE"
test ! -L "$UNAUTH_CANDIDATE"
cat > "$UNAUTH_CANDIDATE" <<'EOF'
{"schemaVersion":"yellow-goal/candidate-file-content/v1","files":{"goal-gen/extra.txt":"unauthorized\n"}}
EOF

"$BIN" acceptance verify-candidate package-manifest-lockfile \
  "$UNAUTH_CANDIDATE" --from-capture "$MOVED" --json --bundle-dir "$UNAUTH" \
  > "$CS_SCRATCH/unauth-overlay.json"
jq -e '.decision.accepted == false' "$CS_SCRATCH/unauth-overlay.json" >/dev/null
jq -e '.decision.reasons == ["unauthorized-path:goal-gen/extra.txt"]' \
  "$CS_SCRATCH/unauth-overlay.json" >/dev/null
"$BIN" acceptance reproduce "$UNAUTH" --json \
  > "$CS_SCRATCH/unauth-reproduce.json"
jq -e '.decision.accepted == false' "$CS_SCRATCH/unauth-reproduce.json" >/dev/null
jq -e '.decision.reasons == ["unauthorized-path:goal-gen/extra.txt"]' \
  "$CS_SCRATCH/unauth-reproduce.json" >/dev/null
```

### A.5 Cleanup owned resources only

Remove only the fixture and scratch this invocation created. Do not
`git worktree prune`, `git reset --hard`, `git clean`, or `rm -rf` a
Path B clone.

<!-- recipe:path-a-5 -->
```bash
rm -rf -- "$REPO"
rm -rf -- "$CS_SCRATCH"
```

---

## Path B — existing local clone (read-only)

Use an already-present clone at a pinned commit. Do not generate a
fixture. Do not `printf` into it, `git add`, or `commit`. Capture reads
the pinned object; uncommitted work stays in the worktree and is not
assessed.

Do not plant `CANARY_UNTRACKED.txt`. Do not rewrite
`goal-gen/package.json`. Do not append, touch, chmod, stash, reset,
checkout, clean, fetch, refresh the index, or restore-after-modify. If
`CANARY_UNTRACKED.txt` or a dirty `package.json` already exists, that
is user content — leave it.

Do not require a canary file to exist. Capture still assesses the
pinned commit, not dirty, staged, or untracked bytes. Do not hash
those bytes as a capture contract.

Do not run `git status`, `git diff`, `git diff-files`, or
`git diff-index` on this clone. Those commands invoke
repository-configured programs (`filter.*.clean`, `core.fsmonitor`)
and are not a read-only observation. `GIT_OPTIONAL_LOCKS=0` does not
make `git status` safe. Observe HEAD with
`GIT_OPTIONAL_LOCKS=0 git rev-parse`. If the on-disk index file
already exists, sha256 that file from outside git (do not use git
plumbing to hash it). If the index is absent, record `absent` and do
not create or refresh it. A symlink or non-regular index fails closed.
Do not refresh or rewrite the index.

Record a `find` manifest of regular files, symlinks, and directories
under `$REPO` excluding `.git`: entry type, relevant mode, symlink
target, regular-file mtime, and SHA-256 of regular-file bytes. Later
Path B recipes fail if those records change (rewritten file, added
or removed file, retargeted or added symlink, chmod, added or
removed directory, or `touch`). That gate is not `git status` /
`git diff` / `git diff-files` / `git diff-index` and does not
refresh the index.

Allocate `$CS_SCRATCH` first (external). Record HEAD, the index-file
record, and the worktree manifest there **before** any later dest
mkdir that could be mistaken for source setup. Those observations
are not source writes. Pack worktree registration against this
`$REPO` is not allowed.

Never fetch. `COMMIT` is this clone's full 40-hex HEAD, not landed
`6ac355f` unless that object is already `HEAD` here. Dest paths below
are missing (`new` does not exist) and live only under `$CS_SCRATCH`.
Missing `$REPO`, a non-worktree `$REPO`, or a short `COMMIT` fail
closed. Write overlay candidates under `$CS_SCRATCH`, not
`/tmp/cs-extra.json`. Capture JSON under `$CS_SCRATCH`. Exit 0 does
not mean `accepted: true`.

Do not set dest inside `$REPO`, `$REPO/.git`, or the common Git
directory. Those stay `USAGE_ERROR`.

### B.1 Observe, then pin (no source writes)

<!-- recipe:path-b-1 -->
```bash
set -euo pipefail
test -n "${REPO:-}"
export CS_SCRATCH="$(mktemp -d /tmp/cs-scratch.XXXXXX)"
export CAPTURE="$CS_SCRATCH/capture/new/evidence"
export MOVED="$CS_SCRATCH/capture-moved"
export OVERLAY="$CS_SCRATCH/overlay/new/evidence"
export UNAUTH="$CS_SCRATCH/unauth/new/evidence"
export EXTRA_CANDIDATE="$CS_SCRATCH/cs-extra.json"
export UNAUTH_CANDIDATE="$CS_SCRATCH/cs-unauth.json"

path_b_index_record() {
  gitdir="$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse --absolute-git-dir)"
  index_file="$gitdir/index"
  if [ -L "$index_file" ]; then
    echo "symlink index: $index_file" >&2
    return 1
  fi
  if [ -e "$index_file" ]; then
    if [ ! -f "$index_file" ]; then
      echo "non-regular index: $index_file" >&2
      return 1
    fi
    sha256sum "$index_file" | awk '{print $1}'
  else
    printf 'absent\n'
  fi
}

path_b_worktree_manifest() {
  test -n "${REPO:-}"
  test -d "$REPO"
  (
    cd "$REPO" || exit 1
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

path_b_worktree_unchanged() {
  path_b_worktree_manifest > "$CS_SCRATCH/after-worktree.txt"
  cmp -s "$CS_SCRATCH/before-worktree.txt" "$CS_SCRATCH/after-worktree.txt"
}

test -d "$REPO"
test ! -L "$REPO"
GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null
export COMMIT="$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse HEAD)"
test "${#COMMIT}" -eq 40
printf '%s\n' "$COMMIT" > "$CS_SCRATCH/before-head.txt"
path_b_index_record > "$CS_SCRATCH/before-index.txt"
path_b_worktree_manifest > "$CS_SCRATCH/before-worktree.txt"
```

`$REPO=/tmp/cs-existing-clone` is an example path. Export the real
clone before this block (`test -n "${REPO:-}"`). `test -d` /
`test ! -L` / `rev-parse` fail closed when the input is missing or
not a worktree. This block does not create `$REPO` and does not
require `CANARY_UNTRACKED.txt`. Keep `path_b_index_record`,
`path_b_worktree_manifest`, and `path_b_worktree_unchanged` in this
shell for B.2–B.4. HEAD is `GIT_OPTIONAL_LOCKS=0 git rev-parse`. The
index record is a sha256 of the already-present on-disk file, or
`absent`; this block does not create or refresh that file. The
worktree manifest is `find` type, mode, directory, symlink target,
and regular-file mtime plus SHA-256 of regular files, excluding
`.git`.

### B.1b Failure cleanup (dest inside existing clone)

Dest inside the live captured source is `USAGE_ERROR`. Do not plant
canaries. HEAD, the index-file record, and the worktree manifest must
match B.1.

<!-- recipe:path-b-fail -->
```bash
set -euo pipefail
FAIL_DEST="$REPO/new/evidence"
test ! -e "$REPO/new"
set +e
"$BIN" acceptance capture-source package-manifest-lockfile \
  "$REPO" "$COMMIT" --json --bundle-dir "$FAIL_DEST" \
  > "$CS_SCRATCH/fail-inside.json" 2>"$CS_SCRATCH/fail-inside.err"
fail_code=$?
set -e
test "$fail_code" -eq 2
test ! -s "$CS_SCRATCH/fail-inside.json"
jq -e '.error.code == "USAGE_ERROR"' \
  < <(tail -n 1 "$CS_SCRATCH/fail-inside.err") >/dev/null
test ! -e "$FAIL_DEST"
test ! -e "$REPO/new"
test ! -e "$REPO/evidence"
test "$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse HEAD)" = "$(cat "$CS_SCRATCH/before-head.txt")"
test "$(path_b_index_record)" = "$(cat "$CS_SCRATCH/before-index.txt")"
path_b_worktree_unchanged
```

### B.2 Capture to an external dest

<!-- recipe:path-b-2 -->
```bash
set -euo pipefail
BEFORE_HEAD="$(cat "$CS_SCRATCH/before-head.txt")"
BEFORE_INDEX="$(cat "$CS_SCRATCH/before-index.txt")"
test "$BEFORE_HEAD" = "$COMMIT"
"$BIN" acceptance capture-source package-manifest-lockfile \
  "$REPO" "$COMMIT" --json --bundle-dir "$CAPTURE" \
  > "$CS_SCRATCH/capture.json"
jq -e '.decision.accepted == true' "$CS_SCRATCH/capture.json" >/dev/null
jq -e '.decision.reasons == ["all required checks observed passed for captured source"]' \
  "$CS_SCRATCH/capture.json" >/dev/null
jq -e '.schemaVersion == "yellow-goal/committed-source-capture/v1"' \
  "$CS_SCRATCH/capture.json" >/dev/null
test "$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse HEAD)" = "$BEFORE_HEAD"
test "$(path_b_index_record)" = "$BEFORE_INDEX"
path_b_worktree_unchanged
```

Expect the same accepted JSON and `COMPLETE`. Capture assesses the
pinned commit, not dirty/staged/untracked worktree bytes. Those
bytes are not a capture contract. HEAD, the index-file record, and
the worktree manifest must match B.1. This block does not create
`CANARY_UNTRACKED.txt` or rewrite `goal-gen/package.json`.

### B.3 Reproduce (moved bundle)

Require `$MOVED` not to exist. `mv -T` refuses the directory form that
would nest into a pre-existing dest. `$MOVED` is under `$CS_SCRATCH`,
not under `$REPO`.

<!-- recipe:path-b-3 -->
```bash
set -euo pipefail
test ! -e "$MOVED"
test ! -L "$MOVED"
mv -T "$CAPTURE" "$MOVED"
"$BIN" acceptance reproduce "$MOVED" --json \
  > "$CS_SCRATCH/moved-reproduce.json"
jq -e '.decision.accepted == true' "$CS_SCRATCH/moved-reproduce.json" >/dev/null
jq -e '.decision.reasons == ["all required checks observed passed for captured source"]' \
  "$CS_SCRATCH/moved-reproduce.json" >/dev/null
test "$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse HEAD)" = "$(cat "$CS_SCRATCH/before-head.txt")"
test "$(path_b_index_record)" = "$(cat "$CS_SCRATCH/before-index.txt")"
path_b_worktree_unchanged
```

### B.4 Overlay (`--from-capture`)

Overlay dests and candidates stay under `$CS_SCRATCH`. Do not write
candidates into `$REPO`. Dest-mkdir leftover rollback of created
intermediates landed as `#44` `3d65827` (ancestor of `origin/main`
`f9974a86`). The recorded `6ac355f` BIN (`28dcde91…`) does not
include that rollback. Do not pack `3d65827` or `f9974a86` as
`28dcde91`.

<!-- recipe:path-b-4-extra -->
```bash
set -euo pipefail
test ! -e "$EXTRA_CANDIDATE"
test ! -L "$EXTRA_CANDIDATE"
cat > "$EXTRA_CANDIDATE" <<'EOF'
{"schemaVersion":"yellow-goal/candidate-file-content/v1","files":{"goal-gen/package.json":"{\n  \"name\": \"goal-gen\",\n  \"version\": \"0.2.0\",\n  \"bin\": {\n    \"goal-gen\": \"bin/goal-gen.mjs\"\n  },\n  \"description\": \"captured-base extra-field alternative\"\n}\n"}}
EOF

"$BIN" acceptance verify-candidate package-manifest-lockfile \
  "$EXTRA_CANDIDATE" --from-capture "$MOVED" --json --bundle-dir "$OVERLAY" \
  > "$CS_SCRATCH/extra-overlay.json"
jq -e '.decision.accepted == true' "$CS_SCRATCH/extra-overlay.json" >/dev/null
jq -e '.decision.reasons == ["all required checks observed passed for captured source"]' \
  "$CS_SCRATCH/extra-overlay.json" >/dev/null
"$BIN" acceptance reproduce "$OVERLAY" --json \
  > "$CS_SCRATCH/extra-reproduce.json"
jq -e '.decision.accepted == true' "$CS_SCRATCH/extra-reproduce.json" >/dev/null
jq -e '.decision.reasons == ["all required checks observed passed for captured source"]' \
  "$CS_SCRATCH/extra-reproduce.json" >/dev/null
test "$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse HEAD)" = "$(cat "$CS_SCRATCH/before-head.txt")"
test "$(path_b_index_record)" = "$(cat "$CS_SCRATCH/before-index.txt")"
path_b_worktree_unchanged
```

Unauthorized extra.txt stays `unauthorized-path` (CS-13 is not weakened).
That reject still exits 0. Assert `accepted: false` and the reason;
`jq -e '.decision.accepted == true'` here exits 1.

<!-- recipe:path-b-4-unauth -->
```bash
set -euo pipefail
test ! -e "$UNAUTH_CANDIDATE"
test ! -L "$UNAUTH_CANDIDATE"
cat > "$UNAUTH_CANDIDATE" <<'EOF'
{"schemaVersion":"yellow-goal/candidate-file-content/v1","files":{"goal-gen/extra.txt":"unauthorized\n"}}
EOF

"$BIN" acceptance verify-candidate package-manifest-lockfile \
  "$UNAUTH_CANDIDATE" --from-capture "$MOVED" --json --bundle-dir "$UNAUTH" \
  > "$CS_SCRATCH/unauth-overlay.json"
jq -e '.decision.accepted == false' "$CS_SCRATCH/unauth-overlay.json" >/dev/null
jq -e '.decision.reasons == ["unauthorized-path:goal-gen/extra.txt"]' \
  "$CS_SCRATCH/unauth-overlay.json" >/dev/null
"$BIN" acceptance reproduce "$UNAUTH" --json \
  > "$CS_SCRATCH/unauth-reproduce.json"
jq -e '.decision.accepted == false' "$CS_SCRATCH/unauth-reproduce.json" >/dev/null
jq -e '.decision.reasons == ["unauthorized-path:goal-gen/extra.txt"]' \
  "$CS_SCRATCH/unauth-reproduce.json" >/dev/null
test "$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse HEAD)" = "$(cat "$CS_SCRATCH/before-head.txt")"
test "$(path_b_index_record)" = "$(cat "$CS_SCRATCH/before-index.txt")"
path_b_worktree_unchanged
```

Path B cleanup removes only this invocation's `$CS_SCRATCH`. Do not
delete, reset, clean, or restore `$REPO`.

<!-- recipe:path-b-5 -->
```bash
rm -rf -- "$CS_SCRATCH"
```

<!-- recipe:path-b-bytes-fail -->
```bash
set -euo pipefail
REPO="$(mktemp -d /tmp/cs-pathb-bytes.XXXXXX)"
git -C "$REPO" init -q
git -C "$REPO" config user.email analog@example.com
git -C "$REPO" config user.name analog
mkdir -p "$REPO/goal-gen"
printf '%s\n' '{"name":"goal-gen"}' > "$REPO/goal-gen/package.json"
git -C "$REPO" add goal-gen/package.json
git -C "$REPO" commit -q -m init
printf 'preexist\n' > "$REPO/PREEXIST_UNTRACKED.txt"
CS_SCRATCH="$(mktemp -d /tmp/cs-scratch.XXXXXX)"
path_b_worktree_manifest() {
  test -n "${REPO:-}"
  test -d "$REPO"
  (
    cd "$REPO" || exit 1
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
BEFORE_HEAD="$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse HEAD)"
gitdir="$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse --absolute-git-dir)"
index_file="$gitdir/index"
test -f "$index_file"
test ! -L "$index_file"
BEFORE_INDEX="$(sha256sum "$index_file" | awk '{print $1}')"
path_b_worktree_manifest > "$CS_SCRATCH/before-worktree.txt"
printf '\nrewritten\n' >> "$REPO/goal-gen/package.json"
printf 'new\n' > "$REPO/NEW_UNTRACKED.txt"
rm -f -- "$REPO/PREEXIST_UNTRACKED.txt"
test "$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse HEAD)" = "$BEFORE_HEAD"
test "$(sha256sum "$index_file" | awk '{print $1}')" = "$BEFORE_INDEX"
path_b_worktree_manifest > "$CS_SCRATCH/after-worktree.txt"
set +e
cmp -s "$CS_SCRATCH/before-worktree.txt" "$CS_SCRATCH/after-worktree.txt"
cmp_rc=$?
set -e
test "$cmp_rc" -ne 0
rm -rf -- "$REPO"
rm -rf -- "$CS_SCRATCH"
```

<!-- recipe:path-b-symlink-mode-fail -->
```bash
set -euo pipefail
path_b_worktree_manifest() {
  test -n "${REPO:-}"
  test -d "$REPO"
  (
    cd "$REPO" || exit 1
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
seed_symlink_mode_repo() {
  REPO="$(mktemp -d /tmp/cs-pathb-symlink.XXXXXX)"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email analog@example.com
  git -C "$REPO" config user.name analog
  mkdir -p "$REPO/goal-gen"
  printf '%s\n' '{"name":"goal-gen"}' > "$REPO/goal-gen/package.json"
  printf '%s\n' '{"lockfileVersion":3}' > "$REPO/goal-gen/package-lock.json"
  chmod 644 "$REPO/goal-gen/package.json"
  git -C "$REPO" add goal-gen/package.json goal-gen/package-lock.json
  git -C "$REPO" commit -q -m init
  ln -s goal-gen/package.json "$REPO/PREEXIST_LINK"
  CS_SCRATCH="$(mktemp -d /tmp/cs-scratch.XXXXXX)"
  BEFORE_HEAD="$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse HEAD)"
  gitdir="$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse --absolute-git-dir)"
  index_file="$gitdir/index"
  test -f "$index_file"
  test ! -L "$index_file"
  BEFORE_INDEX="$(sha256sum "$index_file" | awk '{print $1}')"
  path_b_worktree_manifest > "$CS_SCRATCH/before-worktree.txt"
}
assert_head_index_same_manifest_changed() {
  test "$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse HEAD)" = "$BEFORE_HEAD"
  test "$(sha256sum "$index_file" | awk '{print $1}')" = "$BEFORE_INDEX"
  path_b_worktree_manifest > "$CS_SCRATCH/after-worktree.txt"
  set +e
  cmp -s "$CS_SCRATCH/before-worktree.txt" "$CS_SCRATCH/after-worktree.txt"
  cmp_rc=$?
  set -e
  test "$cmp_rc" -ne 0
  rm -rf -- "$REPO"
  rm -rf -- "$CS_SCRATCH"
}
seed_symlink_mode_repo
ln -sfn goal-gen/package-lock.json "$REPO/PREEXIST_LINK"
assert_head_index_same_manifest_changed
seed_symlink_mode_repo
ln -s goal-gen/package.json "$REPO/NEW_SYMLINK"
assert_head_index_same_manifest_changed
seed_symlink_mode_repo
chmod 755 "$REPO/goal-gen/package.json"
assert_head_index_same_manifest_changed
```

<!-- recipe:path-b-dir-mtime-fail -->
```bash
set -euo pipefail
path_b_worktree_manifest() {
  test -n "${REPO:-}"
  test -d "$REPO"
  (
    cd "$REPO" || exit 1
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
seed_dir_mtime_repo() {
  REPO="$(mktemp -d /tmp/cs-pathb-dirmtime.XXXXXX)"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email analog@example.com
  git -C "$REPO" config user.name analog
  mkdir -p "$REPO/goal-gen"
  printf '%s\n' '{"name":"goal-gen"}' > "$REPO/goal-gen/package.json"
  chmod 644 "$REPO/goal-gen/package.json"
  git -C "$REPO" add goal-gen/package.json
  git -C "$REPO" commit -q -m init
  mkdir "$REPO/EMPTY_PREEXIST"
  CS_SCRATCH="$(mktemp -d /tmp/cs-scratch.XXXXXX)"
  BEFORE_HEAD="$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse HEAD)"
  gitdir="$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse --absolute-git-dir)"
  index_file="$gitdir/index"
  test -f "$index_file"
  test ! -L "$index_file"
  BEFORE_INDEX="$(sha256sum "$index_file" | awk '{print $1}')"
  path_b_worktree_manifest > "$CS_SCRATCH/before-worktree.txt"
}
assert_head_index_same_manifest_changed() {
  test "$(GIT_OPTIONAL_LOCKS=0 git -C "$REPO" rev-parse HEAD)" = "$BEFORE_HEAD"
  test "$(sha256sum "$index_file" | awk '{print $1}')" = "$BEFORE_INDEX"
  path_b_worktree_manifest > "$CS_SCRATCH/after-worktree.txt"
  set +e
  cmp -s "$CS_SCRATCH/before-worktree.txt" "$CS_SCRATCH/after-worktree.txt"
  cmp_rc=$?
  set -e
  test "$cmp_rc" -ne 0
  rm -rf -- "$REPO"
  rm -rf -- "$CS_SCRATCH"
}
seed_dir_mtime_repo
mkdir "$REPO/EMPTY_NEW"
assert_head_index_same_manifest_changed
seed_dir_mtime_repo
rmdir "$REPO/EMPTY_PREEXIST"
assert_head_index_same_manifest_changed
seed_dir_mtime_repo
sleep 1
touch "$REPO/goal-gen/package.json"
assert_head_index_same_manifest_changed
```
