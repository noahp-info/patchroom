# Gauntlet bar: Patchroom P3 Slack layer

Worktree: /Users/NDP/temp/patchroom-wt/p3-slack (branch feat/p3-slack, off dev at d7b560d)

## Bar statement

Patchroom moves like Slack. The sidebar has real sections you create, rename, reorder, collapse and drag DMs between, and the layout survives restart. Cmd+K finds any DM in two keystrokes. An Activity view lists everything waiting on you, oldest first, and keyboard jumps reach the next needs-you or unread DM. Search finds text across every Patchroom DM's transcript and opens the exact message. Drafts survive switching DMs and restarting. Messages can be pinned, saved and reacted to; reactions are labels only and never reach the agent. Native notifications and sounds fire once per event, respect per-DM levels and a Do Not Disturb schedule, and never double up with the user's existing sound hooks. A theme picker, custom editor and Slack theme-string paste restyle the whole app live, including each DM's terminal. Every P1, P1b and P2 test still passes.

## Reference artifacts

- Spec: /Users/NDP/temp/patchroom-wt/p3-slack/docs/SPEC.md (sections 3.1, 3.2 drafts/pins/search/reactions, 3.4, 3.5, 8 P3 row)
- Validation checklist: /Users/NDP/temp/patchroom-wt/p3-slack/docs/validation-checklist.md (K4 sounds, K12 notifications, H3 titles)
- Design: /Users/NDP/temp/patchroom-wt/p3-slack/DESIGN.md (Colors, Shipped themes, Slack theme-string import, Components) and the theme engine in ui/src/theme/
- Interaction model: Slack desktop. Sidebar sections, Cmd+K switcher, Activity, message hover bar, Saved items, Preferences > Themes and Notifications.
- The user's real sound hooks: the `hooks` blocks in /Users/NDP/.claude/settings.json (READ ONLY; `afplay` in Stop / TaskCompleted / SessionStart).

## Slack-parity checklist (the judge ticks each)

1. Sections: create, rename, delete (DMs fall back to Direct messages), reorder by drag, collapse. Default sections exist on first run: Starred, Direct messages, Archived. Drag a DM between sections. All of it survives an app restart.
2. Star and archive a DM from its context menu. Archived DMs leave the main list and do not badge.
3. Cmd+K opens a switcher. It fuzzy-matches DM names and folders, ranks recent and needs-you first, and Enter opens the DM. Esc closes it. Fully keyboard driven.
4. Cmd+Shift+A jumps to the oldest needs-you DM. Option+Shift+Down jumps to the next unread DM. Option+Shift+Up goes back.
5. Activity view: one list of every pending prompt (needs-you) and every unread finished turn, oldest first, each opening its DM at the right message. Answering a prompt removes its row.
6. Search (Cmd+F in a DM, Cmd+Shift+F everywhere): full-text over every Patchroom DM's transcript. Results show DM, time and a highlighted snippet. Clicking opens the DM scrolled to the message with the hit highlighted. 40 corpus transcripts index in under 10 s and a query returns in under 200 ms.
7. Drafts: an unsent composer survives switching DMs and an app restart. DMs with a draft show a pencil marker in the sidebar.
8. Message hover bar: Copy, React, Pin, Save. Pins list per DM; Saved lists across DMs. Both survive restart and jump to the message.
9. Reactions: an emoji picker with recent emoji. A reaction is a label on the message, can be filtered on ("show messages with :white_check_mark:"), and is never written to the PTY.
10. Notifications: native macOS notifications for needs-you and turn-complete. Per DM: All, Needs-you only, Mute. No notification for the DM you are looking at while the window is focused. Clicking a notification opens that DM. BEL and OSC 9 / OSC 777 from the terminal become notifications (K12). OSC 0/2 titles set the DM's subtitle (H3).
11. Sounds: one sound per event (needs-you, turn complete, message, error), a volume control, per-DM override and a test button. Sounds are synthesized or MIT/CC0 with the license file committed.
12. Do Not Disturb: manual toggle plus a schedule (days, start, end, crossing midnight). DND suppresses Patchroom notifications and sounds; needs-you badges still update.
13. No double sounds: Patchroom reads the user's Claude settings (read only) and detects command hooks that play audio (`afplay`, `say`, `paplay`, `osascript ... beep`) per event. For each detected event the default is "Keep yours": Patchroom stays silent for that event. The user can switch to "Play both". The settings screen shows what was detected. Patchroom never edits the hook.
14. Themes: Preferences shows a picker with the four shipped themes and a light/dark/system switch. A custom editor edits tokens with live preview and rejects AA failures with the failing pair named. Pasting a Slack theme string imports it as a new theme. The chosen theme persists across restart and restyles the open terminals live.
15. Per-DM terminal palette and font, chosen from the DM's settings, applied live without restarting the session.
16. Folder sections, exactly as specified in /Users/NDP/temp/patchroom-wt/p3-slack/docs/gauntlet/P3-FOLDER-SECTIONS.md. Its behavior, IPC additions and pass checks are part of this bar. Backend owns discovery, naming, the watcher and the commands; workspace owns the UI.

## Pass criteria

