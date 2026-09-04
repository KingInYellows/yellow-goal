#!/usr/bin/env bash
# Installation gate (ADR-0016): prove an external consumer can install the engine from the npm
# tarball alone and drive it as a process — no repo checkout, no devDependencies, no npm scripts.
# Packs the package, installs it into a scratch consumer directory, then exercises the installed
# `goal-gen` bin against a scratch git repository: JSON stdout on success, structured stderr +
# exit 2 on usage error, and the target repository left untouched (read-only invariant).
#
# Everything happens under mktemp — never against a product checkout. Safe to run locally.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

workdir="$(mktemp -d "${TMPDIR:-/tmp}/goal-gen-install-smoke.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT
scratch_home="$workdir/home"
scratch_tmp="$workdir/tmp"
fake_bin="$workdir/fake-provider-bin"
mkdir -p "$scratch_home" "$scratch_tmp" "$fake_bin"

# Use a credential-free scratch environment for the installed process.  These traps are ahead
# of PATH, so a regression toward a paid provider fails deterministically before any invocation.
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CODEX_API_KEY GH_TOKEN GITHUB_TOKEN NODE_AUTH_TOKEN NPM_TOKEN OPENAI_API_KEY
for provider in claude codex; do
  cat >"$fake_bin/$provider" <<'EOF'
#!/usr/bin/env sh
echo "unexpected live provider invocation" >&2
exit 97
EOF
  chmod +x "$fake_bin/$provider"
done
base_path="$PATH"
export PATH="$fake_bin:$base_path"
export HOME="$scratch_home"
export TMPDIR="$scratch_tmp"
export XDG_CACHE_HOME="$scratch_home/.cache"
export XDG_CONFIG_HOME="$scratch_home/.config"
export NPM_CONFIG_CACHE="$workdir/npm-cache"
export NPM_CONFIG_USERCONFIG="$workdir/npmrc"
touch "$NPM_CONFIG_USERCONFIG"

# 1. Pack the tarball.
tarball="$workdir/$(npm pack --pack-destination "$workdir" | tail -n 1)"
test -f "$tarball"

# 2. Install it into a scratch consumer directory (runtime dependencies only).
consumer="$workdir/consumer"
mkdir -p "$consumer"
(cd "$consumer" && npm init -y >/dev/null && npm install --no-audit --no-fund "$tarball" >/dev/null)
bin="$consumer/node_modules/.bin/goal-gen"
test -x "$bin"

# 3. Scratch target repository for the request (never a product clone).
target="$workdir/target-repo"
mkdir -p "$target"
git -C "$target" init -q
printf 'target sentinel: unchanged\n' > "$target/protocol-smoke-sentinel.txt"
git -C "$target" add protocol-smoke-sentinel.txt
git -C "$target" -c user.name=smoke -c user.email=smoke@invalid commit -q -m init

# 4a. version → exit 0 and an engineVersion matching the packed artifact (RR17: the installed
#     tarball must self-identify — this is the probe an external consumer pins against).
out="$("$bin" version --json)"
expected_version="$(node -p "require('./package.json').version")"
node -e "const o=JSON.parse(process.argv[1]); if(o.engineVersion!==process.argv[2]) throw new Error('expected engineVersion '+process.argv[2]+', got: '+process.argv[1])" "$out" "$expected_version"

# 4. request create → exit 0, JSON stdout, request file written.
out="$("$bin" request create --repo "$target" --goal "install smoke" --output "$workdir/request.json" --json)"
node -e "const o=JSON.parse(process.argv[1]); if(!o.requestId) throw new Error('request create output missing requestId')" "$out"
test -f "$workdir/request.json"

# 5. request validate → exit 0 and {"valid":true}.
out="$("$bin" request validate "$workdir/request.json" --json)"
node -e "const o=JSON.parse(process.argv[1]); if(o.valid!==true) throw new Error('expected valid:true, got: '+process.argv[1])" "$out"

# 6. Unknown command → exit 2, single-line structured JSON on stderr.
set +e
err="$("$bin" definitely-not-a-command 2>&1 >/dev/null)"
code=$?
set -e
if [ "$code" -ne 2 ]; then
  echo "expected exit 2 for usage error, got $code" >&2
  exit 1
fi
node -e "const o=JSON.parse(process.argv[1]); if(o.error.code!=='USAGE_ERROR') throw new Error('expected USAGE_ERROR, got: '+process.argv[1])" "$err"

# 7. Provider Protocol v1 through the installed artifact only. The harness
# creates and adjusts a disposable canonical request, then invokes stub-only
# scenarios; it neither imports source nor selects a real executor.
node scripts/installed-protocol-smoke.mjs "$bin" "$expected_version" "$workdir/protocol-request.json" "$target"

# 8. Read-only proof: the target repository is untouched.
status="$(git -C "$target" status --porcelain)"
if [ -n "$status" ]; then
  echo "target repository mutated during smoke:" >&2
  echo "$status" >&2
  exit 1
fi

echo "install smoke passed: all install and protocol smoke checks passed"
