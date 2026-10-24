#!/usr/bin/env bash
# List open, unassigned `folio` issues (oldest first) and optionally claim
# each one with a `/claim` comment. The `claim-folio` workflow assigns the
# issue to the commenter; this script then waits and reports the result.
#
# Usage:
#   claim_folios.sh <N>           # list only; changes nothing
#   claim_folios.sh <N> --claim   # list, then comment `/claim` on each issue
#
# Set REPO=owner/name to use a different repo (default below).
# Set WAIT=<seconds> to change how long to wait for the workflow (default 120).
set -euo pipefail

# Git Bash (MSYS) on Windows rewrites arguments that look like Unix paths
# before it runs a native program, so `--body "/claim"` would reach gh as
# "C:/Program Files/Git/claim". Turn that off; elsewhere it does nothing.
export MSYS_NO_PATHCONV=1

REPO="${REPO:-charlesLoder/leningrad-codex-tei}"
WAIT="${WAIT:-120}"

usage() {
  echo "Usage: $0 <N> [--claim]" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
N="$1"
[[ "$N" =~ ^[1-9][0-9]*$ ]] || usage
CLAIM=false
if [[ $# -eq 2 ]]; then
  [[ "$2" == "--claim" ]] || usage
  CLAIM=true
fi

command -v gh >/dev/null || { echo "gh is not installed" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in; run 'gh auth login'" >&2; exit 1; }

# Tab-separated: number, title. Sorted oldest first, like the issues URL in CONTRIBUTING.MD.
issues=$(gh issue list -R "$REPO" --label folio --state open \
  --search "no:assignee sort:created-asc" --limit "$N" \
  --json number,title --jq '.[] | "\(.number)\t\(.title)"')

if [[ -z "$issues" ]]; then
  echo "No open, unassigned folio issues found."
  exit 0
fi

echo "$issues" | while IFS=$'\t' read -r number title; do
  echo "#$number  $title"
done

$CLAIM || exit 0

me=$(gh api user --jq .login)

echo
echo "$issues" | while IFS=$'\t' read -r number title; do
  gh issue comment "$number" -R "$REPO" --body "/claim" >/dev/null
  echo "Commented /claim on #$number"
done

# Wait for the workflow to assign each issue, then report.
echo
echo "Waiting up to ${WAIT}s for the claim-folio workflow..."
pending=$(echo "$issues" | cut -f1)
deadline=$((SECONDS + WAIT))
while [[ -n "$pending" ]]; do
  still=""
  for number in $pending; do
    assignees=$(gh issue view "$number" -R "$REPO" --json assignees \
      --jq '[.assignees[].login] | join(" ")')
    if [[ " $assignees " == *" $me "* ]]; then
      echo "ASSIGNED  #$number"
    elif [[ -n "$assignees" ]]; then
      echo "TAKEN     #$number  (claimed by $assignees)"
    else
      still+="$number "
    fi
  done
  pending="$still"
  [[ -z "$pending" ]] && break
  if (( SECONDS >= deadline )); then
    for number in $pending; do
      echo "NO CHANGE #$number  (not assigned yet; check the issue for a reply)"
    done
    break
  fi
  sleep 10
done
