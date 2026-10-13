#!/bin/bash
# PreToolUse(Bash) hook: block `git push` when the Rust or UI checks fail.
#
# WHY: CI would catch these, but a red push wastes shared CI minutes and forces a
# follow-up commit. This runs the same fast checks locally, scoped to what changed
# versus the upstream ref (Rust checks only if Rust/Cargo files changed, UI checks
# only if ui/ changed).
#
# Exit 2 blocks the push and shows stderr to the model.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only trigger on actual git push commands.
if ! echo "$COMMAND" | grep -qE '^\s*git\s+push(\s|$)'; then
  exit 0
fi

export PATH="$HOME/.cargo/bin:$PATH"
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}" || exit 0

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
REMOTE_REF=$(git rev-parse --abbrev-ref "@{upstream}" 2>/dev/null)
if [ -z "$REMOTE_REF" ]; then
  for candidate in "origin/$CURRENT_BRANCH" "origin/dev" "origin/main"; do
    if git rev-parse --verify "$candidate" >/dev/null 2>&1; then
      REMOTE_REF="$candidate"
      break
    fi
  done
fi
# No remote ref yet (first push): check everything.
if [ -n "$REMOTE_REF" ]; then
  CHANGED=$(git diff --name-only "$REMOTE_REF"...HEAD 2>/dev/null)
else
  CHANGED=$(git ls-files)
fi

ERRORS=""

if echo "$CHANGED" | grep -qE '\.rs$|(^|/)Cargo\.(toml|lock)$|^rust-toolchain\.toml$' && command -v cargo >/dev/null 2>&1; then
  OUT=$(cargo fmt --check 2>&1) || ERRORS="$ERRORS\n=== cargo fmt (run: cargo fmt) ===\n$OUT"
  OUT=$(cargo clippy --workspace --all-targets -- -D warnings 2>&1) || ERRORS="$ERRORS\n=== cargo clippy ===\n$OUT"
  OUT=$(cargo test --workspace 2>&1) || ERRORS="$ERRORS\n=== cargo test ===\n$OUT"
fi

if echo "$CHANGED" | grep -qE '^ui/' && [ -d ui/node_modules ] && command -v pnpm >/dev/null 2>&1; then
  OUT=$(pnpm -C ui lint 2>&1) || ERRORS="$ERRORS\n=== ui lint (run: pnpm -C ui format) ===\n$OUT"
  OUT=$(pnpm -C ui typecheck 2>&1) || ERRORS="$ERRORS\n=== ui typecheck ===\n$OUT"
fi

if [ -n "$ERRORS" ]; then
  echo -e "PUSH BLOCKED: fix these issues before pushing.\n$ERRORS" >&2
  exit 2
fi
exit 0
