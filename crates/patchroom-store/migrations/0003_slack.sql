-- Patchroom store schema v3: the P3 Slack layer.
-- starred / archived: sidebar flags on a conversation.
-- item_mark: pins, saved items and reactions anchored to a chat item by (conversation, item key),
--   since chat items come from the transcript and have no message row.
-- badge extras: when the oldest unread / needs-you item appeared, for the Activity list.

ALTER TABLE conversation ADD COLUMN starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1));
ALTER TABLE conversation ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));

CREATE TABLE item_mark (
    id              TEXT PRIMARY KEY,
    author          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    item_key        TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('pin', 'saved', 'reaction')),
    -- Empty for pins and saved items; the emoji (or :shortcode:) for a reaction.
    emoji           TEXT NOT NULL DEFAULT '',
    -- Up to 280 characters of the item's text, for lists.
    snapshot        TEXT NOT NULL DEFAULT '' CHECK (length(snapshot) <= 280),
    UNIQUE (conversation_id, item_key, kind, emoji),
    CHECK ((kind = 'reaction') = (emoji <> ''))
);
CREATE INDEX item_mark_conversation ON item_mark(conversation_id, kind, created_at);
CREATE INDEX item_mark_kind ON item_mark(kind, created_at);

ALTER TABLE conversation_badge ADD COLUMN unread_since INTEGER;
ALTER TABLE conversation_badge ADD COLUMN unread_key TEXT;
ALTER TABLE conversation_badge ADD COLUMN unread_summary TEXT;
ALTER TABLE conversation_badge ADD COLUMN needs_since INTEGER;
