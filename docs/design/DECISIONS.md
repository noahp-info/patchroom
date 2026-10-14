# Decisions: open questions that never get buried

Status: design draft, 2026-10-14. Requested by the owner. Planned as phase P3b, after P3 merges and before P4.

## Problem

An agent asks the user something, then subagents finish and more output scrolls past. The question is buried. Today the owner works around it with a CLAUDE.md rule: every turn ends with "What I need from you". That rule still lives in the scrollback.

## Shape

A **Decisions tray**: one durable list of everything an agent needs the user to decide, across every DM. It is separate from needs-you:

- **needs-you** = the CLI is blocked on a prompt right now (permission, AskUserQuestion, plan). P2 handles it.
- **decision** = the agent keeps working, but it needs the user's call before some later step. It never blocks and never expires.

Prior art it borrows from:
- **The decision record:** context, options, consequences, chosen option.
- **Human-in-the-loop as a tool call:** HumanLayer's `human_as_tool`, and the "persist, yield, resume" approval gate (LangGraph `interrupt()`, Cloudflare `waitForApproval`). The request is structured data, stored durably, and answered on the user's timeline.
- **Inbox triage:** Linear Inbox and Slack Later. One list, oldest first, with snooze.

## Agent side: a Patchroom MCP server

`patchroom-mcp` is a stdio MCP server sidecar. It talks to the app over the existing 0600 bridge socket and opens no network listener. Every Claude DM gets it per launch with `--mcp-config <inline json>`. The instructions go in per launch with `--append-system-prompt`. Patchroom writes no user config, so the onboarding "install" is a per-launch injection, consistent with spec principle 4. Other CLIs get the same server through their own MCP config flags in P6.

Tools:
- `decision_open {key, title, ask, options: [{id, label, detail?, consequence?}], recommended?, context, links?: [{label, path|url}], urgency: "now"|"today"|"whenever", blocks?: string}`
  - `key` is stable per question. Reopening the same key updates the card instead of adding a duplicate.
  - `context` is markdown: the "View more" body, holding what the user needs to decide without reading the chat.
  - `blocks` names what waits on this decision ("the P3 merge").
- `decision_update {key, ...}`: refine the card. An elaboration lands here.
- `decision_withdraw {key, reason}`: the agent resolved it another way, or the question went stale.
- `decision_list {} -> open decisions for this DM`: the agent checks what is still open after compaction or resume.

The injected instruction, in short: when you need the user's input and are not blocked on it right now, call `decision_open` instead of only writing the question in chat. Keep the chat mention to one line. Call `decision_list` after a resume or compaction.

## User side: the tray

- **Placement:**
  - A collapsible tray docked at the top of the right pane, always present while any decision is open. It collapses to a pill showing the count.
  - Each DM's header shows its own open decisions.
  - A global "Decisions" view sits next to Activity.
  - The sidebar shows a small count per DM, in a color distinct from needs-you red.
- **Card:**
  - title, the one-line ask, the option buttons with the recommended one marked, which DM is asking, its age and urgency, and what it blocks
  - Answer: pick an option or write your own, with an optional note
  - View more
  - Elaborate
  - Snooze (1h, tomorrow, next week)
  - Dismiss
- **View more** expands the context markdown, the links (which open in the artifact pane in P4) and the per-option consequences.
- **Elaborate** sends the agent `Elaborate on decision "<title>" (key <key>). Update it with decision_update; do not answer in chat only.` The card shows "Elaborating..." until the update lands, and the new context appears in place. If the user adds a question, it is included.
- **Answering** sends a message to the agent: `Decision "<title>": <option label>. <note>`. If the agent is busy, the answer queues and the card says "Queued, sends when idle". The P2 input queue sends it at the next idle point. The card then moves to Resolved, with who answered and when.
- **Nothing is lost:**
  - Decisions persist in the store.
  - They survive restart, compaction and the agent's session ending.
  - An ended session keeps its decisions open, and answering one resumes the session first.
  - Notifications use the P3 notifier with a new `decision` event, and "today" decisions remind once at a set hour.

## Defer

- Defer is Snooze with a date: 1 hour, tomorrow, next week, or a picked date. The card leaves the tray and returns on that date, with a notification.
- Deferred cards live under the Decisions view's "Deferred" tab, sorted by return date. They also show on the Patchroom calendar on their return date (see TASKS.md).
- "Defer as task" turns a decision into a task with a project and a due date. The task keeps a link back to the decision and its DM.

## Fallback for sessions without the tool

Some sessions don't have the tool: one started in iTerm, an old resumed one, or another CLI. Optionally, the transcript tail recognizes an agent's closing "What I need from you" block. Each bullet becomes a decision with source "parsed". It has no options and offers Answer, Elaborate and Dismiss. This setting defaults to on for DMs only. It reads and writes nothing outside Patchroom.

## Data

- Migration: `decision {id, author, created_at, updated_at, conversation_id, key, title, ask, options_json, recommended, context, links_json, urgency, blocks, state: open|snoozed|answered|withdrawn|dismissed, snooze_until, answer_json, source: tool|parsed}` with `UNIQUE(conversation_id, key)`.
- Events: `decision:changed {id, key}`.
- Commands: `decision_list {id?, state?}`, `decision_answer`, `decision_elaborate`, `decision_snooze`, `decision_dismiss`.

## Bar sketch (for the P3b gauntlet)

- A live haiku DM with the injected server and prompt opens a decision on its own when given an ambiguous task. The card shows title, options, recommendation and context.
- Fifty more items of chat and a subagent finish: the tray still shows the decision. It also survives an app restart and a `/compact`.
- Elaborate makes the agent call `decision_update`. The new context appears in the card within one turn.
- Answering while busy queues the answer and sends it at idle. The agent's next turn uses the answer.
- Reopening the same `key` updates the card and never duplicates it.
- The fallback parser turns a "What I need from you" block into decisions.
- No user config is written: the checksums match before and after. No network listener.
