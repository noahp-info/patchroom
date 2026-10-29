#!/usr/bin/env bash
# Proves scripts/check-author-emails.sh skips GitHub-made commits and still fails on a commit
# a person or agent pushed with a non-noreply author or committer.
# Each case builds a throwaway git repo at run time, so this repo tracks no bad commit.
set -euo pipefail

# A git hook exports GIT_DIR, GIT_INDEX_FILE and friends. Drop them, or the throwaway
# repos below would write into the repo that is running the hook.
unset $(git rev-parse --local-env-vars)
export GIT_CONFIG_NOSYSTEM=1

here=$(cd "$(dirname "$0")" && pwd)
check="$here/check-author-emails.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

good='1+alex@users.noreply.github.com'
# Split so this file holds no address that looks like a real one.
personal="alex@""example.com"
fail=0
n=0

# commit_as <author email> <committer email>
commit_as() {
  n=$((n + 1))
  printf '%s\n' "$n" >"$repo/f.txt"
  git -C "$repo" add f.txt
  GIT_AUTHOR_NAME=Alex GIT_AUTHOR_EMAIL="$1" GIT_COMMITTER_NAME=C GIT_COMMITTER_EMAIL="$2" \
    git -C "$repo" commit -q -m "c$n"
}

new_repo() {
  repo="$tmp/r$1"
  mkdir -p "$repo"
  git -C "$repo" init -q
  commit_as "$good" "$good"
}

# expect <name> <pass|fail> <output substring>
expect() {
  if out=$(cd "$repo" && bash "$check" HEAD~1..HEAD 2>&1); then got=pass; else got=fail; fi
  if [ "$got" != "$2" ]; then
    echo "FAIL $1: expected $2, got $got: $out"
    fail=1
  elif ! grep -qF -- "$3" <<<"$out"; then
    echo "FAIL $1: missing \"$3\" in: $out"
    fail=1
  else
    echo "ok   $1"
  fi
}

new_repo 1
commit_as "$good" "$good"
expect noreply-both pass 'author-email: clean'

new_repo 2
commit_as "$personal" "noreply@github.com"
expect github-squash-merge pass 'skipped 1 GitHub-made commit'

new_repo 3
commit_as "$personal" "$good"
expect personal-author fail "uses $personal"

new_repo 4
commit_as "$good" "$personal"
expect personal-committer fail "uses $personal"

new_repo 5
commit_as "noreply@github.com" "$good"
expect github-author-pushed-by-person fail 'uses noreply@github.com'

if [ "$fail" -ne 0 ]; then
  echo "test-author-emails: FAILED" >&2
  exit 1
fi
echo "test-author-emails: GitHub-made commits skip, pushed commits still checked"
