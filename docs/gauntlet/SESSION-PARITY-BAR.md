# Gauntlet bar: session safety, terminal-only dialogs, slash commands, status strip

From Noah's first hands-on test of P3, 2026-10-14:
- Two folder sessions he resumed in Patchroom were also running in iTerm.
- Messages he sent and `/usage` "did nothing".
- The status strip shows the same facts twice.

## What went wrong (measured)

- **Two processes per session.** `claude agents --json` showed iTerm pids 94677 and 59477 alongside Patchroom pids 29789 and 33044 on sessions `2744792c` and `178bd88f`.
  - Cause: `live_elsewhere` in `src-tauri/src/manager/folder.rs` reads a cache that is empty on the first listing ("the first call may report none").
  - `folder_session_open` never re-checks before spawning.
- **Input disappeared.** Both Patchroom copies sat at `waitingFor: "dialog open"`. A terminal-only dialog was up, the chat showed nothing, and the composer's text went into the dialog. The transcripts show no new user lines.
- **`/usage` did nothing.** It opens an interactive TUI panel. The chat layer has no item for it, and it did not fall back to the terminal (spec principle 2).
- **The strip doubles up.** The chips row repeats model, folder and cost that the user's own statusLine already prints.

## Checklist

1. **Never two processes on one session.**
   - `folder_session_open`, every resume path and the DM restore on app start re-check `claude agents --json` synchronously (bounded at 3 s) right before spawning.
   - The folder listing never reports "not live" from an empty or stale cache. It shows "checking" until the first result.
2. **Live elsewhere opens as a mirror.**
   - Opening a session that is live in another terminal never spawns anything. It opens a read-only chat mirror from the transcript tail.
   - A banner says where it runs ("Open in another terminal (iTerm)") and the composer is disabled with that reason.
   - "Take over when it closes" resumes it automatically when the other process exits.
   - Patchroom never kills a process it did not start.
3. **Terminal-only dialogs surface.**
   - When the DM's claude waits on something the chat cannot render (`waitingFor` without a bridge prompt, or a TUI dialog detected from the PTY), the chat shows a needs-you banner within 2 s: "Claude is showing something in the terminal". It shows the terminal inline, or one key flips to it (Cmd+J).
   - The sidebar and Activity show needs-you for it.
4. **The composer never swallows input.**
   - While a terminal-only dialog is up, pressing Enter in the composer does not write the text to the PTY. It shows the banner, keeps the draft, and offers "Open terminal".
   - Text sent while claude is busy queues as P2 does today.
   - Every sent message either produces a user item in chat within 3 s or shows why it did not.
5. **Slash commands that open TUI panels fall back to the terminal.**
   - Known interactive commands open the terminal view after sending: `/usage`, `/config`, `/model`, `/status`, `/agents`, `/mcp`, `/resume`, `/permissions`, `/hooks`, `/memory`, `/doctor`, `/context`, `/cost`, `/login`, `/logout`, `/ide`, `/theme`, `/vim`, `/export`, `/help`, `/plugin`, `/bashes`, `/todos`, `/output-style`, `/statusline`.
   - An unknown slash command that produces no transcript item within 2 s, while the PTY repaints, also flips to the terminal with a one-line note.
   - Leaving the panel returns to chat with Esc or Cmd+J.
6. **Status strip without doubles, and customizable.**
   - The strip is a row of modules: the user's own statusLine (verbatim, ANSI) plus chip modules (model, folder or worktree, context, cost, mode, PR, branch).
   - **Defaults:** a chip whose fact already appears in the user's statusLine text is hidden. Only facts the statusLine lacks show by default.
   - A "Customize status bar" menu (right-click on the strip, and in Preferences) lets the user drag modules to reorder, remove them, and add them back from a tray. There is a global default and a per-DM override, and it persists through prefs.
   - The mode chip stays clickable (Shift+Tab cycle).
