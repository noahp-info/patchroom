# Patchroom

Patchroom is a Slack-style desktop app for the AI coding CLIs you already use. Every DM is a real terminal session (the actual CLI in a real PTY, started from your login shell), and a chat layer renders on top of it. Patchroom adds no agent, no model access, and no new permissions. Claude Code comes first, macOS first.

**Status: pre-alpha.** This repo is a scaffold. Nothing is usable yet. Read the design in [docs/SPEC.md](docs/SPEC.md).

## Dev setup

Requirements: macOS, Xcode command line tools, Rust (stable, via [rustup](https://rustup.rs)), Node 22+, and pnpm (via corepack).

```bash
corepack enable
pnpm install
pnpm tauri dev          # run the app with hot reload
```

Checks (the same ones CI runs):

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm -C ui lint
pnpm -C ui build
pnpm tauri build --debug   # full debug bundle
```

Enable the local git hooks once per clone: `bash scripts/setup-hooks.sh`.

## Layout

| Path | What |
|---|---|
| `src-tauri/` | Tauri app shell (thin) |
| `crates/patchroom-core/` | session host, bridge, store, adapters, plugin host |
| `crates/patchroom-hook/` | binary that forwards CLI hook JSON to the bridge socket |
| `ui/` | React + TypeScript + Vite frontend, xterm.js terminal |
| `plugins/` | first-party plugins (to come) |
| `docs/` | spec and validation checklist |

## License

[MIT](LICENSE)
