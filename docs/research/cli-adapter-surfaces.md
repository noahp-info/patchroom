# CLI adapter surfaces (research, 2026-10-13)

Condensed from a research pass. Items marked UNVERIFIED need empirical capture before an adapter relies on them. Raw doc dumps live in `docs/research/raw-doc-dumps/` (gitignored, local only).

**Key finding:** Cursor, Gemini, Copilot and opencode expose a structured control protocol (ACP over stdio, or HTTP). Claude Code and Codex are best driven as PTY + hooks + transcript tail. ACP = Agent Client Protocol, JSON-RPC 2.0 over stdio: https://agentclientprotocol.com/get-started/introduction

## Ranking: cheapest to adapt fully

1. **opencode:** HTTP server + SSE covers everything. Risk: API churn between the stable surface and the new `/api/` surface. Pin a release.
2. **Claude Code:** richest hooks, statusLine JSON feed, `claude agents --json` states, hooks can answer permissions and AskUserQuestion without keystrokes. Risk: transcript format is officially unstable.
3. **Cursor (`agent acp`):** typed permissions, ask_question, create_plan, session/load. Gap: no on-disk transcript, no cost data.
4. **Gemini CLI (`gemini --acp`):** documented chat JSONL with token counts. Gap: hooks cannot approve; use ACP.
5. **Copilot CLI (`copilot --acp`):** strong hooks and resume. Gap: `events.jsonl` undocumented.
6. **Codex CLI:** hooks cover approvals and status. Gap: rollout schema must be reverse-engineered; `codex app-server` may improve this.

## Claude Code

- **Transcript:** `~/.claude/projects/<cwd, non-alphanumerics to "-">/<session-id>.jsonl`; subagents in `<session>/subagents/agent-*.jsonl`. Docs: format is internal and unstable (https://code.claude.com/docs/en/sessions). Observed line types: assistant, user, system, attachment, mode, last-prompt, ai-title, pr-link, queue-operation, file-history-snapshot. `tool_use` blocks in assistant content, `tool_result` in user content plus top-level `toolUseResult`.
- **AskUserQuestion:** assistant `tool_use` with `input.questions[] {question, header, multiSelect, options[{label, description}]}`; answer is a user `tool_result` plus structured `toolUseResult`.
- **Status:** `claude agents --json` gives `status` busy | waiting | idle for live processes, `waitingFor` "permission prompt" | "input needed" | "sandbox request" | "worker request" | "dialog open". `waitingFor` on plain interactive sessions: UNVERIFIED. https://code.claude.com/docs/en/agent-view
- **Hooks:** full list includes SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Notification, MessageDisplay, SubagentStart/Stop, TaskCreated/Completed, Stop, StopFailure, PreCompact/PostCompact, CwdChanged, FileChanged, WorktreeCreate/Remove, Elicitation, SessionEnd. Handler types include `http`. https://code.claude.com/docs/en/hooks
- **Notification types:** permission_prompt, idle_prompt, elicitation_dialog, agent_needs_input, agent_completed, and more.
- **Answering prompts natively:** PermissionRequest hook returns `decision {behavior: allow|deny, updatedInput?, updatedPermissions?, message?}`. AskUserQuestion needs PreToolUse returning `permissionDecision: "allow"` with `updatedInput` = original questions plus `answers`.
- **TUI keystrokes for dialogs:** UNVERIFIED; capture empirically.
- **Resume:** `--resume <id|name|path>`, `-c`, `--session-id <uuid>`, `--fork-session`, `-n`.
- **Per-launch config injection:** `--settings <json>` (no user file edits).
- **statusLine stdin JSON:** session_id, model, workspace, cost{total_cost_usd,...}, context_window{used_percentage,...}, rate_limits, worktree, pr, and more. It runs as a heartbeat. https://code.claude.com/docs/en/statusline

## Codex CLI

- **Transcript:** `$CODEX_HOME/sessions/.../rollout-<ts>-<uuid>.jsonl` (subfolders UNVERIFIED). Events: TurnStarted, TurnComplete, TokenCount, ExecApprovalRequest, RequestUserInput. Field names UNVERIFIED.
- **Structured:** `codex app-server` JSON-RPC (thread/start, thread/resume, turn/start, ...); `codex exec --json`. Approval RPC names UNVERIFIED.
- **Hooks:** PreToolUse, PermissionRequest (allow/deny), PostToolUse, UserPromptSubmit, Stop, SessionStart, SessionEnd, and more. https://learn.chatgpt.com/docs/hooks
- **Notifications:** `tui.notification_method = osc9|bel`.
- **Resume:** `codex resume [ID|name]`, `codex fork`.
- **Cost:** none native; derive from TokenCount.

## Cursor CLI (`agent`)

- **ACP:** `agent acp`. session/new, session/load, session/prompt, session/update, session/cancel, session/request_permission (allow-once | allow-always | reject-once), cursor/ask_question, cursor/create_plan. https://cursor.com/docs/cli/acp
- **Hooks:** `~/.cursor/hooks.json`; beforeSubmitPrompt, stop, preToolUse, and more. https://cursor.com/docs/hooks
- **Transcript on disk:** UNVERIFIED. **Cost:** none found.

## Gemini CLI

- **Transcript:** `~/.gemini/tmp/<project_hash>/chats/session-<ts>-<id>.jsonl`; typed records with per-message tokens.
- **ACP:** `gemini --acp`. **Hooks:** 11 events, observe or pre-check only; cannot answer approval dialogs.
- **Notifications:** OSC 9 / BEL with `general.enableNotifications`.
- **Resume:** `--resume`, `--list-sessions`.

## opencode

- **Server:** `opencode serve` (127.0.0.1:4096), OpenAPI at `/doc`, SSE at `/event`. Permission reply, prompt_async, abort, fork. Version churn: pin a release. https://opencode.ai/docs/server/

## Copilot CLI

- **Transcript:** `~/.copilot/session-state/<id>/events.jsonl` (third-party documented only).
- **ACP:** `copilot --acp`. **Hooks:** permissionRequest (allow/deny), notification (typed), agentStop, and more. https://docs.github.com/en/copilot/reference/hooks-reference
- **Resume:** `--resume`, `--continue`, `--session-id`.
