-- Patchroom store schema v2: sidebar badges (SPEC 3.1).
-- unread: new assistant output since the DM was last viewed.
-- needs_you: a prompt or dialog waits on the user. It clears on resolution, never on view.

CREATE TABLE conversation_badge (
    id              TEXT PRIMARY KEY,
    author          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversation(id) ON DELETE CASCADE,
    unread          INTEGER NOT NULL DEFAULT 0 CHECK (unread >= 0),
    needs_you       INTEGER NOT NULL DEFAULT 0 CHECK (needs_you IN (0, 1))
);