7. **No regressions.**
   - Gates: cargo fmt, clippy and test; ui lint and build; the full Playwright suite with no assertions loosened; the debug build.
   - The live e2e (`scripts/e2e-live.sh`) is green, with new steps:
     - a session started outside Patchroom is opened from a folder section: no second process (pid check scoped to the run), mirror banner shown
     - a terminal-only dialog shows the banner
     - `/usage` flips to the terminal
     - a composer send during a dialog is not lost

## Inspection

- Rust tests: the open re-check, and mirror mode never spawning.
- Playwright against the mock IPC: banners, composer behavior, the slash fallback list, and the strip modules.
  - Fixture: a statusLine text containing model, folder and cost.
  - Default chips hide those. Customize: drag, remove, add back, persist.
- The live e2e twice, with claude haiku in /tmp. Never open or resume any real session under `/Users/NDP/.claude/projects`.
- Run the /impeccable critique on the banner and the strip.

## Contract: backend (items 1 to 5, 7)

Source of truth: the header of `src-tauri/src/commands.rs`. Tests: `src-tauri/tests/session_parity.rs`.

**Commands**
- `session_resume {id, cols?, rows?}` and `folder_session_open {sectionId, sessionId}`: re-check `claude agents --json` synchronously (3 s bound) right before the spawn.
  - Free: spawn as before.
  - Live elsewhere: spawn nothing. The DM becomes a read-only mirror and the call returns normally.
  - Check failed or timed out: the call fails (`could not check ...`). No DM row is left behind.
- `session_send_text {id, text} -> {outcome}`:
  - `{outcome: "sent"}`: written, claude was idle.
  - `{outcome: "queued"}`: written, claude is busy.
  - `{outcome: "blocked_dialog", reason}`: nothing written, a terminal-only dialog is up. Keep the draft, offer "Open terminal".
  - `{outcome: "mirror_readonly", where, pid}`: nothing written, the session runs in another terminal.
- `session_takeover {id, cols?, rows?} -> SessionInfo`: resume a mirror now. Fails with `still running in <where> (pid N)` while the other process lives. Never kills it.
- `session_mirror_takeover_when_closed {id, enabled}`: resume by itself when the other process exits (the re-check runs again first).
- `session_kill {id}` on a mirror stops mirroring only. `session_resize` on a mirror is a no-op. `session_write` on a mirror fails.

**Data**
- `SessionInfo.mirror: {where, pid, takeoverWhenClosed} | null`. `where` is `iTerm`, `Terminal`, `tmux`, `Ghostty`, ... or `another terminal`.
- `SessionInfo.terminalWait: {reason, since} | null`.
- `folder_sessions` rows add `liveState: "checking" | "live" | "free"` (`liveElsewhere` stays).
  - `checking` until the first answer, and again when the last answer is older than 30 s. Never `free` from an empty cache.
  - `folder:changed` fires when the first answer lands.

**Events**
- `session:mirror {id, mirror}`: mirror started, changed, or ended (`mirror: null`).
- `session:terminal_wait {id, reason, since}`: claude waits on something with no chat prompt. Fires about 0.5 s after a dialog footer draws, or about 1.5 s after a `waiting` status that `claude agents` confirms. `reason` is the CLI's `waitingFor`, else `dialog open`. Fires again if `reason` changes.
- `session:terminal_wait_clear {id}`: the wait ended (answered, or the process exited).
- A terminal wait also sets the persisted needs-you flag, so `session:badges`, notifications and `activity_list` follow. The Activity row reads `Claude is showing something in the terminal: <reason>`.

**Live e2e steps added** (`scripts/e2e-backend.script.js`)
- An outside session opened from the folder section: mirror shown, no `claude --resume <id>` process, send refused.
- Take over when it closes: exactly one process after the other terminal exits.
- A terminal-only dialog (`/model`): `session:terminal_wait`, `blocked_dialog` for the composer text, clear on Esc, the refused text never reaches the transcript.
