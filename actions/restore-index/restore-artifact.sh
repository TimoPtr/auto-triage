#!/usr/bin/env bash
# Downloads the newest unexpired artifact NAME of this repository into DEST_DIR
# and prints its id, or 0 when none exists. Needs GH_TOKEN with actions: read.
set -euo pipefail
name="$1"
dest="$2"
mkdir -p "$dest"
id="$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=$name&per_page=30" \
  --jq '[.artifacts[] | select(.expired == false)] | sort_by(.created_at) | reverse | .[0].id // empty')"
if [ -z "$id" ]; then
  echo "0"
  exit 0
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$id/zip" > "$tmp/artifact.zip"
unzip -o -q "$tmp/artifact.zip" -d "$dest"
echo "$id"