- Every checklist item above is demonstrated, not claimed.
- No user config file changes (checksum the same file set as P1b, before and after the judge's run).
- No new network listener (`lsof -iTCP -sTCP:LISTEN` for the app's pid is empty).
- Search reads only transcripts of Patchroom DMs by default. Indexing other Claude Code sessions is a setting that defaults to off. The index lives in the app data dir and is deleted with its DM.
- fmt, clippy -D warnings, cargo test, `pnpm -C ui lint`, the full Playwright suite and the macOS debug build pass. The CI workflow stays green.
- Design: every new surface uses theme tokens only (No Color In CSS Rule) and holds up in all four shipped themes, light and dark.

## IPC contract additions (fixed, so pieces build in parallel)

P1b and P2 commands and events stay unchanged. Pins, saves and reactions anchor to a chat item by `(conversationId, itemKey)`, since P2 items come from the transcript, not the `message` table. Store migration 0003 adds `item_mark {id, conversation_id, item_key, kind: pin|saved|reaction, emoji?, snapshot}` with `UNIQUE(conversation_id, item_key, kind, emoji)`. `snapshot` is up to 280 chars of the item's text, for lists.

Commands:
- `section_rename {id, name}`, `section_delete {id}`, `section_reorder {ids: string[]}`
- `session_reorder {sectionId: string|null, ids: string[]}` (move plus order, one call)
- `session_set_flags {id, starred?, archived?}`
- `draft_get {id} -> {body}`, `draft_set {id, body}` (empty body deletes)
- `mark_add {id, itemKey, kind, emoji?} -> MarkInfo`, `mark_remove {id, itemKey, kind, emoji?}`, `mark_list {id?, kind?} -> MarkInfo[]` (no id = across DMs)
- `search {query, scope?: {id?}, limit?} -> {hits: [{id, itemKey, ts, kind, snippet, ranges: [[start,end]]}], tookMs}`
- `search_reindex {}` -> `{docs, tookMs}`
- `chat_locate {id, itemKey} -> {before: string|null}`: a `chat_history` cursor whose page contains the item, so the UI can open a DM at a message.
- `activity_list {} -> [{id, kind: "prompt"|"unread", ts, promptId?, itemKey?, summary}]`
- `prefs_get {} -> Prefs`, `prefs_set {patch: Partial<Prefs>} -> Prefs`
- `sound_hooks_detect {} -> [{event, command, source}]` (read only)
- `notify_test {}`

`Prefs` = `{themeId, mode: "light"|"dark"|"system", customThemes: Theme[], notify: {default: "all"|"needs"|"mute", perDm: {[id]: level}}, sound: {enabled, volume, perEvent: {[event]: {on, sound}}, perDm: {[id]: "default"|"mute"}, hookPolicy: {[event]: "keep"|"both"}}, dnd: {manual: boolean, schedule: {days: number[], start: "HH:MM", end: "HH:MM"} | null}, termPerDm: {[id]: {themeId?, font?, fontSize?}}, searchAllSessions: boolean}`

`SessionInfo` gains `starred`, `archived`, `hasDraft`, `title?` (from OSC 0/2).

Events:
- `notify:fire {id, event: "needs"|"done"|"message"|"error"|"bell", title, body}`: the backend decides (levels, focus, DND, hookPolicy) and posts the native notification itself. The UI uses this event only to play the sound, so sound and notification share one decision.
- `session:title {id, title}`
- `prefs:changed {prefs}`
- `activity:changed {}`

The backend sends native notifications with `tauri-plugin-notification` and opens the DM on click. The frontend plays sounds with Web Audio.

## Pieces

### backend (crates/, src-tauri/)
Store migration 0003 and every command and event above. Full-text search with SQLite FTS5 over Patchroom DMs' transcript text, kept current from the P2 tail. Activity list. Notification decision (levels, focus, DND schedule in local time, hookPolicy) plus native notifications and click-to-open. BEL / OSC 9 / OSC 777 / OSC 0 / OSC 2 parsing from the PTY stream without changing the bytes xterm receives. Read-only sound-hook detection. Prefs persisted in `setting`. Tests for every command, the DND time math (midnight crossing, DST), the hook detector against fixture settings, and search latency over the corpus.

### workspace (ui/src/ excluding ui/src/theme/ and ui/src/components/prefs/, plus ui/tests/ files prefixed `ws-`)
Sections and drag and drop, star and archive, Cmd+K, keyboard jumps, Activity view, search UI (in-DM and global), open-at-message, drafts, hover bar, reactions and filter, pins and Saved lists. Mounts the prefs pane and wires sound playback from `notify:fire`. Owns App.tsx and ui/src/ipc/ (adds the contract types and mocks).

### prefs (ui/src/theme/, ui/src/components/prefs/, ui/src/sound/, ui/tests/ files prefixed `prefs-`)
Preferences window: theme picker, light/dark/system, custom token editor with AA validation, Slack string paste, per-DM terminal palette and font, notification levels, sounds (synthesized pack, volume, per event, per DM, test), DND toggle and schedule, the detected-hooks table with Keep yours / Play both. Exports `<PrefsPane>`, `playSound(event)` and `applyTerminalTheme(term, dmId)` for workspace to call. Uses IPC types from ui/src/ipc/types.ts as written in this contract; if workspace has not added them yet, prefs declares them in ui/src/components/prefs/ipc.ts and workspace reconciles in the smoothing pass.

## Inspection method

- Run `cargo test --workspace`, `pnpm -C ui lint` and the full Playwright suite in the worktree.
- Build the debug app and drive it with the in-app e2e runner (`scripts/e2e-live.sh`, debug only) against `claude --model haiku` in a /tmp folder with its own `PATCHROOM_DATA_DIR`. Scope every process check to that data dir. Restart the app mid-script to check persistence.
- Screenshot each new surface in all four themes, light and dark (Playwright against the mock IPC is fine).
- For notifications and sounds, read the backend's notification decision log and the UI's sound log when the screen is locked; if the screen is unlocked, also look.
- Checksum the user config files before and after.
