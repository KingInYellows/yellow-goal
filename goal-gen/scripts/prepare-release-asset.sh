#!/usr/bin/env bash
# Build the GitHub Release asset without passing a GitHub credential into npm
# lifecycle scripts. Publication and recovery live in publish-release-asset.sh.
set -euo pipefail

: "${GITHUB_REF_NAME:?GITHUB_REF_NAME must contain the v* tag}"
: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"

tag="$GITHUB_REF_NAME"
version="${tag#v}"
if [ "$tag" = "$version" ] || [ -z "$version" ]; then
  echo "release tag must start with v: $tag" >&2
  exit 1
fi

tag_type="$(git cat-file -t "refs/tags/$tag" 2>/dev/null || true)"
if [ "$tag_type" != "tag" ]; then
  echo "tag $tag is not annotated (git cat-file -t -> ${tag_type:-missing}); cut with: git tag -a $tag -m $tag" >&2
  exit 1
fi

tag_commit="$(git rev-parse "refs/tags/$tag^{commit}")"
head_commit="$(git rev-parse HEAD)"
if [ "$tag_commit" != "$head_commit" ]; then
  echo "annotated tag $tag peels to $tag_commit, but checkout HEAD is $head_commit" >&2
  exit 1
fi

package_version="$(node -p "require('./package.json').version")"
if [ "$version" != "$package_version" ]; then
  echo "tag $tag does not match package.json version $package_version" >&2
  exit 1
fi

asset_name="goal-gen-${version}.tgz"
asset_path="$RUNNER_TEMP/$asset_name"
if [ -e "$asset_path" ]; then
  echo "refusing to overwrite existing release asset: $asset_path" >&2
  exit 1
fi

# npm lifecycle scripts must not inherit either credential spelling.
env -u GH_TOKEN -u GITHUB_TOKEN npm pack --pack-destination "$RUNNER_TEMP" >/dev/null
if [ ! -f "$asset_path" ]; then
  echo "npm pack did not produce expected asset $asset_path" >&2
  exit 1
fi

sha256sum "$asset_path" > "$asset_path.sha256"
