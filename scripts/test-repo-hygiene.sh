#!/usr/bin/env bash
# Proves scripts/check-repo-hygiene.sh still fires on every rule and passes a clean tree.
# Each bad fixture goes into its own throwaway git repo next to one clean file.
# The fixtures are built at run time, so this repo never tracks a file that breaks the rule.
set -euo pipefail

# A git hook exports GIT_DIR, GIT_INDEX_FILE and friends. Drop them, or the throwaway
# repos below would write into the repo that is running the hook.
unset $(git rev-parse --local-env-vars)
export GIT_CONFIG_NOSYSTEM=1

here=$(cd "$(dirname "$0")" && pwd)
check="$here/check-repo-hygiene.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Split so this file holds no real home path and no transcript line itself.
U=/Users
H=/home
PU='"parent''Uuid"'
SI='"session''Id"'

fail=0
n=0
new_repo() {
  n=$((n + 1))
  repo="$tmp/r$n"
  mkdir -p "$repo"
  git -C "$repo" init -q
  printf 'clean\n' >"$repo/README.md"
}
put() { # put <path> <content>
  mkdir -p "$(dirname "$repo/$1")"
  printf '%s\n' "$2" >"$repo/$1"
}

# expect_bad <name> <path> <content> <reason substring>
expect_bad() {
  new_repo
  put "$2" "$3"
  git -C "$repo" add -A -f
  for m in --all --staged; do
    if out=$(cd "$repo" && bash "$check" "$m" 2>&1); then
      echo "FAIL $1 ($m): check passed, expected a finding"
      fail=1
    elif ! grep -qF -- "$4" <<<"$out"; then
      echo "FAIL $1 ($m): wrong finding: $out"
      fail=1
    else
      echo "ok   $1 ($m)"
    fi
  done
}

expect_bad settings-local .claude/settings.local.json '{}' 'settings.local.json'
expect_bad nested-settings-local sub/.claude/settings.local.json '{}' 'settings.local.json'
expect_bad claude-state .claude/.state/run.json '{}' '.claude/.state/'
expect_bad claude-local CLAUDE.local.md 'notes' 'CLAUDE.local.md'
expect_bad env .env 'TOKEN=1' 'env file'
expect_bad env-dot ui/.env.local 'TOKEN=1' 'env file'
expect_bad jsonl logs/run.jsonl '{}' '.jsonl outside'
expect_bad memory docs/MEMORY.md '- a fact' 'MEMORY.md'
expect_bad transcript notes/t.json "{$PU:\"a\",$SI:\"b\"}" 'transcript line'
expect_bad transcript-reversed notes/t.txt "{$SI:\"b\",\"x\":1,$PU:null}" 'transcript line'
expect_bad home-mac src/a.ts "const p = '$U/jdoe/code/app';" 'real home path'
expect_bad home-linux src/a.rs "let p = \"$H/jdoe/.config\";" 'real home path'
expect_bad home-in-md DESIGN.md "See $U/jdoe/design/looks.html." 'real home path'

# A clean tree: placeholders, allowed fixtures and lone keys pass in both modes.
new_repo
put src/paths.ts "const a = '$U/alex/code/app'; const b = '$H/runner/work'; const c = '$U/me/x';"
put docs/p.md "Use $U/<name>/ in docs, or $U/\$USER/Downloads."
put ui/tests/fixtures/rec.jsonl '{"t":0}'
put .env.example 'TOKEN='
put src/map.rs "let key = $PU; // only one key"
git -C "$repo" add -A -f
for m in --all --staged; do
  if out=$(cd "$repo" && bash "$check" "$m" 2>&1); then
    echo "ok   clean ($m)"
  else
    echo "FAIL clean ($m): $out"
    fail=1
  fi
done

# Staged mode checks only staged files: a committed bad file is CI's job, not the hook's.
new_repo
put src/a.ts "const p = '$U/jdoe/x';"
git -C "$repo" add -A -f
git -C "$repo" -c user.name=t -c user.email=t@example.com commit -qm base
put src/b.ts 'ok'
git -C "$repo" add src/b.ts
if (cd "$repo" && bash "$check" --staged >/dev/null 2>&1); then
  echo "ok   staged-scope"
else
  echo "FAIL staged-scope: --staged flagged a file that was not staged"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "test-repo-hygiene: FAILED" >&2
  exit 1
fi
echo "test-repo-hygiene: all rules fire, clean tree passes"
