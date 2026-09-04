#!/usr/bin/env bash
# Publish a prepared release asset. Existing published assets are immutable:
# only a draft's mismatched asset may be deleted and re-uploaded for recovery.
set -euo pipefail

: "${GITHUB_REF_NAME:?GITHUB_REF_NAME must contain the v* tag}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must identify the repository}"
: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
: "${GH_TOKEN:?GH_TOKEN is required only for GitHub Release publication}"

tag="$GITHUB_REF_NAME"
version="${tag#v}"
if [ "$tag" = "$version" ] || [ -z "$version" ]; then
  echo "release tag must start with v: $tag" >&2
  exit 1
fi

tag_type="$(git cat-file -t "refs/tags/$tag" 2>/dev/null || true)"
if [ "$tag_type" != "tag" ]; then
  echo "tag $tag is not annotated (git cat-file -t -> ${tag_type:-missing})" >&2
  exit 1
fi
if [ "$(git rev-parse "refs/tags/$tag^{commit}")" != "$(git rev-parse HEAD)" ]; then
  echo "annotated tag $tag does not peel to checkout HEAD" >&2
  exit 1
fi
if [ "$version" != "$(node -p "require('./package.json').version")" ]; then
  echo "tag $tag does not match package.json version" >&2
  exit 1
fi

asset_name="goal-gen-${version}.tgz"
asset_path="$RUNNER_TEMP/$asset_name"
if [ ! -f "$asset_path" ]; then
  echo "prepared release asset is missing: $asset_path" >&2
  exit 1
fi
expected_sha="$(sha256sum "$asset_path" | awk '{print $1}')"
view_error="$RUNNER_TEMP/release-view-${version}.stderr"

if release_json="$(gh release view "$tag" --repo "$GITHUB_REPOSITORY" --json tagName,isDraft,assets 2>"$view_error")"; then
  :
elif grep -qi "release not found" "$view_error"; then
  notes="goal-gen ${version} engine tarball (ADR-0016). Install the public asset and spawn goal-gen as a process; never import engine TypeScript."
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --title "$tag" --notes "$notes" --draft --verify-tag
  release_json="$(gh release view "$tag" --repo "$GITHUB_REPOSITORY" --json tagName,isDraft,assets)"
else
  cat "$view_error" >&2
  exit 1
fi

release_is_draft="$(printf '%s' "$release_json" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const r=JSON.parse(s); if(r.tagName!==process.argv[1] || typeof r.isDraft!=="boolean" || !Array.isArray(r.assets)) throw new Error("release identity or metadata mismatch"); console.log(r.isDraft ? "true" : "false"); })' "$tag")"
asset_present="$(printf '%s' "$release_json" | node -e 'const name = process.argv[1]; let s=""; process.stdin.on("data", d => s += d).on("end", () => console.log(JSON.parse(s).assets.some(a => a.name === name) ? "true" : "false"))' "$asset_name")"

download_dir="$(mktemp -d "$RUNNER_TEMP/goal-gen-release-download.XXXXXX")"
trap 'rm -rf -- "$download_dir"' EXIT

if [ "$asset_present" = "true" ]; then
  downloaded_sha=""
  if gh release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern "$asset_name" --dir "$download_dir"; then
    downloaded_sha="$(sha256sum "$download_dir/$asset_name" | awk '{print $1}')"
  elif [ "$release_is_draft" != "true" ]; then
    echo "cannot verify the published asset; refusing to alter it" >&2
    exit 1
  fi
  if [ "$downloaded_sha" != "$expected_sha" ]; then
    if [ "$release_is_draft" != "true" ]; then
      echo "published release $tag has a mismatched $asset_name; refusing to clobber it" >&2
      exit 1
    fi
    gh release delete-asset "$tag" "$asset_name" --repo "$GITHUB_REPOSITORY" --yes
    asset_present="false"
  fi
fi

if [ "$asset_present" = "false" ]; then
  gh release upload "$tag" "$asset_path" --repo "$GITHUB_REPOSITORY"
fi

rm -rf -- "$download_dir"
download_dir="$(mktemp -d "$RUNNER_TEMP/goal-gen-release-verify.XXXXXX")"
gh release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern "$asset_name" --dir "$download_dir"
actual_sha="$(sha256sum "$download_dir/$asset_name" | awk '{print $1}')"
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "uploaded release asset SHA-256 does not match the prepared tarball" >&2
  exit 1
fi

if [ "$release_is_draft" = "true" ]; then
  gh release edit "$tag" --repo "$GITHUB_REPOSITORY" --draft=false
fi
