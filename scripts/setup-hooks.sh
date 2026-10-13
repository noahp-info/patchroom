#!/usr/bin/env bash
# Point git at the repo's tracked hooks. Run once per clone.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
chmod +x .githooks/*
git config core.hooksPath .githooks
echo "git hooks enabled (core.hooksPath=.githooks)"
command -v gitleaks >/dev/null 2>&1 || echo "tip: brew install gitleaks for the local secret scan"
