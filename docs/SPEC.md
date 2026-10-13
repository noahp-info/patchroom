# Patchroom: spec v0.1 (draft for review)

Status: draft, 2026-10-13. Owner: Noah. License: MIT. Platform: macOS first.

Patchroom is a Slack-style desktop app on top of the AI coding CLIs you already use. Every DM is a real terminal session. A chat layer renders on top of it. Patchroom adds no agent, no model access, and no new permissions.

## 1. Principles

1. **Wrapper, not replacement.** Each session is the real CLI in a real PTY, started from your login shell. Patchroom inherits your permissions, env, PATH, and config.
2. **Parity is non-negotiable.** Anything the chat layer can't render falls back to the live terminal inline. No CLI feature is ever lost.
3. **Invent as little as possible.** Reuse each CLI's own hooks, transcripts, statusline and resume. Reuse Claude Code's plugin marketplace format. Reuse Slack's interaction model.
4. **Never edit user config.** Patchroom injects its hooks per launch (Claude Code: `--settings <json>`). It reads settings files in place and never copies or rewrites them.
5. **Local only.** No network listeners. The hook bridge is a unix socket owned by the user. No telemetry.
6. **Sync-ready data.** Local SQLite with stable IDs and authorship, so teammate sync can come later without a rewrite.

## 2. Architecture

```
Tauri app (Rust core + web UI)
├─ Session host     portable-pty per DM, spawns `$SHELL -l -c '<cli> <args>'`
│                   xterm.js renders the live terminal (inline or full pane)
├─ Hook bridge      unix socket at ~/Library/Application Support/Patchroom/bridge.sock
│                   tiny `patchroom-hook` binary forwards hook JSON to it and
│                   relays decisions back (permission answers, AskUserQuestion answers)
├─ Adapters         one per CLI; two backends:
│                     A. PTY + hooks + transcript tail   (Claude Code, Codex)
│                     B. ACP/HTTP structured + PTY view  (Cursor, Gemini, Copilot, opencode)
├─ Chat layer       renders adapter events as messages, tool calls, threads, widgets
├─ Store            SQLite: workspaces, sections, conversations, messages, comments,
│                   tasks, claims, reactions, pins, drafts, plugin state
└─ Plugin host      sandboxed webviews + capability-gated message API
```

**Claude Code adapter (v1, full fidelity):**
- **Chat:** tail the session transcript JSONL. Map assistant text, tool_use, tool_result, subagent sidechains (shown as threads), AskUserQuestion, and plan approvals.
- **Status:** hooks first (UserPromptSubmit = busy, Stop = idle, Notification permission_prompt / agent_needs_input = needs you). `claude agents --json` reconciles every 10s.
- **Native widgets:** a PermissionRequest hook and an AskUserQuestion PreToolUse hook go through the bridge. If you answer in chat, the hook returns the decision. If you answer in the terminal, or the bridge has no client, the hook returns no decision and the TUI dialog proceeds. Verification item V1 confirms the hand-off has no race.
- **Status strip:** the user's own `statusLine` command runs unchanged, and its output renders verbatim. A wrapper tees the statusLine stdin JSON to the bridge for structured chips (model, context %, cost, mode, worktree, PR).
- **Inject a message:** PTY write with bracketed paste. Never `claude -p --resume` against a live session.

