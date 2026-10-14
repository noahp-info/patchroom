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

## Task connectors (local first, cloud when you want it)

Decided by Noah, 2026-10-14: build for both. Native local tasks are the default. Connectors link Patchroom to a tracker a person or team already uses, for maximum adoption.

- **Connector = a plugin** (spec 3.9 contribution point "task provider"). First-party connectors ship in this order: Asana, Linear, Notion, Monday, Jira, GitHub Issues. Each implements one small interface: `listProjects`, `pull(since)`, `push(changes)`, `mapFields`.
- **Three modes, chosen per project:**
  1. **Local:** Patchroom is the source of truth. This is the default.
  2. **Import once:** pull open tasks with their due dates. The project then becomes local. This is Noah's own path off Asana.
  3. **Linked:** two-way sync of title, due date, done, assignee, notes and a backlink to the Patchroom DM. The tracker stays the source of truth on conflict. Agents still use the same `task_*` tools; the connector does the syncing.
- **Field mapping:** project to project, section or board; due date to due date; assignee to member (Team tier). Unmapped fields stay in the tracker untouched.
- **Agents never see connectors.** They call `task_create` and friends. The required project and due date apply in every mode.
- **Default off.** No connector runs until the user adds it. Syncs run outbound only, on an interval while the app is open, with a manual "Sync now".

## Credentials

Decided by Noah, 2026-10-14: Keychain OK.


Connectors need a token, and spec section 4 says Patchroom never stores secrets. Proposal: tokens go in the macOS Keychain, scoped to the Patchroom app, and never in SQLite, logs or exports. OAuth is used where the tracker offers it, and a pasted personal token otherwise. A connector can also read a token from an environment variable (for example `$ASANA_TOKEN`), which stores nothing. Section 4 gets one line: "Connector tokens live only in the macOS Keychain."

## Data and security

Local SQLite only. No listener. Connector calls are outbound only and log no task content. Keychain is the only credential store.
