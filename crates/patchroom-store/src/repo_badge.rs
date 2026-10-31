//! Sidebar badges: unread count and needs-you flag per conversation.

use rusqlite::{params, OptionalExtension};

use crate::error::Result;
use crate::store::{col_id, new_id, now, Store};
use crate::types::{Author, Badges, Id};

fn badges_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Badges> {
    Ok(Badges {
        conversation_id: col_id(r, 0)?,
        unread: r.get(1)?,
        needs_you: r.get::<_, i64>(2)? != 0,
    })
}

impl Store {
    /// The badges of a conversation. A conversation with no row has no badges.
    pub fn badges(&self, conversation_id: Id) -> Result<Badges> {
        let found = self
            .conn
            .query_row(
                "SELECT conversation_id, unread, needs_you FROM conversation_badge
                 WHERE conversation_id = ?1",
                [conversation_id.to_string()],
                badges_row,
            )
            .optional()?;
        Ok(found.unwrap_or(Badges {
            conversation_id,
            unread: 0,
            needs_you: false,
        }))
    }

    /// Every stored badge row.
    pub fn list_badges(&self) -> Result<Vec<Badges>> {
        let mut st = self
            .conn
            .prepare("SELECT conversation_id, unread, needs_you FROM conversation_badge")?;
        let rows = st.query_map([], badges_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Add `n` to the unread count.
    pub fn add_unread(&self, author: &Author, conversation_id: Id, n: u32) -> Result<Badges> {
        self.upsert_badge(
            author,
            conversation_id,
            "unread = unread + ?5",
            i64::from(n),
            0,
        )
    }

    /// Set the unread count to zero. Leaves `needs_you` alone.
    pub fn clear_unread(&self, author: &Author, conversation_id: Id) -> Result<Badges> {
        self.upsert_badge(
            author,
            conversation_id,
            "unread = 0, unread_since = NULL, unread_key = NULL, unread_summary = NULL",
            0,
            0,
        )
    }

    /// Set or clear the needs-you flag. Leaves `unread` alone.
    pub fn set_needs_you(
        &self,
        author: &Author,
        conversation_id: Id,
        needs_you: bool,
    ) -> Result<Badges> {
        let b = self.upsert_badge(
            author,
            conversation_id,
            "needs_you = ?6, needs_since = CASE WHEN ?6 = 1 THEN COALESCE(needs_since, ?3) ELSE NULL END",
            0,
            i64::from(needs_you),
        )?;
        if needs_you {
            self.conn.execute(
                "UPDATE conversation_badge SET needs_since = COALESCE(needs_since, ?2)
                 WHERE conversation_id = ?1",
                params![conversation_id.to_string(), now()],
            )?;
        }
        Ok(b)
    }

    fn upsert_badge(
        &self,
        author: &Author,
        conversation_id: Id,
        update_set: &str,
        unread_arg: i64,
        needs_arg: i64,
    ) -> Result<Badges> {
        let t = now();
        let initial_unread = unread_arg.max(0);
        self.conn.execute(
            &format!(
                "INSERT INTO conversation_badge
                     (id, author, created_at, updated_at, conversation_id, unread, needs_you)
                 VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)
                 ON CONFLICT(conversation_id) DO UPDATE SET {update_set}, updated_at = ?3,
                     author = ?2"
            ),
            params![
                new_id().to_string(),
                author.to_string(),
                t,
                conversation_id.to_string(),
                initial_unread,
                needs_arg
            ],
        )?;
        self.badges(conversation_id)
    }
}
