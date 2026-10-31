//! The P3 Slack layer: default sections, placement, flags, item marks, activity timestamps.

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension, Row};

use crate::error::{Error, Result};
use crate::store::{col_author, col_id, new_id, now, Store};
use crate::types::{
    ActivityMarks, Author, DefaultSections, Id, ItemMark, MarkKind, Millis, SNAPSHOT_CHARS,
};

const MARK_COLS: &str =
    "id, author, created_at, updated_at, conversation_id, item_key, kind, emoji, snapshot";
/// Setting key that remembers the default section ids.
const DEFAULTS_KEY: &str = "sections.defaults";
/// Name of the section new DMs land in.
pub const DM_SECTION: &str = "Sessions";
/// The default section's name before the rename. Still found on upgrade, then renamed.
pub const LEGACY_DM_SECTION: &str = "Direct messages";
/// Longest reaction label (an emoji or a `:shortcode:`), in characters.
const MAX_EMOJI_CHARS: usize = 64;

fn mark_row(r: &Row<'_>) -> rusqlite::Result<ItemMark> {
    let kind: String = r.get(6)?;
    Ok(ItemMark {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        conversation_id: col_id(r, 4)?,
        item_key: r.get(5)?,
        kind: kind.parse().map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e))
        })?,
        emoji: r.get(7)?,
        snapshot: r.get(8)?,
    })
}

/// Cut `s` to at most `n` characters.
fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

impl Store {
    // ---- default sections ----

    /// Make sure the workspace has its default sections: Starred, Sessions, Archived.
    ///
    /// A fresh workspace gets all three in that order. A workspace from an older build keeps
    /// its first section as the sessions section and gains the other two around it. A default
    /// section the user deleted later stays deleted, except Sessions, which is where new
    /// sessions land and so is recreated. A sessions section still named "Direct messages"
    /// is renamed "Sessions"; a name the user chose is kept.
    pub fn ensure_default_sections(
        &self,
        author: &Author,
        workspace_id: Id,
    ) -> Result<DefaultSections> {
        let sections = self.list_sections(workspace_id)?;
        let exists = |id: Id| sections.iter().any(|s| s.id == id);
        let stored: Option<serde_json::Value> = self
            .setting_value(DEFAULTS_KEY)?
            .and_then(|v| serde_json::from_str(&v).ok());
        let stored_id = |k: &str| -> Option<Id> {
            stored
                .as_ref()?
                .get(k)?
                .as_str()?
                .parse::<Id>()
                .ok()
                .filter(|id| exists(*id))
        };
        let first_run = stored.is_none();
        let mut starred = stored_id("starred");
        let mut archived = stored_id("archived");
        let mut dm = stored_id("dm");
        if first_run {
            // Starred goes first, so on a fresh workspace create it before the DM section.
            let upgrading = !sections.is_empty();
            if !upgrading {
                starred = Some(self.create_section(author, workspace_id, "Starred")?.id);
            }
            dm = dm.or_else(|| {
                sections
                    .iter()
                    .find(|s| s.name == DM_SECTION || s.name == LEGACY_DM_SECTION)
                    .or(sections.first())
                    .map(|s| s.id)
            });
            let dm_id = match dm {
                Some(id) => id,
                None => self.create_section(author, workspace_id, DM_SECTION)?.id,
            };
            dm = Some(dm_id);
            archived = Some(self.create_section(author, workspace_id, "Archived")?.id);
            if upgrading {
                starred = Some(self.create_section(author, workspace_id, "Starred")?.id);
                // Starred first, Archived last, everything else in its old order between.
                let mut order: Vec<Id> = Vec::new();
                order.extend(starred);
                order.extend(sections.iter().map(|s| s.id));
                order.extend(archived);
                self.reorder_sections(workspace_id, &order)?;
            }
        }
        let dm = match dm {
            Some(id) => id,
            None => self.create_section(author, workspace_id, DM_SECTION)?.id,
        };
        if self.section(dm)?.name == LEGACY_DM_SECTION {
            self.rename_section(dm, DM_SECTION)?;
        }
        let out = DefaultSections {
            starred,
            dm,
            archived,
        };
        let json = serde_json::json!({
            "starred": out.starred.map(|i| i.to_string()),
            "dm": out.dm.to_string(),
            "archived": out.archived.map(|i| i.to_string()),
        });
        self.set_setting(author, DEFAULTS_KEY, &json.to_string())?;
        Ok(out)
    }

