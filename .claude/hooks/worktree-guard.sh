#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit) - nudge toward a worktree before substantive
# source edits on a protected branch.
#
# WHY: When a read-only investigation task grows into a feature mid-session,
# the isolation decision is never revisited. This catches the deterministic
# signal instead: the FIRST edit of a tracked source file while on a protected
# branch (dev/main). NON-BLOCKING - injects a one-time reminder and allows
# the edit. Feature-branch worktrees (feat/*) and docs-only edits are exempt.
#
# It never blocks, commits, or changes anything - it only surfaces context.
#
# 

# Source dir prefixes (relative to repo root) that trigger the reminder.
# that should trigger the worktree reminder. Edits outside these dirs are ignored.
# docs/** and .claude/** are always exempt (never trigger the reminder).
SOURCE_DIRS="src-tauri crates ui/src plugins scripts"

set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat 2>/dev/null || true)
[ -n "$INPUT" ] || exit 0

# Edit/Write/MultiEdit all carry the target as tool_input.file_path.
fp=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$fp" ] || exit 0

# Only on protected branches - worktrees live on feat/* and are exempt by design.
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
case "$branch" in
  dev | main | master) ;;
  *) exit 0 ;;
esac

# Resolve the path relative to the repo root so the dir match is robust.
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
rel=${fp#"$root"/}

# Always exempt docs and .claude edits.
case "$rel" in
  docs/* | .claude/*) exit 0 ;;
esac

# Only nudge for configured SOURCE_DIRS.
matched=0
for dir in $SOURCE_DIRS; do
  case "$rel" in
    "${dir}/"*) matched=1; break ;;
  esac
done
[ "$matched" -eq 1 ] || exit 0

# Fire at most once per session (session_id from the hook payload).
sid=$(printf '%s' "$INPUT" | jq -r '.session_id // "nosession"' 2>/dev/null)
state_dir="$root/.claude/.state"
mkdir -p "$state_dir" 2>/dev/null || true
marker="$state_dir/worktree-warned-$sid"
[ -f "$marker" ] && exit 0
: >"$marker" 2>/dev/null || true

read -r -d '' msg <<EOF || true
WORKTREE CHECK: about to edit a tracked source file ($rel) on the protected branch '$branch'.

If this is substantive feature or refactor work - and ESPECIALLY if a read-only/investigation task has turned into editing code, or another Claude session may be active - STOP and move it into an isolated worktree first so concurrent sessions can't clobber each other:

  bash .claude/scripts/new-worktree.sh <task-slug>

then continue there on feat/<task-slug> (commit + PR into dev from the worktree).

If this is a tiny one-off fix and no other session is active, it's fine to proceed on '$branch'. This reminder fires once per session.
EOF

jq -cn --arg m "$msg" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $m}}'
exit 0
