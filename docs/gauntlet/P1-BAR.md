# Gauntlet bar: Patchroom P1 Core + design system

Worktree: /Users/NDP/temp/patchroom-wt/p1-core (branch feat/p1-core, off dev)

## Bar statement

Each crate is production-grade Rust that a reviewer would merge as-is. It is proven by its own tests, which exercise the real behavior: real PTYs, real unix sockets, a real SQLite file, and the real `claude` CLI where noted. It encodes every finding in the spike. `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` pass with zero warnings. Public APIs are small, documented, and usable by the Tauri shell in the next wave without changes. The design system makes the default Homeroom base indistinguishable from the Homeroom mock in the reference. It makes Patch Bay a faithful second base. Any color theme must apply to either base by swapping tokens only, and it must pass the impeccable anti-slop critique.

## Reference artifacts (real, on disk)

- Spec: /Users/NDP/temp/patchroom-wt/p1-core/docs/SPEC.md (sections 2, 3.5, 4, 5, 8)
- Migration checklist: /Users/NDP/temp/patchroom-wt/p1-core/docs/validation-checklist.md (K1, K2, K5, K7, K8, K9, H4)
- Spike findings with byte-level evidence: /Users/NDP/temp/patchroom-spikes/FINDINGS.md, harness in /Users/NDP/temp/patchroom-spikes/harness/
- Design reference (Homeroom = direction A, Patch Bay = direction D): /Users/NDP/temp/patchroom-design/looks.html
- Adapter research: /Users/NDP/temp/patchroom-wt/p1-core/docs/research/cli-adapter-surfaces.md

## Pass criteria

### pty (crates/patchroom-pty)
1. Spawns any command through the user's login shell (`$SHELL -l -c`), so PATH matches a fresh iTerm tab. A test proves `node`, `gh` and `git` resolve.
2. Strips inherited `CLAUDE*` env vars, sets `TERM=xterm-256color` and `COLORTERM=truecolor`, and sets `PATCHROOM_TTY` / `PATCHROOM_SESSION` for scripts.
3. Continuous non-blocking drain to a byte stream (channel or callback). Resize (SIGWINCH). Clean kill with no orphaned processes (test asserts it).
4. `send_text` uses bracketed paste, then a separate Enter after a configurable delay (default 400ms). `send_keys` covers the V3 byte map (arrows, Enter, Esc, Tab, digits).
5. Parses OSC 0/1/2 titles, OSC 9 and OSC 9;4 progress out of the stream into typed events, without altering the bytes passed to the terminal.
6. An integration test runs the real `claude --version`, and a gated (`--ignored`) test runs an interactive `claude --model haiku --setting-sources local` session, sends a prompt and sees a reply.

### bridge (crates/patchroom-bridge + crates/patchroom-hook)
1. Unix socket server at a configurable path, created with mode 0600 (test asserts it). Newline-delimited JSON protocol, versioned.
2. `patchroom-hook` binary: reads hook JSON on stdin, forwards it, and waits a bounded time for a decision. It always exits on its own (decision, timeout, bridge cancel, or bridge absent) and fails open: no decision means the TUI proceeds. It never relies on SIGTERM.
3. Per-prompt arbiter, first answer wins. PermissionRequest: a chat answer returns allow/deny; a TUI answer (detected via PostToolUse or transcript) cancels the pending hook. AskUserQuestion via PreToolUse: returns `updatedInput` with `answers`, and releases to the TUI after a bounded wait (default 30s, configurable).
4. Generates the per-launch `--settings` JSON that registers the hook binary for PermissionRequest, PreToolUse (AskUserQuestion), PostToolUse, Notification, Stop, UserPromptSubmit and SessionStart. It never touches user settings files.
5. Status events (busy, idle, needs-you with kind) are emitted from hook traffic, plus a `claude agents --json` reconciler filtered by pid/sessionId.
6. A gated real-claude integration test answers one permission prompt and one AskUserQuestion from the bridge side. The answer lands in the transcript, and no hook process is left running.

### store (crates/patchroom-store)
1. SQLite (bundled) with versioned migrations covering the section 5 data model. Every row has a ULID id, author, created_at and updated_at.
2. A typed repository API for workspaces, sections (ordering), conversations, memberships, messages, comments (message id + text range), tasks, claims, reactions, pins, drafts, plugins and settings.
3. WAL mode, foreign keys on, and a migration test from an empty DB. Property or round-trip tests for every entity.
4. Nothing in the schema stores secrets. Data lives under the app data dir path the caller passes.

### design-system (DESIGN.md, ui/src/theme/, plugins/themes/, ui/theme-preview/)
1. DESIGN.md documents the two layers: base (layout, density, type, chrome, base-only elements) and color theme (palette tokens, light + dark), plus the token list and the rules for creating a theme.
2. Theme JSON schema plus loader/validator in TypeScript. Slack theme-string import maps to tokens. Themes ship as data-only plugins in plugins/themes/ (Homeroom default palette, Patch Bay palette, and at least one more).
3. Bases implemented as CSS (custom properties + base classes): Homeroom (default) and Patch Bay. Scrollback and Blue Pencil are defined as stubs to finish later.
4. ui/theme-preview/ renders the reference screen (sidebar with sections, presence and badges, a DM with a tool call, an AskUserQuestion widget, a composer with chips, Stop and status strip, an artifact pane) for any base x theme x light/dark combination.
5. Visual match: Homeroom light and dark screenshots are a near-match to direction A in the reference, and Patch Bay to direction D. Swapping a color theme changes only colors on either base.
6. Passes the impeccable critique (detector clean, no slop patterns). Contrast is WCAG AA for text in all shipped themes.

## Inspection method

- **Rust pieces:** in the worktree, run `export PATH=$HOME/.cargo/bin:$PATH`; `cargo fmt --check`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo test -p <crate>`; then `cargo test -p <crate> -- --ignored` for the real-claude tests. Read the public API and docs against the criteria. Check criteria the tests don't cover by reading the code (e.g. env stripping, 0600 mode, hook self-exit paths). Afterwards confirm no stray `claude` or `patchroom-hook` processes (`pgrep -fl`).
- **Design system:** run `pnpm -C ui build`, serve ui/theme-preview, and screenshot Homeroom and Patch Bay in light and dark, plus one alternate theme on each base, using Playwright. Compare side by side with screenshots of the matching sections of /Users/NDP/temp/patchroom-design/looks.html. Run the impeccable detector and critique. Check contrast.
