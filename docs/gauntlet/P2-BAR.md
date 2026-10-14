# Gauntlet bar: Patchroom P2 chat layer

Worktree: /Users/NDP/temp/patchroom-wt/p2-chat (branch feat/p2-chat, off dev at 77194b4)

## Bar statement

A Claude DM opens as a chat, not a terminal. Every line of a real Claude Code transcript renders as a chat item, is deliberately hidden as metadata, or falls back to a "view in terminal" row. Nothing is silently dropped. Messages sent from the composer reach claude exactly as typed. Permission prompts, AskUserQuestion pickers and plan approvals answer from chat or from the terminal, and the first answer wins with no double prompt and no leaked hook process. The needs-you badge stays until the prompt is answered, not when it is viewed. The user's own statusLine renders verbatim in a status strip. Cmd+J flips to the live terminal with no lost state. The P1b terminal fidelity tests still pass.

## Reference artifacts

- Spec: /Users/NDP/temp/patchroom/docs/SPEC.md (sections 2 "Claude Code adapter", 3.1 badges, 3.2, 3.3, 8 P2 row)
- Spike findings: /Users/NDP/temp/patchroom-spikes/FINDINGS.md (V1a, V1b, V2, V3, V8, transcript latency)
- Design: /Users/NDP/temp/patchroom/DESIGN.md "Components" (Message, Ask widget, Composer, Status strip) and the reference screen at ui/theme-preview/src/ReferenceScreen.tsx (Homeroom chat layout)
- Interaction model: Slack's message log and composer
- Content parity reference: the Claude Code TUI itself for the same transcript
- Corpus: the 40 most recent real transcripts over 2 KB under /Users/NDP/.claude/projects, plus older ones until the set covers every type below. Local only: the corpus and anything derived from it is never committed.

Survey of 242 recent local transcripts (for coverage, not a closed list):
- Line types: assistant, user, attachment, system, last-prompt, mode, ai-title, pr-link, queue-operation, permission-mode, agent-name, file-history-snapshot/delta, worktree-state, cost-state, and more.
- Content blocks: text, thinking, tool_use, tool_result, image, plain string.
- system subtypes: stop_hook_summary, turn_duration, away_summary, compact_boundary, local_command, informational.
- Tools: Bash, Read, Edit, Write, Agent, AskUserQuestion, ExitPlanMode, MCP tools, and others.

## IPC contract additions (fixed, so both pieces build in parallel)

P1b commands and events stay unchanged. Add:

Commands:
- `chat_history {id, before?, limit?} -> {items: ChatItem[], hasMore}`: newest page first, oldest-first within the page.
- `chat_thread {id, toolUseId} -> {items: ChatItem[]}`: a subagent's items.
- `chat_image {id, ref} -> {dataUrl}`: image bytes are fetched on demand, never inlined in items.
- `prompt_answer {id, promptId, answer}`. `answer` is `{kind:"allow"} | {kind:"allow_always"} | {kind:"deny", message?} | {kind:"questions", answers: {[questionText]: string}}`. Multi-select joins labels with ", ".
- `prompt_list {id} -> PromptPendingEvent[]` (added after wave 4): announced, unresolved prompts, so a reloaded UI catches up.
- `session_mark_read {id}`
- `statusline_cycle_mode {id}`: writes Shift+Tab to the PTY.
- `paste_image {id, data, mediaType} -> {path}` (added wave 3): `data` is base64. The backend writes the bytes to a 0600 file under the app data dir (`pastes/`) and returns its absolute path. The composer inserts that path, as in V8. Nothing is written to the PTY at paste time.

Events:
- `chat:items {id, items: ChatItem[]}`: new or updated items (same `key` replaces).
- `prompt:pending {id, promptId, kind: "permission"|"question"|"plan", toolName, toolInput, toolUseId?, questions?}`
  A later `prompt:pending` with the same `promptId` replaces the earlier one (added wave 3: used to fill in `toolUseId` once the tool_use line lands).
- `prompt:resolved {id, promptId, by: "chat"|"terminal"|"timeout"|"interrupt"}`
- `session:badges {id, unread, needsYou}`
- `statusline:update {id, text, chips: {model?, contextPct?, cost?, mode?, worktree?, prUrl?}}`. `text` is the user's statusLine output as ANSI.

ChatItem (every item has `key` (stable), `ts`, `kind`, optional `parentToolUseId`):
- `user {text, images: [{ref, mediaType}]}`: `<pasted_content>` wrappers unwrapped.
- `assistant {text}`: markdown.
- `thinking {text}`: collapsed by default.
- `tool {toolUseId, name, input, state: "pending"|"running"|"ok"|"error"|"denied"|"interrupted", result?: {text, isError, truncated}, diff?}`
- `question {toolUseId, questions, answers?}`
- `plan {toolUseId, plan, state}`
- `subagent {toolUseId, description, agentType, itemCount, state}`
- `system {subtype, text}`: compact boundary, local command output, turn duration, API errors.
- `fallback {lineType, summary}`: anything unrecognized. Renders as a row with "View in terminal".

Wire format: JSON fields are camelCase. `kind` values are exactly the lowercase names above. Rust types live in a new crate `crates/patchroom-claude`; TS mirrors live in `ui/src/ipc/types.ts`.