**Other adapters (v1, best effort):** Cursor, Gemini and Copilot via ACP; opencode via HTTP; Codex via hooks + rollout tail. Each DM shows a fidelity badge: **Full** (native chat, status, prompts) or **Terminal** (raw terminal plus basic status from OSC 9 / BEL). An ACP-driven DM has no TUI to show, so the fallback for those is "reopen in terminal mode" (same session resumed in the CLI's TUI).

## 3. Features (v1)

Every feature lists its acceptance check.

### 3.1 Workspace and sidebar
- **Sections:** create, rename, reorder, collapse; drag DMs and channels between them. Default sections: Starred, Channels, DMs, Archived. *Check: state survives restart.*
- **DM = one session.** New DM: pick folder, provider (dropdown of CLIs onboarding found installed and signed in, with fidelity badge), optional worktree, optional name. *Check: Claude and Cursor DMs coexist.*
- **Presence dot:** busy, idle, needs you, errored, stopped. *Check: matches `claude agents --json` within 2s of a hook event.*
- **Unread badge** on new assistant output since last view; **needs-you badge** (red) persists until answered, not merely viewed.
- **Cmd+K quick switcher**, Cmd+Shift+A jump to next needs-you, Option+Shift+Down next unread.
- **Activity view:** a single inbox of everything waiting on you, oldest first.

### 3.2 Messages and steering
- Chat view of the session: messages, collapsible tool calls, subagents as threads, diffs inline.
- **Highlight-to-comment (app-wide):** highlight any text anywhere in the app (an artifact, an agent message, or your own message) and right-click. The menu offers Comment, plus Copy, Search and Add to task. Comment adds a new line to the composer, linked to the highlighted source: click the line to jump back, and the source stays marked. Edit or delete lines freely; nothing changes or sends until you press Send. Sent as `> quote` plus your comment, per line.
- **Screenshot-to-steer:** press Cmd+Shift+2 or the toolbar button, then drag to select any region of the app. A note box opens anchored right at the selection; type your steer there. Check inserts the screenshot and note into the next message as one linked line; X cancels and discards both. Nothing sends until you press Send.
- **Quick steer:** contextual reply chips above the composer (e.g. Approve plan, Revise, Show diff, Retry) prefill the composer and never auto-send. A persistent Stop button interrupts (same as Esc). Every message has a hover bar: Retry from here (fork), Thread, Copy, Pin, Save. Commenting is not on this bar; it lives in the app-wide highlight flow. Emoji reactions are labels only, filterable and never sent to the agent.
- **Native prompt widgets:** permission (Allow / Deny / Always), AskUserQuestion (options, multi-select, notes, Other), plan approval.
- **Drafts** persist per conversation. **Pins** and **Saved for later**. **Full-text search** across all transcripts.
- **Terminal toggle:** every DM can flip to the full live terminal (Cmd+J) or show it inline when the chat layer can't render something.

### 3.3 Status strip
- Renders the user's existing statusLine output verbatim under the composer.
- Structured chips from statusLine JSON: model, context %, cost, permission mode (click cycles, same as Shift+Tab), worktree, PR link.
- Plugins can add chips (CI budget, rate limits).

### 3.4 Notifications and sounds
- Native macOS notifications for needs-you and turn-complete, per conversation: all, needs-you only, mute.
- **Sound packs** per event (needs-you, turn complete, message, error), per-conversation override, volume, Do Not Disturb with schedule.
- Coexists with existing hook sounds (e.g. `afplay` in Stop hooks): onboarding detects them and offers to keep them, replace them with Patchroom sounds, or play both.

### 3.5 Themes
- Slack-style theme picker with presets, a custom editor, and **Slack theme-string paste** (Slack's comma-separated color format) for import.
- Terminal palette and font per DM (replaces the `cc` launcher's random iTerm profile and `/color`).
- `PATCHROOM_TTY` / Patchroom control socket lets scripts set title and theme for their own DM (replaces OSC 1337 SetProfile and AppleScript tty lookups). Also honor OSC 0/1/2 titles and OSC 9/777 notifications.

### 3.6 Artifacts (in app, not the browser)
- **Local files:** HTML, images, PDF, video, markdown, diffs, opened in a side pane from any path in chat.
- **Dev servers:** localhost previews detected from output, opened in a live webview pane.
- **claude.ai Artifacts:** opened in an in-app webview with the user's claude.ai login (cookie store in the app).
- **Mobile simulators:** iOS Simulator and Android emulator mirrored into a pane (window capture), with click-through.
- All artifact panes support screenshot-to-steer.

### 3.7 Channels (multi-agent)
- A channel is a room. Existing DMs join it with their name and avatar. Each keeps its own context and its own git worktree.
- **Channel references from a DM:** `#channel` in a DM composer attaches the channel's task board and recent decisions as context.
- **Task board (canvas)** pinned in each channel. Cards: title, owner, status (To do, Claimed, Working, Blocked, Review, Done), worktree, branch, PR.
- **Three assignment modes, per channel:**
  1. *Board + claim:* agents claim cards visibly.
  2. *@mention assigns:* you assign directly.
  3. *Lead dispatches:* one lead agent breaks work down and assigns.
- **Overlap prevention:** one worktree per agent; file/area claims shown on cards; conflicting claims flagged before merge.
- **Start / stop / resume** per card and per channel: start = inject the task into the owner's DM; stop = interrupt; resume = `--resume` the owner's session.
- **Mechanism:** a Patchroom MCP server (exposed through the bridge) gives agents `room_read`, `room_post`, `task_list`, `task_claim`, `task_update`, `claim_paths`. Agents learn the protocol from a channel prompt injected on join. Loop guard pauses agent-to-agent chains after N hops.

### 3.8 Onboarding
1. Detect terminals: iTerm2, Terminal.app, VS Code / Cursor, Warp, Ghostty.
2. Detect CLIs and sign-in status: Claude Code, Codex, Cursor, Gemini, Copilot, opencode.
3. Scan for terminal-coupled customizations (launch aliases, theme scripts, title scripts, sound hooks, statusline) and show **Keep / Replace / Skip** for each.
4. Import theme, font, and keybindings from the chosen terminal.
5. Offer to bring in running sessions: list them from `claude agents --json`; the user closes them in the old terminal, then Patchroom resumes them.
6. Run the validation self-test (section 6) and show pass/fail.

### 3.9 Plugins
- **Format:** Claude Code plugin marketplace layout (git repo with `marketplace.json`), plus a `patchroom` block in the plugin manifest for app parts. One plugin can ship Claude Code parts (skills, hooks, MCP) and Patchroom parts.
- **Contribution points:** sidebar items, panes, message renderers, artifact viewers, status chips, slash commands, reactions, importers, adapters, theme packs, sound packs.
- **Trust tiers:** data-only (themes, sounds) install with no prompt. Code plugins run in a sandboxed webview with declared capabilities, approved on install. No native code; native work goes through MCP.
- **Dogfood:** themes, sound packs, importers, artifact viewers and non-Claude adapters ship as first-party plugins.
- **Build-your-own:** "Create plugin" opens a DM with a scaffold; hot reload; publish to a marketplace repo.

## 4. Security posture (kept deliberately small)

- Patchroom runs CLIs as the user, exactly as a terminal does. It grants nothing the terminal doesn't.
- No TCP listeners. Bridge socket is `0600` in the user's Application Support folder.
- Never writes the user's CLI settings. Hooks are injected per launch.
- Never stores secrets. The claude.ai webview cookie store is the only credential state, scoped to the app.
- Plugins: sandboxed webviews, capability manifest, no native code.
- Bridge timeouts fail open to the CLI's own TUI (the CLI decides, as it would without Patchroom).

## 5. Data model (sketch)

`workspace`, `section`, `conversation` (kind dm|channel, provider, cwd, worktree, session_id, adapter state), `membership` (channel to dm), `message` (mirrored from transcript, plus Patchroom-only items like comments), `comment` (anchor: message id + text range), `attachment`, `task`, `claim`, `reaction`, `pin`, `draft`, `plugin`, `setting`. All rows: ULID id, `author` (human or agent ref), `created_at`, `updated_at`.

## 6. Validation suite

`docs/validation-checklist.md` lists the maintainer's terminal dependencies and a 10-step test order. Each item becomes an automated or scripted test. Migration from iTerm2 is "done" when all pass.

## 7. Verification items (resolve before or during phase 1)

- **V1** PermissionRequest / PreToolUse bridge vs. TUI dialog: confirm the hook answering path and the TUI fallback don't race or double-prompt.
- **V2** `waitingFor` on plain interactive sessions in `claude agents --json`.
- **V3** TUI keystroke maps for permission and AskUserQuestion dialogs (fallback path).
- **V4** Whether `agentPushNotifEnabled` emits BEL / OSC 9 that Patchroom must forward.
- **V5** Codex rollout schema and app-server approval methods.
- **V6** Claude Code's `plugin-authoring` mod format: align Patchroom pane/toast/status contributions with it where possible.
- **V7** Window capture permission flow for simulator mirroring (macOS Screen Recording prompt).

## 8. Build plan (gauntlet)

Phases are ordered by dependency. Each phase is a gauntlet loop: parallel builders, blind context-free judges, loop until the bar passes. Each phase lands as one PR to `main`.

| Phase | Pieces | Quality bar (judge must confirm all) |
|---|---|---|
| P1 Core | Tauri shell, PTY session host, login-shell spawn, xterm.js, hook bridge, `patchroom-hook`, SQLite store | Validation items K1, K2, K4, K5, K7, K8, K9 pass on macOS; Claude Code TUI indistinguishable from iTerm2 in a side-by-side capture; no user config file modified (checksum before/after) |
| P2 Chat layer | Claude Code adapter, chat render, status/presence, unread + needs-you, native widgets, terminal toggle, status strip | Every message type in 40 real transcripts renders or falls back; AskUserQuestion and permission answered from chat and from terminal; needs-you badge persists until answered |
| P3 Slack layer | Sections, Cmd+K, activity, search, drafts, pins, reactions, notifications, sounds, themes + Slack theme import | Slack-parity checklist; DND schedule works; no double sounds with existing hooks |
| P4 Steering + artifacts | Highlight-comment, screenshot-to-steer, artifact panes (files, dev servers, claude.ai, simulators) | Comments never send before Send; screenshot to composer in under 2s; each artifact type opens in app |
| P5 Channels | Rooms, MCP room tools, task board, three assignment modes, worktree + claims, start/stop/resume, loop guard | Two agents in one channel complete two tasks without touching each other's claimed paths; all three modes demoed |
| P6 Plugins + adapters + onboarding | Plugin host, marketplace install, first-party plugins, Cursor/Gemini/Copilot/opencode/Codex adapters, provider dropdown, importers | A third-party plugin installs from a git URL and adds a pane; mixed-provider channel works; fresh-Mac onboarding under 5 minutes |

## 9. Open decisions for Noah

- **D1** GitHub repo owner (personal account vs an org) and domain registration (patchroom.dev / patchroom.app).
- **D2** Gauntlet budget per phase (iterations cap and model tier for builders vs judges).
