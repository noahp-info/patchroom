-- Patchroom store schema v4: folder sections (P3 addendum).
-- section.folder: home folder of a folder section; NULL for a plain section.
-- section.archive_days: sessions idle this long fold into "Older than X days".
-- folder_hidden: sessions the user hid from one folder section. Only the list row is
--   hidden; the transcript file is never touched.

ALTER TABLE section ADD COLUMN folder TEXT;
ALTER TABLE section ADD COLUMN archive_days INTEGER NOT NULL DEFAULT 14
    CHECK (archive_days BETWEEN 1 AND 3650);

CREATE TABLE folder_hidden (
    id         TEXT PRIMARY KEY,
    author     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    section_id TEXT NOT NULL REFERENCES section(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    UNIQUE (section_id, session_id)
);