Corpus tool contract: `cargo run -q -p patchroom-claude --bin patchroom-claude -- dump <transcript.jsonl>` prints `{"items": ChatItem[], "accounting": {"lines","items","hidden","fallback","errors"}}` to stdout and the accounting line to stderr. Dumps for the UI corpus test go in the gitignored dir `ui/node_modules/.cache/patchroom-corpus/<file-stem>.json`. `ui/tests/tools/dump-corpus.sh` (frontend) builds that dir from the corpus.

## Pieces

### backend (crates/, src-tauri/)
1. A Claude adapter tails the session transcript incrementally (offset-based, survives partial lines, file rotation and compaction). It maps every line to ChatItems, a documented hidden-metadata list, or `fallback`. Unknown shapes never panic or stop the tail.
2. A corpus tool, `patchroom-claude dump <transcript.jsonl>`, prints the ChatItems plus an accounting line: `lines=N items=I hidden=H fallback=F errors=0`, with N = mapped + hidden + fallback.
3. New chat items reach the UI within 500 ms of the transcript line landing (median over a live turn).
4. Pending prompts come from the bridge arbiter. Allow, Deny, Always and question answers from chat resolve the hook. Always applies the CLI's own `permission_suggestions`, as option 2 in the TUI does. Answering in the TUI resolves the chat widget and the hook process exits within 2 s.
5. Unread count and needs-you persist in the store across restart. needsYou clears only on resolution, never on `session_mark_read`.
6. statusLine: the per-launch `--settings` adds a wrapper that runs the user's own statusLine command unchanged, with the same stdin, and passes its output through. It tees the stdin JSON to the bridge for chips. The wrapper reads user settings in place and never writes them. With no user statusLine, the strip shows chips only and the TUI shows nothing new.
7. fmt, clippy -D warnings, cargo test, and the macOS debug build pass. P1b manager and pty tests still pass.

### frontend (ui/src/ excluding ui/src/theme/, ui/tests/, .github/workflows/)
1. Chat view per DM following the DESIGN.md components and the reference screen: avatar, name, time and body. Markdown with highlighted code blocks and tables. Tool calls as one bordered line that expands to input and result. Edit and Write show an inline diff. Thinking collapsed. Subagents as a thread summary that opens the thread in the right pane.
2. Virtualized log. A 10,000-item transcript scrolls at 60 fps and opens in under 1 s. New items stick to the bottom only when the view was already at the bottom.
3. Ask widget for permission (Allow, Deny, Always), AskUserQuestion (single, multi-select, Other with free text) and plan approval. Each has "Answer in terminal", and each shows how it resolved (chat, terminal, timed out).
4. Composer: Enter sends through `session_send_text`, Shift+Enter adds a newline, pasted images become absolute file paths as in V8, and slash commands pass through as text. Stop sends Esc and is always visible while busy.
5. Cmd+J toggles chat and terminal. The xterm instance stays mounted, so toggling loses no bytes or scrollback. A `fallback` row opens the terminal.
6. Sidebar badges: unread clears on view; the red needs-you badge persists until answered.
7. Status strip under the composer: the user's statusLine rendered as ANSI verbatim, plus chips. The mode chip click calls `statusline_cycle_mode`.
8. CI gains a Playwright job on ubuntu-latest that runs every UI test, including fidelity against pyte.
9. Impeccable critique passes on the chat view. Light and dark. The 880 to 1400 px layout sweep has no overlap, clipping or cut-off text.

### both (judged on the integrated build)
- Corpus: `dump` runs over all 40 transcripts with errors=0, and fallback is under 1% of non-hidden lines. Each fallback lineType is listed with a reason. Every transcript renders in the UI (mock IPC fed by the dump output) with no console errors. For 5 sampled transcripts, every assistant text block appears in the DOM.
- Live, with `--open-dm` in a temp dir and `--model haiku`:
  - Send a prompt from the composer; it appears as one user message.
  - Trigger a permission prompt and allow it from chat. The TUI dialog closes, the tool runs, and `pgrep -f patchroom-hook` is empty within 2 s.
  - Trigger another and answer it in the terminal (Cmd+J, then `1`). The chat widget shows "answered in terminal" and no hook process remains.
  - Trigger AskUserQuestion: answer one from chat (including Other text) and one from the terminal.
  - Trigger a plan approval and approve it from chat.
  - Switch to another DM while a prompt waits, then come back: the red badge is still there until answered.
  - A background DM gets an unread badge that clears on view.
  - The status strip text matches the TUI's own statusline bytes.
- Patchroom never writes /Users/NDP/.claude/settings.json, /Users/NDP/.claude.json, /Users/NDP/.bash_profile or /Users/NDP/.zshrc. settings.json and the shell profiles checksum identical before and after. In /Users/NDP/.claude.json, only claude's own entries for the DM's folder change, and nothing references Patchroom, patchroom-hook or the bridge socket.
- No transcript content from the corpus is committed (gitleaks plus a grep of the diff for corpus session ids).

## Inspection method

- Rust: fmt, clippy -D warnings, cargo test, `pnpm tauri build --debug`, `dump` over the corpus.
- UI: lint, typecheck, build, the full Playwright suite (new corpus render test reads dumps from a gitignored cache dir), impeccable detector, and the layout sweep in light and dark.
- Integrated: the live script above, with screenshots via `screencapture -l <windowid>` of each widget state, `pgrep` after each resolution and after quit, and config checksums.
- Judges are fresh Opus agents with no build context. Builders never self-grade.
