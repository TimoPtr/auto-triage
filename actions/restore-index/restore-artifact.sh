#!/usr/bin/env bash
# Restores the newest unexpired artifact NAME into DEST_FILE and prints the
# artifact id, or 0 when none qualifies. Needs GH_TOKEN with actions: read.
#
# Only artifacts produced by a run of this repository's default branch count:
# a pull request run can upload an artifact under any name, so anything
# from another branch or repository is a poisoning attempt, not a backup.
# The zip is extracted into a private directory and must hold exactly one
# regular file named like DEST_FILE; anything else is discarded.
set -euo pipefail
name="$1"
dest="$2"
base="$(basename "$dest")"

read -r repo_id default_branch < <(gh api "repos/$GITHUB_REPOSITORY" --jq '"\(.id) \(.default_branch)"')
id="$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=$name&per_page=30" \
  --jq --arg repo_id "$repo_id" --arg branch "$default_branch" \
  '[.artifacts[] | select(.expired == false
      and (.workflow_run.head_repository_id | tostring) == $repo_id
      and (.workflow_run.repository_id | tostring) == $repo_id
      and .workflow_run.head_branch == $branch)]
   | sort_by(.created_at) | reverse | .[0].id // empty')"
if [ -z "$id" ]; then
  echo "0"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$id/zip" > "$tmp/artifact.zip"
mkdir "$tmp/extract"
unzip -o -q "$tmp/artifact.zip" -d "$tmp/extract"
entries="$(find "$tmp/extract" -mindepth 1 | wc -l | tr -d ' ')"
if [ "$entries" != "1" ] || [ -L "$tmp/extract/$base" ] || [ ! -f "$tmp/extract/$base" ]; then
  echo "artifact $name ($id) does not hold exactly one regular file named $base; ignoring it" >&2
  echo "0"
  exit 0
fi
mkdir -p "$(dirname "$dest")"
mv -f "$tmp/extract/$base" "$dest"
echo "$id"