    /// Delete a section and move its conversations to the end of `fallback`.
    pub fn delete_section_into(&self, id: Id, fallback: Id) -> Result<()> {
        if id == fallback {
            return Err(Error::invalid("cannot move a section's DMs into itself"));
        }
        if self.section(fallback)?.kind == crate::types::SectionKind::Divider {
            return Err(Error::invalid("a divider cannot hold conversations"));
        }
        let tx = self.conn.unchecked_transaction()?;
        let ids: Vec<String> = {
            let mut st = tx.prepare(
                "SELECT id FROM conversation WHERE section_id = ?1 ORDER BY position, rowid",
            )?;
            let rows = st.query_map([id.to_string()], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let base: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM conversation WHERE section_id = ?1",
            [fallback.to_string()],
            |r| r.get(0),
        )?;
        let t = now();
        for (i, cid) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE conversation SET section_id = ?2, position = ?3, updated_at = ?4
                 WHERE id = ?1",
                params![cid, fallback.to_string(), base + i as i64, t],
            )?;
        }
        let n = tx.execute("DELETE FROM section WHERE id = ?1", [id.to_string()])?;
        if n == 0 {
            return Err(Error::not_found("section", id));
        }
        tx.commit()?;
        Ok(())
    }

    /// Put `ids` into `section_id` (or unplace them) in exactly that order. Conversations
    /// already in the section and not listed keep their order after the listed ones.
    pub fn place_conversations(&self, section_id: Option<Id>, ids: &[Id]) -> Result<()> {
        let mut seen = HashSet::new();
        if !ids.iter().all(|i| seen.insert(*i)) {
            return Err(Error::invalid("a conversation is listed twice"));
        }
        if let Some(s) = section_id {
            if self.section(s)?.kind == crate::types::SectionKind::Divider {
                return Err(Error::invalid("a divider cannot hold conversations"));
            }
        }
        let tx = self.conn.unchecked_transaction()?;
        let rest: Vec<String> = {
            let mut st = tx.prepare(
                "SELECT id FROM conversation WHERE section_id IS ?1 ORDER BY position, rowid",
            )?;
            let rows = st.query_map([section_id.map(|s| s.to_string())], |r| {
                r.get::<_, String>(0)
            })?;
            rows.collect::<rusqlite::Result<Vec<String>>>()?
                .into_iter()
                .filter(|c| !seen.contains(&c.parse::<Id>().unwrap_or_default()))
                .collect()
        };
        let t = now();
        let ordered = ids.iter().map(ToString::to_string).chain(rest);
        for (pos, cid) in ordered.enumerate() {
            let n = tx.execute(
                "UPDATE conversation SET section_id = ?2, position = ?3, updated_at = ?4
                 WHERE id = ?1 AND kind = 'dm'",
                params![cid, section_id.map(|s| s.to_string()), pos as i64, t],
            )?;
            if n == 0 {
                return Err(Error::not_found("conversation", cid));
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ---- flags ----

    /// Set the starred and archived flags; `None` leaves a flag as it is.
    pub fn set_conversation_flags(
        &self,
        id: Id,
        starred: Option<bool>,
        archived: Option<bool>,
    ) -> Result<()> {
        let n = self.conn.execute(
            "UPDATE conversation SET starred = COALESCE(?2, starred),
                 archived = COALESCE(?3, archived), updated_at = ?4 WHERE id = ?1",
            params![id.to_string(), starred, archived, now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("conversation", id));
        }
        Ok(())
    }

    /// Ids of the conversations that have a non-empty draft.
    pub fn draft_conversation_ids(&self) -> Result<Vec<Id>> {
        let mut st = self.conn.prepare("SELECT conversation_id FROM draft")?;
        let rows = st.query_map([], |r| col_id(r, 0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ---- item marks ----

    /// Add a pin, saved item or reaction. Adding the same mark again refreshes its snapshot
    /// and returns the existing row. `snapshot` is cut to [`SNAPSHOT_CHARS`] characters.
    pub fn add_mark(
        &self,
        author: &Author,
        conversation_id: Id,
        item_key: &str,
        kind: MarkKind,
        emoji: Option<&str>,
        snapshot: &str,
    ) -> Result<ItemMark> {
        if item_key.is_empty() {
            return Err(Error::invalid("item key must not be empty"));
        }
        let emoji = Self::mark_emoji(kind, emoji)?;
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT INTO item_mark
                 (id, author, created_at, updated_at, conversation_id, item_key, kind, emoji, snapshot)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(conversation_id, item_key, kind, emoji) DO UPDATE SET
                 snapshot = excluded.snapshot, updated_at = excluded.updated_at",
            params![
                id.to_string(),
                author.to_string(),
                t,
                conversation_id.to_string(),
                item_key,
                kind.as_str(),
                emoji,
                clip(snapshot, SNAPSHOT_CHARS),
            ],
        )?;
        self.mark(conversation_id, item_key, kind, &emoji)?
            .ok_or_else(|| Error::not_found("item mark", item_key))
    }

    /// Remove a mark; returns whether it existed.
    pub fn remove_mark(
        &self,
        conversation_id: Id,
        item_key: &str,
        kind: MarkKind,
        emoji: Option<&str>,
    ) -> Result<bool> {
        let emoji = Self::mark_emoji(kind, emoji)?;
        Ok(self.conn.execute(
            "DELETE FROM item_mark
             WHERE conversation_id = ?1 AND item_key = ?2 AND kind = ?3 AND emoji = ?4",
            params![conversation_id.to_string(), item_key, kind.as_str(), emoji],
        )? > 0)
    }

    /// One mark, if it exists.
    pub fn mark(
        &self,
        conversation_id: Id,
        item_key: &str,
        kind: MarkKind,
        emoji: &str,
    ) -> Result<Option<ItemMark>> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT {MARK_COLS} FROM item_mark
                     WHERE conversation_id = ?1 AND item_key = ?2 AND kind = ?3 AND emoji = ?4"
                ),
                params![conversation_id.to_string(), item_key, kind.as_str(), emoji],
                mark_row,
            )
            .optional()?)
    }

    /// Marks of one conversation, or of all of them, newest first, optionally of one kind.
    pub fn list_marks(
        &self,
        conversation_id: Option<Id>,
        kind: Option<MarkKind>,
    ) -> Result<Vec<ItemMark>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {MARK_COLS} FROM item_mark
             WHERE (?1 IS NULL OR conversation_id = ?1) AND (?2 IS NULL OR kind = ?2)
             ORDER BY created_at DESC, rowid DESC"
        ))?;
        let rows = st.query_map(
            params![
                conversation_id.map(|c| c.to_string()),
                kind.map(MarkKind::as_str)
            ],
            mark_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn mark_emoji(kind: MarkKind, emoji: Option<&str>) -> Result<String> {
        match kind {
            MarkKind::Reaction => {
                let e = emoji.map_or("", str::trim);
                if e.is_empty() || e.chars().count() > MAX_EMOJI_CHARS {
                    return Err(Error::invalid(
                        "a reaction needs an emoji of 1 to 64 characters",
                    ));
                }
                Ok(e.to_owned())
            }
            _ => Ok(String::new()),
        }
    }

    // ---- activity ----

    /// Record the oldest unread item of a conversation. Does nothing when one is already
    /// recorded or nothing is unread.
    pub fn note_first_unread(
        &self,
        conversation_id: Id,
        ts: Millis,
        item_key: &str,
        summary: &str,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE conversation_badge SET unread_since = ?2, unread_key = ?3, unread_summary = ?4
             WHERE conversation_id = ?1 AND unread > 0 AND unread_since IS NULL",
            params![
                conversation_id.to_string(),
                ts,
                item_key,
                clip(summary, SNAPSHOT_CHARS)
            ],
        )?;
        Ok(())
    }

    /// Activity timestamps of every conversation that is unread or waiting on the user.
    pub fn activity_marks(&self) -> Result<Vec<ActivityMarks>> {
        let mut st = self.conn.prepare(
            "SELECT conversation_id, unread, needs_you, unread_since, unread_key, unread_summary,
                    needs_since
             FROM conversation_badge WHERE unread > 0 OR needs_you = 1",
        )?;
        let rows = st.query_map([], |r| {
            Ok(ActivityMarks {
                conversation_id: col_id(r, 0)?,
                unread: r.get(1)?,
                needs_you: r.get::<_, i64>(2)? != 0,
                unread_since: r.get(3)?,
                unread_key: r.get(4)?,
                unread_summary: r.get(5)?,
                needs_since: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}
