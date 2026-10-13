# Migration validation checklist (from iTerm2)

Source: read-only scan of the maintainer's Claude Code setup on 2026-10-13. Patchroom must pass every item before a user can drop iTerm2. Env var names only; no values.

## Hard terminal couplings (need a Patchroom replacement)

| # | Item | What it does today | Patchroom requirement |
|---|---|---|---|
| H1 | `cc` launcher (shell alias claude=cc) | Random iTerm profile per session, syncs Claude UI theme, tiles the window via System Events, emits OSC 1337 SetProfile, then `command claude "$@"` | Native per-DM theme/font assignment, window/pane tiling, Claude UI theme sync before launch. Spawn the real `claude` binary, never the alias. |
| H2 | `/color` command (`cc_set_theme.sh`) | Finds the iTerm tty via AppleScript, writes OSC 1337 SetProfile | Equivalent live theme switch per DM (OSC handler or Patchroom CLI/socket). Fail gracefully if unsupported. |
| H3 | Window title in session-naming script | iTerm-only: AppleScript tty lookup, then OSC 2 | Honor OSC 0/1/2. Also watch the session-name registry and title the DM from it. |
| H4 | Bash tool has no controlling tty | Scripts write escape codes to the iTerm tty device | Expose a write-to-my-terminal path, e.g. `PATCHROOM_TTY` env or a local socket. |

## Must keep working (terminal-agnostic, but easy to break)

| # | Item | Requirement |
|---|---|---|
| K1 | Login-shell env | Spawn via login shell so nvm Node, gh, aws, terraform, Android/Java vars resolve. Real config lives in `.bash_profile`, not `.zshrc`. |
| K2 | Fullscreen TUI | Truecolor, alt-screen, SIGWINCH resize, mouse, bracketed paste. `TERM=xterm-256color`, `COLORTERM=truecolor`. |
| K3 | Status line | Render emoji with correct width. Pass env through (`ANTHROPIC_BASE_URL`). |
| K4 | Sound hooks | SessionStart / TaskCompleted / Stop run `afplay` from a normal user process. No double fire. Test with the window unfocused. |
| K5 | Hook protocol | PreToolUse allow/deny decisions honored without prompting. Long PostToolUse hooks (CI watch, up to 600s) show `statusMessage` and never hang the UI. |
| K6 | Interactive pickers | AskUserQuestion (~100 uses in 40 sessions: arrows, Enter, numbers, Tab notes, free-text Other), ExitPlanMode approval, tool permission prompts. |
| K7 | Keys | Shift+Tab mode cycle, Esc and Esc-Esc, Ctrl+C, Ctrl+R, Ctrl+O, arrows, Option as Meta, Shift+Enter newline. |
| K8 | Images | Ctrl+V image paste and file drag-drop (~800 image blocks in 40 sessions). |
| K9 | Resume | `--resume` / `-c` fire the SessionStart resume matcher; `/clear` and `/compact` work. |
| K10 | Alternate launchers | Allow `ccr code ...` (local model router) as the child command. |
| K11 | URL open | `open <url>` works for OAuth flows (plugins). |
| K12 | Notifications | Translate BEL and OSC 9/777 into native notifications. Verify what `claude` emits with push notifications enabled. |

## Test order

1. Login-shell env inside a Bash tool call (`node -v`, `echo $PATH`).
2. Fullscreen TUI fidelity and status line.
3. AskUserQuestion, ExitPlanMode, permission prompts by keyboard and by native chat widget.
4. Sounds: single fire per event.
5. Session auto-name reaches the DM title.
6. Theme switch replacement for `/color`.
7. Paste, drag-drop, key chords.
8. Resume, `/clear`, `/compact`.
9. Long-running hook with status message.
10. Notification passthrough.
