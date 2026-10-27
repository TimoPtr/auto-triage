#!/usr/bin/env bash
# Restores the newest unexpired artifact NAME and prints the artifact id, or 0
# when none qualifies. Needs GH_TOKEN with actions: read.
#
#   restore-artifact.sh NAME DEST_FILE      one regular file named like DEST_FILE
#   restore-artifact.sh NAME DEST_DIR dir   flat regular files, moved into DEST_DIR
#
# Only artifacts produced by a run of this repository's default branch count:
# a pull request run can upload an artifact under any name, so anything
# from another branch or repository is a poisoning attempt, not a backup.
# The zip is extracted into a private directory; entries must be plain names
# (no slash, no leading dot) and regular files, else the whole artifact is discarded.
set -euo pipefail
name="$1"
dest="$2"
mode="${3:-file}"
base="$(basename "$dest")"

read -r repo_id default_branch < <(gh api "repos/$GITHUB_REPOSITORY" | jq -r '"\(.id) \(.default_branch)"')
# gh api's --jq takes no jq arguments, so the filter runs in jq itself with the values bound as variables.
id="$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=$name&per_page=30" \
  | jq -r --arg repo_id "$repo_id" --arg branch "$default_branch" \
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

discard() {
  echo "artifact $name ($id) $1; ignoring it" >&2
  echo "0"
  exit 0
}

# Every entry must be a plain file name before anything is extracted.
listing="$(unzip -Z1 "$tmp/artifact.zip" 2>/dev/null)" || discard "is not a zip archive"
while IFS= read -r entry; do
  [[ "$entry" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || discard "holds an entry that is not a plain file name ($entry)"
done <<< "$listing"

mkdir "$tmp/extract"
unzip -o -q "$tmp/artifact.zip" -d "$tmp/extract"
entries="$(find "$tmp/extract" -mindepth 1 | wc -l | tr -d ' ')"
regular="$(find "$tmp/extract" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')"
[ "$entries" = "$regular" ] && [ "$entries" != "0" ] || discard "does not hold only regular files"

if [ "$mode" = "dir" ]; then
  mkdir -p "$dest"
  find "$tmp/extract" -mindepth 1 -maxdepth 1 -type f -exec mv -f {} "$dest/" \;
else
  [ "$entries" = "1" ] && [ -f "$tmp/extract/$base" ] || discard "does not hold exactly one regular file named $base"
  mkdir -p "$(dirname "$dest")"
  mv -f "$tmp/extract/$base" "$dest"
fi
echo "$id"
