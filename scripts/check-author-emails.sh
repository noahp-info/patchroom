#!/usr/bin/env bash
# Refuse commits whose author or committer email is not a GitHub noreply address. This repo is
# public: a personal email in a commit is a leak that only a history rewrite can undo.
#
# Usage: scripts/check-author-emails.sh <revision range...>  e.g. origin/dev..HEAD, or <sha> --not --remotes
# Run by .githooks/pre-push (the commits being pushed) and the CI `changes` job (the PR range).
# Set the noreply address once per clone: git config user.email <id>+<login>@users.noreply.github.com
set -euo pipefail

[ "$#" -gt 0 ] || { echo "usage: $0 <revision range...>" >&2; exit 2; }
ok='@users\.noreply\.github\.com$'
bad=0
while IFS=' ' read -r sha author committer; do
  [ -n "$sha" ] || continue
  for e in "$author" "$committer"; do
    # GitHub's own web-flow commits (merges made on github.com) are allowed.
    if ! printf '%s\n' "$e" | grep -qE "$ok" && [ "$e" != "noreply@github.com" ]; then
      echo "author-email: ${sha:0:9} uses $e, not a users.noreply.github.com address"
      bad=1
      break
    fi
  done
done < <(git log --format='%H %ae %ce' "$@")
if [ "$bad" -ne 0 ]; then
  echo "author-email: set git config user.email to your GitHub noreply address, then" >&2
  echo "  git rebase <base> --exec 'git commit --amend --no-edit --reset-author'" >&2
  exit 1
fi
echo "author-email: clean ($*)"
