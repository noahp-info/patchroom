# Tasks and calendar: one place for what is due

Status: design draft, 2026-10-14. Requested by the owner. Planned as phase P3c, after P3b Decisions. It replaces the owner's Asana flow inside Patchroom.

## Model

- **One `task` table**, the one spec section 5 already defines for channel boards (P5). P3c adds `due_on`, `project_id`, `source` (human, agent, decision, asana), `links`, `done_at`.
- **Project = section.** A folder section such as knowfirst is a project. Organizational sections can be projects too.
- **Project and due date are required on every task.** This matches the owner's Asana rule ("an undated task is invisible to me"). The create form will not submit without both. An agent's `task_create` call is rejected without both, with a message saying so.
- Every task links back to where it came from: a DM message, a decision or a channel card.

## Ways in

1. **Agents:** `task_create`, `task_update`, `task_list` and `task_complete` on the same Patchroom MCP server as decisions. The per-launch prompt tells agents to use them instead of external trackers inside Patchroom.
2. **Decisions:** Defer as task.
3. **Highlight:** right-click, then Add to task (spec 3.2).
4. **By hand:** from the calendar or the project's section menu.

## Views

- **Calendar:** month and week, with the owner's planning view as the default. It shows tasks on their due dates and deferred decisions on their return dates. Drag to reschedule. Overdue items pin to today in the needs-you color.
- **Agenda:** today, then this week, then later. A Today block also tops the Activity view.
- **Per project:** each section header gets a Tasks tab. Channels (P5) reuse it as their board.

## Asana

The owner chooses one of two options:

- **A. Move off Asana (recommended).**
  - A one-time import brings in open tasks from the chosen Asana projects. Each Asana project maps to a section, and due dates come across.
  - After that, Patchroom is the source of truth.
  - The import uses the owner's existing `$ASANA_TOKEN` from the environment at import time. Patchroom never stores the token.
- **B. Bridge for a while.**
  - Two-way sync for chosen projects: due date, title, done and notes.
  - This keeps outside writers working: iTerm sessions, scheduled jobs and the asana-today skill still write to Asana.
  - Cost: a background outbound sync and conflict rules. It is a new network surface, so it ships default-off as a plugin (spec 3.9 importers).

## Data and security

Local SQLite only. No listener. Asana calls are outbound only, happen on demand (A) or on an interval (B), and log no task content.
