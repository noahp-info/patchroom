#!/usr/bin/env bash
# Repo hygiene guard. This repo is public: keep personal and agent-local files out of it.
#
# Usage: scripts/check-repo-hygiene.sh [--all | --staged]
#   --all     check every tracked file (CI, the default)
#   --staged  check only the files staged for commit (.githooks/pre-commit)
#
# It reads the git index, so it checks exactly what a commit contains. It fails on:
#   - agent-local files: .claude/settings.local.json, .claude/.state/, CLAUDE.local.md, MEMORY.md
#   - env files: .env and .env.* (.env.example is allowed)
#   - *.jsonl outside ui/tests/fixtures/
#   - Claude transcript lines (a line with both the parent-uuid and session-id keys)
#   - a real home path (/Users/<name>/ or /home/<name>/) unless <name> is a placeholder below
# Tested by scripts/test-repo-hygiene.sh. Portable to macOS bash 3.2 and GNU tools.
set -euo pipefail

mode=${1:---all}
case $mode in
  --all | --staged) ;;
  *)
    echo "usage: $0 [--all | --staged]" >&2
    exit 2
    ;;
esac
cd "$(git rev-parse --show-toplevel)"
export GIT_LITERAL_PATHSPECS=1

# Placeholder user names that may appear in a home path in docs, tests and fixtures.
allow='alex|runner|me|you|someone|user|username|example|x|u|Shared'
# The one folder where scrubbed .jsonl test recordings may live.
jsonl_dir='ui/tests/fixtures/'
home_re='/(Users|home)/[A-Za-z0-9._-]+/'
# Written with brackets so this file does not match its own rule.
transcript_re='"parent[U]uid".*"session[I]d"|"session[I]d".*"parent[U]uid"'

list() {
  if [ "$mode" = --staged ]; then
    git diff --cached --name-only -z --diff-filter=ACMR
  else
    git ls-files -z
  fi
}

found=0
flag() {
  echo "hygiene: $1"
  found=1
}

# 1. Paths that must never be tracked.
while IFS= read -r -d '' f; do
  base=${f##*/}
  case "/$f" in
    */.claude/settings.local.json) flag "$f: agent-local settings (.claude/settings.local.json)" ;;
    */.claude/.state/*) flag "$f: agent state (.claude/.state/)" ;;
  esac
  case $base in
    CLAUDE.local.md) flag "$f: personal agent notes (CLAUDE.local.md)" ;;
    MEMORY.md) flag "$f: agent memory file (MEMORY.md)" ;;
    .env.example) ;;
    .env | .env.*) flag "$f: env file (.env, .env.*)" ;;
    *.jsonl)
      case $f in
        "$jsonl_dir"*) ;;
        *) flag "$f: .jsonl outside $jsonl_dir (transcripts and logs stay local)" ;;
      esac
      ;;
  esac
done < <(list)

# 2. File contents, read from the index.
grep_index() {
  if [ "$mode" = --staged ]; then
    local files
    files=$(list | tr '\0' '\n')
    [ -n "$files" ] || return 0
    list | xargs -0 git grep --cached -I "$@" -- 2>/dev/null || true
  else
    git grep --cached -I "$@" 2>/dev/null || true
  fi
}

while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  flag "${hit%%:*}: Claude transcript line (parent-uuid with session-id)"
done < <(grep_index -l -E "$transcript_re")

while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  path=${hit##*:}
  if ! printf '%s\n' "$path" | grep -qE "^/(Users|home)/($allow)/\$"; then
    loc=${hit%:*}
    flag "$loc: real home path $path (use a placeholder such as /Users/alex/)"
  fi
done < <(grep_index -n -o -E "$home_re")

if [ "$found" -ne 0 ]; then
  echo "hygiene: failed. Remove or rewrite the files above; see CLAUDE.md, Repo hygiene." >&2
  exit 1
fi
echo "hygiene: clean ($mode)"
