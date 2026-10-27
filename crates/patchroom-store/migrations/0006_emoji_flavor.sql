-- Patchroom store schema v6: emoji flavors and session emoji.
-- section.emoji_flavor: how the header emoji is drawn, 'apple' or 'noto'; NULL means apple.
-- conversation.emoji / emoji_flavor: an optional leading emoji for a session row.
-- Existing rows keep working: no flavor means the system emoji, no session emoji.

ALTER TABLE section ADD COLUMN emoji_flavor TEXT
    CHECK (emoji_flavor IS NULL OR emoji_flavor IN ('apple', 'noto'));
ALTER TABLE conversation ADD COLUMN emoji TEXT;
ALTER TABLE conversation ADD COLUMN emoji_flavor TEXT
    CHECK (emoji_flavor IS NULL OR emoji_flavor IN ('apple', 'noto'));
