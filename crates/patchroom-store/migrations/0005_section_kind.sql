-- Patchroom store schema v5: dividers and section emoji (sidebar organization).
-- section.kind: 'section' (holds DMs) or 'divider' (a rule with an optional label, no DMs).
-- section.emoji: optional leading emoji shown in the section header; NULL for none.
-- Existing rows keep working: every P3-era section becomes kind 'section' with no emoji.

ALTER TABLE section ADD COLUMN kind TEXT NOT NULL DEFAULT 'section'
    CHECK (kind IN ('section', 'divider'));
ALTER TABLE section ADD COLUMN emoji TEXT;
