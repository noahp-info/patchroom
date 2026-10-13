-- Patchroom store schema v1 (SPEC section 5, 3.2, 3.7).
-- Every table carries: id (ULID text), author ("human:<id>" | "agent:<id>"),
-- created_at and updated_at (unix milliseconds). No table stores secrets.

CREATE TABLE workspace (
    id         TEXT PRIMARY KEY,
    author     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    name       TEXT NOT NULL
);

CREATE TABLE section (
    id           TEXT PRIMARY KEY,
    author       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    position     INTEGER NOT NULL,
    collapsed    INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1))
);
CREATE INDEX section_workspace ON section(workspace_id, position);

CREATE TABLE conversation (
    id           TEXT PRIMARY KEY,
    author       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    section_id   TEXT REFERENCES section(id) ON DELETE SET NULL,
    position     INTEGER NOT NULL DEFAULT 0,
    kind         TEXT NOT NULL CHECK (kind IN ('dm', 'channel')),
    name         TEXT NOT NULL,
    provider     TEXT,
    cwd          TEXT,
    worktree     TEXT,
    session_id   TEXT,
    adapter_state TEXT NOT NULL DEFAULT '{}',
    assign_mode  TEXT CHECK (assign_mode IN ('board_claim', 'mention', 'lead')),
    lead_id      TEXT REFERENCES conversation(id) ON DELETE SET NULL
);
CREATE INDEX conversation_workspace ON conversation(workspace_id);
CREATE INDEX conversation_section ON conversation(section_id, position);

CREATE TABLE membership (
    id         TEXT PRIMARY KEY,
    author     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    channel_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    dm_id      TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    UNIQUE (channel_id, dm_id),
    CHECK (channel_id <> dm_id)
);
CREATE INDEX membership_dm ON membership(dm_id);

CREATE TABLE message (
    id              TEXT PRIMARY KEY,
    author          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'tool', 'system', 'note')),
    body            TEXT NOT NULL,
    source_ref      TEXT
);
CREATE INDEX message_conversation ON message(conversation_id, created_at);
CREATE UNIQUE INDEX message_source ON message(conversation_id, source_ref)
    WHERE source_ref IS NOT NULL;

CREATE TABLE comment (
    id          TEXT PRIMARY KEY,
    author      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    message_id  TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    range_start INTEGER NOT NULL,
    range_end   INTEGER NOT NULL,
    quote       TEXT NOT NULL,
    body        TEXT NOT NULL,
    resolved    INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
    stale       INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
    CHECK (range_start >= 0 AND range_end > range_start)
);
CREATE INDEX comment_message ON comment(message_id);

CREATE TABLE attachment (
    id         TEXT PRIMARY KEY,
    author     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL,
    mime       TEXT
);
CREATE INDEX attachment_message ON attachment(message_id);

CREATE TABLE task (
    id          TEXT PRIMARY KEY,
    author      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    channel_id  TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner       TEXT,
    status      TEXT NOT NULL DEFAULT 'todo'
        CHECK (status IN ('todo', 'claimed', 'working', 'blocked', 'review', 'done')),
    worktree    TEXT,
    branch      TEXT,
    pr_url      TEXT,
    position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX task_channel ON task(channel_id, position);

CREATE TABLE claim (
    id          TEXT PRIMARY KEY,
    author      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    released_at INTEGER
);
CREATE INDEX claim_task ON claim(task_id);

CREATE TABLE reaction (
    id         TEXT PRIMARY KEY,
    author     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    UNIQUE (message_id, author, emoji)
);

CREATE TABLE pin (
    id         TEXT PRIMARY KEY,
    author     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('pin', 'saved')),
    UNIQUE (message_id, kind)
);

CREATE TABLE draft (
    id              TEXT PRIMARY KEY,
    author          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversation(id) ON DELETE CASCADE,
    body            TEXT NOT NULL
);

CREATE TABLE plugin (
    id         TEXT PRIMARY KEY,
    author     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    name       TEXT NOT NULL UNIQUE,
    version    TEXT NOT NULL,
    manifest   TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE setting (
    id         TEXT PRIMARY KEY,
    author     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    key        TEXT NOT NULL UNIQUE,
    value      TEXT NOT NULL
);
