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
github=0
while IFS=' ' read -r sha author committer; do
  [ -n "$sha" ] || continue
  # GitHub made this commit (a squash merge or web edit on github.com). Its author email comes
  # from the owner's GitHub email settings, not from this repo, so skip the commit entirely.
  if [ "$committer" = "noreply@github.com" ]; then
    github=$((github + 1))
    continue
  fi
  for e in "$author" "$committer"; do
    if ! printf '%s\n' "$e" | grep -qE "$ok"; then
      echo "author-email: ${sha:0:9} uses $e, not a users.noreply.github.com address"
      bad=1
      break
    fi
  done
done < <(git log --format='%H %ae %ce' "$@")
[ "$github" -eq 0 ] || echo "author-email: skipped $github GitHub-made commit(s) (committer noreply@github.com)"
if [ "$bad" -ne 0 ]; then
  echo "author-email: set git config user.email to your GitHub noreply address, then" >&2
  echo "  git rebase <base> --exec 'git commit --amend --no-edit --reset-author'" >&2
  exit 1
fi
echo "author-email: clean ($*)"
