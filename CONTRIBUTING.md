# Contributing

Patchroom is pre-alpha. Read [docs/SPEC.md](docs/SPEC.md) first; it holds the principles every change must respect.

1. Fork or branch off `dev`. `dev` is the default branch. Open PRs against `dev`.
2. Work in a git worktree: `bash .claude/scripts/new-worktree.sh <slug>`. Branch name: `feat/<slug>`.
3. Run the checks listed in the [README](README.md#dev-setup) before pushing. Run `bash scripts/setup-hooks.sh` once to automate the cheap ones.
4. Keep PRs small and single-purpose. Say what changed and how you verified it.
5. Never commit secrets. Never add network listeners, telemetry, or code that edits a user's CLI config files (spec sections 1 and 4).

By contributing you agree your work is licensed under the [MIT License](LICENSE).
