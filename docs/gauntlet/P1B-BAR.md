# Gauntlet bar: Patchroom P1b app wiring

Worktree: /Users/NDP/temp/patchroom-wt/p1b-app (branch feat/p1b-app, off dev at e32d666)

## Bar statement

Launching the debug app opens a Homeroom-styled window with a sidebar of DMs. Creating a DM runs the real `claude` through the user's login shell, in a terminal that is byte-for-byte as faithful as iTerm2. Typing, paste, image paste, resize, the permission dialog and the AskUserQuestion picker all work by keyboard exactly as in iTerm2. The DM's presence dot and title follow the session live. State survives an app restart via the store. Patchroom writes none of the user's config files.

## Reference artifacts

- Spec: /Users/NDP/temp/patchroom/docs/SPEC.md (sections 2, 3.1, 8 P1 row)
- Migration checklist: /Users/NDP/temp/patchroom/docs/validation-checklist.md (K1, K2, K4, K5, K7, K8, K9, H3, H4)
- Spike findings: /Users/NDP/temp/patchroom-spikes/FINDINGS.md
- P1 crates (merged): crates/patchroom-pty, crates/patchroom-bridge, crates/patchroom-hook, crates/patchroom-store
- Design: /Users/NDP/temp/patchroom/DESIGN.md, ui/src/theme (Homeroom base is the default)

## IPC contract (fixed, so both pieces build in parallel)

Commands (Tauri invoke):
- `session_create {cwd, command?, args?, name?} -> {id}`. Default command is `claude`. Spawns via patchroom-pty with the bridge's `--settings` and a fresh `--session-id`.
- `session_write {id, data}` (base64), `session_send_text {id, text}`, `session_resize {id, cols, rows}`, `session_kill {id}`, `session_list -> [{id, name, cwd, title, status}]`

Events:
- `pty:output {id, data}` (base64)
- `pty:exit {id, code}`
- `session:title {id, title}`
- `session:status {id, status, needs?}` (status: busy | idle | waiting | exited)

## Pass criteria

### backend (src-tauri/)
1. Implements the IPC contract exactly, with one tokio-safe session manager owning the pty sessions, the bridge server (socket under the app data dir) and the store (wrapped in a Mutex).
2. Output streaming has no dropped or reordered bytes under a 5 MB burst (test). Backpressure never blocks the PTY drain.
3. On app quit, every child and hook process is gone (test or scripted check with `pgrep`).
4. DMs, sections and session ids persist in the store; on relaunch, the DM list returns and an exited session can be resumed with `claude --resume <id>`.
5. A dev-only launch flag (`--open-dm <cwd>`) opens a DM on start, for scripted checks.
6. `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` pass; the macOS Tauri debug build succeeds.

### frontend (ui/src/ excluding ui/src/theme/)
1. Homeroom base by default through the existing theme module. Sidebar with sections and DMs, presence dots and a New DM action (folder picker, defaults to the last cwd).
2. xterm.js with WebGL renderer, Unicode 11 widths (emoji in the status line correct), truecolor, alt-screen, mouse, bracketed paste, Option as Meta, and clipboard image paste forwarded the way iTerm2 does.
3. Fidelity: for a recorded real claude byte stream (captured via the pty crate, committed as a fixture), the xterm.js serialized screen matches a reference emulator (e.g. pyte or vte) cell for cell, with colors, at 120x40 and after a resize to 80x30.
4. Keyboard parity: Shift+Tab, Esc, Esc-Esc, Ctrl+C, Ctrl+R, Ctrl+O, arrows, digits in dialogs, and Shift+Enter newline all reach claude unchanged (asserted against the bytes written, using a mocked IPC in a Playwright test).
5. Impeccable critique passes on the shell UI; no layout shift on resize.

### both (judged on the integrated build)
- Launch the debug app with `--open-dm` in a temp dir. Drive one turn with `--model haiku` that triggers a permission prompt, answer it by keyboard, and confirm the presence dot moves busy, then waiting, then idle. Screenshot the window next to iTerm2 running the same command at the same size, for a human-reviewable comparison.
- Patchroom never writes /Users/NDP/.claude/settings.json, /Users/NDP/.claude.json, /Users/NDP/.bash_profile or /Users/NDP/.zshrc. settings.json and the shell profiles checksum identical before and after. In /Users/NDP/.claude.json, only claude's own entries for the DM's folder change, and nothing references Patchroom, patchroom-hook or the bridge socket. (Reworded 2026-10-14, approved by Noah: claude itself writes .claude.json, as it does in iTerm2.)

## Inspection method

- Rust: fmt, clippy -D warnings, cargo test, `pnpm tauri build --debug`.
- UI: `pnpm -C ui lint`, `pnpm -C ui build`, Playwright tests (fidelity fixture + keyboard parity), impeccable detector.
- Integrated: launch with `--open-dm`, scripted turn, `pgrep` after quit, checksums, window screenshot via `screencapture -l <windowid>`. If Screen Recording permission blocks screencapture, report it as a blocker for that step only and judge the rest.
