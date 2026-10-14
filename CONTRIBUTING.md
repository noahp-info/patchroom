# Contributing

Patchroom is pre-alpha. Read [docs/SPEC.md](docs/SPEC.md) first; it holds the principles every change must respect.

1. Fork or branch off `dev`. `dev` is the default branch. Open PRs against `dev`.
2. Work in a git worktree: `bash .claude/scripts/new-worktree.sh <slug>`. Branch name: `feat/<slug>`.
3. Run the checks listed in the [README](README.md#dev-setup) before pushing. Run `bash scripts/setup-hooks.sh` once to automate the cheap ones.
4. Keep PRs small and single-purpose. Say what changed and how you verified it.
5. Never commit secrets. Never add network listeners, telemetry, or code that edits a user's CLI config files (spec sections 1 and 4).

## License and contributor agreement

Patchroom is licensed under [Apache-2.0](LICENSE). The future sync server will live in its own repository under the AGPL, with a commercial license available (spec section 10).

Code contributions need a signed contributor license agreement (CLA) before they merge. The CLA keeps your copyright with you and grants the project the right to ship your contribution under its current licenses and the commercial license. The CLA text is being finalized; until it is published here, the project cannot merge outside code contributions. Issues, bug reports and ideas are welcome now.

"Patchroom" and the logo are trademarks and are not covered by the code license (see [NOTICE](NOTICE)).
