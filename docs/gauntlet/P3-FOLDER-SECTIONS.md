# P3 addendum: folder sections (checklist item 16, joins the bar at wave 2)

Requested by the owner on 2026-10-14.

## Behavior

1. **Two section kinds.** A plain section is organizational only. A folder section has a home folder, picked with the folder picker ("New section from folder...").
2. **Discovery.** A folder section lists every resumable Claude Code session whose launch folder is the home folder or inside it (worktrees under `.claude/worktrees/`, subfolders). Each subfolder or worktree session shows a small chip with its relative path. Linked git worktrees outside the folder (from `git worktree list`) count too.
3. **Lazy DMs.** A discovered session is a row, not a running process. Nothing spawns until the user opens it. Opening runs `claude --resume <sessionId>` from the session's launch folder (the folder its transcript is filed under), through the login shell like any DM. From then on it is a normal DM in that section.
4. **Already running elsewhere.** If `claude agents --json` shows the session live in another terminal, the row says so. Opening it asks first, because two processes on one session corrupt it.
5. **Names**, first match wins:
   1. a name the user set in Patchroom
   2. the newest entry for that session id in `~/.claude/.state/session-names.jsonl` (the session-naming registry, read only)
   3. the newest `custom-title` line (from `/rename`)
   4. the newest `ai-title` line
   5. the first real user prompt, cut to 60 characters
6. **Sort.** Open DMs that need you come first, then busy ones. The rest follow by last activity, newest first, using the newest transcript timestamp rather than file mtime. Each row shows relative time, the branch or worktree, and the last-prompt snippet on hover.
7. **Noise filter.** Sessions with no real user prompt are hidden behind a "Show N hidden" toggle: `-p` runs, hook-only runs, empty starts and subagent sidechains.
8. **Older dropdown.** Sessions with no activity in X days collapse into "Older than X days (N)" at the bottom of the section. X defaults to 14 and is set per section in the section menu. Older sessions stay reachable from Cmd+K and search.
9. **Live refresh.** A filesystem watch on the matching `~/.claude/projects/<encoded>/` dirs adds new sessions within 2 s, including ones started in iTerm. "Hide" removes a row from the list only; the transcript file is never touched.
10. **New DM in a folder section** starts in the home folder by default. The dialog can switch to a worktree under it.
11. **Drag across folders.** A DM keeps its own folder forever. A running process cannot change its cwd, and `--resume` must start from the launch folder. Section membership is filing only. Dropping a knowfirst DM into the proQueue section is allowed. The DM then shows a folder chip ("knowfirst") so it is obvious it does not run in proQueue's folder. The drop never respawns, moves or rewrites anything.
12. **Read only.** Discovery reads transcripts, the registry and git metadata in place. It writes nothing under `~/.claude` and copies no transcript text except into the existing search index for DMs the user opened.

## IPC additions

- `section_create_from_folder {path, name?} -> Created`; `SectionInfo` gains `folder: string|null`, `archiveDays: number`
- `section_set_archive_days {id, days}`
- `folder_sessions {sectionId} -> {sessions: [{sessionId, name, nameSource, launchCwd, relPath, branch?, lastActivity, firstPrompt, lastPrompt, userTurns, liveElsewhere, hidden, dmId?}], hiddenCount}`
- `folder_session_open {sectionId, sessionId} -> SessionInfo` (creates the DM row and spawns the resume)
- `folder_session_hide {sectionId, sessionId, hidden}`
- event `folder:changed {sectionId}`
- `SessionInfo` gains `folderChip: string|null` (set when its cwd is outside its section's folder)

## Pass checks

- Synthetic fixture of 300 sessions across a folder, two worktrees and a sidechain: the list builds in under 300 ms, and sort, noise filter, older-than-X split and every name source are tested.
- Live: create a section from a /tmp git repo that has 3 haiku sessions (one renamed with `/rename`, one older than X via a fixture timestamp). Names are right, the old one sits in the dropdown, and opening one resumes it with its history in chat.
- A session started outside Patchroom in the same folder appears within 2 s.
- Drag a DM from another folder in: the chip shows, and the process is not restarted (same pid).
- Real data, read only: a folder section on /Users/NDP/temp/gamerNetworking lists its sessions, worktree sessions included. Checksums of the user config files are unchanged.
