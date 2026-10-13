#!/usr/bin/env bash
# Create an ephemeral feature worktree off the latest origin/<base> and install deps.
#
# WHY: two sessions sharing one checkout silently overwrite each other's work.
# A worktree per task gives each its own directory and branch; they meet at a PR.
# Dependencies are installed for real (pnpm install) so local lint/typecheck match CI.
# The Rust target dir is per worktree; set CARGO_TARGET_DIR to share builds if disk matters.
#
# Usage: bash .claude/scripts/new-worktree.sh <task-slug> [base-branch=dev]
set -euo pipefail

slug="${1:?usage: new-worktree.sh <task-slug> [base-branch=dev]}"
base="${2:-dev}"
root="$(git rev-parse --show-toplevel)"
dir="$(dirname "$root")/$(basename "$root")-${slug}"
branch="feat/${slug}"

git -C "$root" fetch --quiet origin

if git -C "$root" show-ref --verify --quiet "refs/heads/${branch}"; then
  echo "ERROR: branch '${branch}' already exists. Pick another slug or attach it:"
  echo "  git worktree add \"${dir}\" ${branch}"
  exit 1
fi
if [ -e "${dir}" ]; then
  echo "ERROR: path already exists: ${dir}"
  exit 1
fi

git -C "$root" worktree add "${dir}" -b "${branch}" "origin/${base}"

deps_ok=1
if command -v pnpm >/dev/null 2>&1; then
  ( cd "${dir}" && pnpm install --frozen-lockfile ) || { echo "WARNING: pnpm install failed in ${dir}"; deps_ok=0; }
else
  echo "WARNING: pnpm not found. Run 'corepack enable' then 'pnpm install' in ${dir}."
  deps_ok=0
fi
( cd "${dir}" && bash scripts/setup-hooks.sh ) || true

echo ""
echo "worktree ready: ${dir}"
echo "  branch: ${branch} (based on origin/${base})"
[ "${deps_ok}" -eq 1 ] && echo "  deps:   installed (pnpm)" || echo "  deps:   WARNING: install incomplete"
echo ""
echo "When merged:"
echo "  git worktree remove \"${dir}\" && git push origin --delete ${branch} && git branch -D ${branch}"
