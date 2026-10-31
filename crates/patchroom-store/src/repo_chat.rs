//! Messages, comments, attachments, reactions, pins, drafts.

use rusqlite::{params, OptionalExtension, Row};

use crate::error::{Error, Result};
use crate::store::{col_author, col_id, col_parse, new_id, now, Store};
use crate::types::{
    Attachment, Author, Comment, Draft, Id, Message, NewMessage, Pin, PinKind, Reaction,
};

const MSG_COLS: &str =
    "id, author, created_at, updated_at, conversation_id, kind, body, source_ref";
const CMT_COLS: &str = "id, author, created_at, updated_at, message_id, range_start, range_end, \
                        quote, body, resolved, stale";
const ATT_COLS: &str = "id, author, created_at, updated_at, message_id, kind, name, path, mime";
const REA_COLS: &str = "id, author, created_at, updated_at, message_id, emoji";
const PIN_COLS: &str = "id, author, created_at, updated_at, message_id, kind";
const DRAFT_COLS: &str = "id, author, created_at, updated_at, conversation_id, body";

fn msg_row(r: &Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        conversation_id: col_id(r, 4)?,
        kind: col_parse(r, 5)?,
        body: r.get(6)?,
        source_ref: r.get(7)?,
    })
}

fn cmt_row(r: &Row<'_>) -> rusqlite::Result<Comment> {
    Ok(Comment {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        message_id: col_id(r, 4)?,
        range_start: r.get::<_, i64>(5)? as usize,
        range_end: r.get::<_, i64>(6)? as usize,
        quote: r.get(7)?,
        body: r.get(8)?,
        resolved: r.get(9)?,
        stale: r.get(10)?,
    })
}

fn att_row(r: &Row<'_>) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        message_id: col_id(r, 4)?,
        kind: r.get(5)?,
        name: r.get(6)?,
        path: r.get(7)?,
        mime: r.get(8)?,
    })
}

fn rea_row(r: &Row<'_>) -> rusqlite::Result<Reaction> {
    Ok(Reaction {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        message_id: col_id(r, 4)?,
        emoji: r.get(5)?,
    })
}

fn pin_row(r: &Row<'_>) -> rusqlite::Result<Pin> {
    Ok(Pin {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        message_id: col_id(r, 4)?,
        kind: col_parse(r, 5)?,
    })
}

fn draft_row(r: &Row<'_>) -> rusqlite::Result<Draft> {
    Ok(Draft {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        conversation_id: col_id(r, 4)?,
        body: r.get(5)?,
    })
}

/// Validate a byte range against `body` and return the quoted slice.
fn quote_of(body: &str, start: usize, end: usize) -> Result<&str> {
    if start >= end {
        return Err(Error::invalid("comment range must be non-empty"));
    }
    body.get(start..end)
        .ok_or_else(|| Error::invalid("comment range is out of bounds or splits a character"))
}

impl Store {
    // ---- messages ----

    /// Append a message. When `source_ref` matches an existing message in the
    /// conversation, that message is updated in place instead (idempotent
    /// transcript mirroring) and comments whose anchored text changed turn stale.
    pub fn append_message(&self, new: &NewMessage) -> Result<Message> {
        let tx = self.conn.unchecked_transaction()?;
        let t = now();
        let existing: Option<Id> = match &new.source_ref {
            Some(sr) => tx
                .query_row(
                    "SELECT id FROM message WHERE conversation_id = ?1 AND source_ref = ?2",
                    params![new.conversation_id.to_string(), sr],
                    |r| col_id(r, 0),
                )
                .optional()?,
            None => None,
        };
        let id = match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE message SET body = ?2, kind = ?3, updated_at = ?4 WHERE id = ?1",
                    params![id.to_string(), new.body, new.kind.as_str(), t],
                )?;
                mark_stale(&tx, id, &new.body, t)?;
                id
            }
            None => {
                let id = new_id();
                tx.execute(
                    "INSERT INTO message (id, author, created_at, updated_at, conversation_id,
                         kind, body, source_ref) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        id.to_string(),
                        new.author.to_string(),
                        t,
                        new.conversation_id.to_string(),
                        new.kind.as_str(),
                        new.body,
                        new.source_ref
                    ],
                )?;
                id
            }
        };
        tx.commit()?;
        self.message(id)
    }

    /// Fetch a message.
    pub fn message(&self, id: Id) -> Result<Message> {
        self.conn
            .query_row(
                &format!("SELECT {MSG_COLS} FROM message WHERE id = ?1"),
                [id.to_string()],
                msg_row,
            )
            .optional()?
            .ok_or_else(|| Error::not_found("message", id))
    }

    /// Replace a message body. Comments whose anchored text no longer matches turn stale.
    pub fn edit_message(&self, id: Id, body: &str) -> Result<Message> {
        let tx = self.conn.unchecked_transaction()?;
        let t = now();
        let n = tx.execute(
            "UPDATE message SET body = ?2, updated_at = ?3 WHERE id = ?1",
            params![id.to_string(), body, t],
        )?;
        if n == 0 {
            return Err(Error::not_found("message", id));
        }
        mark_stale(&tx, id, body, t)?;
        tx.commit()?;
        self.message(id)
    }

    /// A page of messages in conversation order (oldest first).
    pub fn list_messages(
        &self,
        conversation_id: Id,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Message>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {MSG_COLS} FROM message WHERE conversation_id = ?1
             ORDER BY created_at, rowid LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = st.query_map(params![conversation_id.to_string(), limit, offset], msg_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Number of messages in a conversation.
    pub fn count_messages(&self, conversation_id: Id) -> Result<u64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM message WHERE conversation_id = ?1",
            [conversation_id.to_string()],
            |r| r.get::<_, i64>(0),
        )? as u64)
    }

    /// Delete a message with its comments, reactions, pins and attachments.
    pub fn delete_message(&self, id: Id) -> Result<()> {
        let n = self
            .conn
            .execute("DELETE FROM message WHERE id = ?1", [id.to_string()])?;
        if n == 0 {
            return Err(Error::not_found("message", id));
        }
        Ok(())
    }

    // ---- comments ----

    /// Anchor a comment to bytes `start..end` of the message body. The range
    /// must be non-empty, in bounds and on character boundaries.
    pub fn create_comment(
        &self,
        author: &Author,
        message_id: Id,
        start: usize,
        end: usize,
        body: &str,
    ) -> Result<Comment> {
        let msg = self.message(message_id)?;
        let quote = quote_of(&msg.body, start, end)?.to_owned();
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT INTO comment (id, author, created_at, updated_at, message_id, range_start,
                 range_end, quote, body) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id.to_string(),
                author.to_string(),
                t,
                message_id.to_string(),
                start as i64,
                end as i64,
                quote,
                body
            ],
        )?;
        self.comment(id)
    }

    /// Fetch a comment.
    pub fn comment(&self, id: Id) -> Result<Comment> {
        self.conn
            .query_row(
                &format!("SELECT {CMT_COLS} FROM comment WHERE id = ?1"),
                [id.to_string()],
                cmt_row,
            )
            .optional()?
            .ok_or_else(|| Error::not_found("comment", id))
    }

    /// Comments on a message, by range start then creation.
    pub fn list_comments(&self, message_id: Id) -> Result<Vec<Comment>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {CMT_COLS} FROM comment WHERE message_id = ?1
             ORDER BY range_start, created_at, rowid"
        ))?;
        let rows = st.query_map([message_id.to_string()], cmt_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Edit the comment text.
    pub fn edit_comment(&self, id: Id, body: &str) -> Result<Comment> {
        let n = self.conn.execute(
            "UPDATE comment SET body = ?2, updated_at = ?3 WHERE id = ?1",
            params![id.to_string(), body, now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("comment", id));
        }
        self.comment(id)
    }

    /// Mark a comment resolved or open.
    pub fn set_comment_resolved(&self, id: Id, resolved: bool) -> Result<Comment> {
        let n = self.conn.execute(
            "UPDATE comment SET resolved = ?2, updated_at = ?3 WHERE id = ?1",
            params![id.to_string(), resolved, now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("comment", id));
        }
        self.comment(id)
    }

    /// Delete a comment.
    pub fn delete_comment(&self, id: Id) -> Result<()> {
        let n = self
            .conn
            .execute("DELETE FROM comment WHERE id = ?1", [id.to_string()])?;
        if n == 0 {
            return Err(Error::not_found("comment", id));
        }
        Ok(())
    }

    // ---- attachments ----

    /// Attach a file path to a message.
    pub fn add_attachment(
        &self,
        author: &Author,
        message_id: Id,
        kind: &str,
        name: &str,
        path: &str,
        mime: Option<&str>,
    ) -> Result<Attachment> {
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT INTO attachment (id, author, created_at, updated_at, message_id, kind, name, path, mime)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id.to_string(), author.to_string(), t, message_id.to_string(), kind, name, path, mime],
        )?;
        Ok(self.conn.query_row(
            &format!("SELECT {ATT_COLS} FROM attachment WHERE id = ?1"),
            [id.to_string()],
            att_row,
        )?)
    }

    /// Attachments of a message.
    pub fn list_attachments(&self, message_id: Id) -> Result<Vec<Attachment>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {ATT_COLS} FROM attachment WHERE message_id = ?1 ORDER BY created_at, rowid"
        ))?;
        let rows = st.query_map([message_id.to_string()], att_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ---- reactions ----

    /// Add a reaction. Repeating the same author and emoji returns the existing row.
    pub fn add_reaction(&self, author: &Author, message_id: Id, emoji: &str) -> Result<Reaction> {
        if emoji.trim().is_empty() {
            return Err(Error::invalid("emoji must not be empty"));
        }
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT OR IGNORE INTO reaction (id, author, created_at, updated_at, message_id, emoji)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
            params![
                id.to_string(),
                author.to_string(),
                t,
                message_id.to_string(),
                emoji
            ],
        )?;
        Ok(self.conn.query_row(
            &format!(
                "SELECT {REA_COLS} FROM reaction WHERE message_id = ?1 AND author = ?2 AND emoji = ?3"
            ),
            params![message_id.to_string(), author.to_string(), emoji],
            rea_row,
        )?)
    }

    /// Remove a reaction; returns whether one existed.
    pub fn remove_reaction(&self, author: &Author, message_id: Id, emoji: &str) -> Result<bool> {
        let n = self.conn.execute(
            "DELETE FROM reaction WHERE message_id = ?1 AND author = ?2 AND emoji = ?3",
            params![message_id.to_string(), author.to_string(), emoji],
        )?;
        Ok(n > 0)
    }

    /// Reactions on a message.
    pub fn list_reactions(&self, message_id: Id) -> Result<Vec<Reaction>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {REA_COLS} FROM reaction WHERE message_id = ?1 ORDER BY created_at, rowid"
        ))?;
        let rows = st.query_map([message_id.to_string()], rea_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Messages carrying a given emoji in a conversation (filter by label).
    pub fn messages_with_reaction(&self, conversation_id: Id, emoji: &str) -> Result<Vec<Message>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {MSG_COLS} FROM message m WHERE conversation_id = ?1
             AND EXISTS (SELECT 1 FROM reaction r WHERE r.message_id = m.id AND r.emoji = ?2)
             ORDER BY created_at, rowid"
        ))?;
        let rows = st.query_map(params![conversation_id.to_string(), emoji], msg_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ---- pins ----

    /// Pin or save a message. Repeating returns the existing row.
    pub fn add_pin(&self, author: &Author, message_id: Id, kind: PinKind) -> Result<Pin> {
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT OR IGNORE INTO pin (id, author, created_at, updated_at, message_id, kind)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
            params![
                id.to_string(),
                author.to_string(),
                t,
                message_id.to_string(),
                kind.as_str()
            ],
        )?;
        Ok(self.conn.query_row(
            &format!("SELECT {PIN_COLS} FROM pin WHERE message_id = ?1 AND kind = ?2"),
            params![message_id.to_string(), kind.as_str()],
            pin_row,
        )?)
    }

    /// Remove a pin; returns whether one existed.
    pub fn remove_pin(&self, message_id: Id, kind: PinKind) -> Result<bool> {
        let n = self.conn.execute(
            "DELETE FROM pin WHERE message_id = ?1 AND kind = ?2",
            params![message_id.to_string(), kind.as_str()],
        )?;
        Ok(n > 0)
    }

    /// Pins of one kind across the workspace's conversations, newest first.
    pub fn list_pins(&self, conversation_id: Id, kind: PinKind) -> Result<Vec<Pin>> {
        let mut st = self.conn.prepare(
            "SELECT p.id, p.author, p.created_at, p.updated_at, p.message_id, p.kind
             FROM pin p JOIN message m ON m.id = p.message_id
             WHERE m.conversation_id = ?1 AND p.kind = ?2
             ORDER BY p.created_at DESC, p.rowid DESC",
        )?;
        let rows = st.query_map(params![conversation_id.to_string(), kind.as_str()], pin_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ---- drafts ----

    /// Save the composer draft of a conversation (one per conversation).
    /// An empty body clears the draft.
    pub fn set_draft(
        &self,
        author: &Author,
        conversation_id: Id,
        body: &str,
    ) -> Result<Option<Draft>> {
        if body.is_empty() {
            self.clear_draft(conversation_id)?;
            return Ok(None);
        }
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT INTO draft (id, author, created_at, updated_at, conversation_id, body)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5)
             ON CONFLICT(conversation_id) DO UPDATE SET
                 body = excluded.body, author = excluded.author, updated_at = excluded.updated_at",
            params![
                id.to_string(),
                author.to_string(),
                t,
                conversation_id.to_string(),
                body
            ],
        )?;
        self.draft(conversation_id)
    }

    /// The draft of a conversation, if any.
    pub fn draft(&self, conversation_id: Id) -> Result<Option<Draft>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {DRAFT_COLS} FROM draft WHERE conversation_id = ?1"),
                [conversation_id.to_string()],
                draft_row,
            )
            .optional()?)
    }

    /// Drop the draft of a conversation.
    pub fn clear_draft(&self, conversation_id: Id) -> Result<()> {
        self.conn.execute(
            "DELETE FROM draft WHERE conversation_id = ?1",
            [conversation_id.to_string()],
        )?;
        Ok(())
    }
}

/// Flag comments whose recorded quote no longer sits at its range in `body`.
fn mark_stale(tx: &rusqlite::Transaction<'_>, message_id: Id, body: &str, t: i64) -> Result<()> {
    let anchors: Vec<(String, i64, i64, String)> = {
        let mut st = tx.prepare(
            "SELECT id, range_start, range_end, quote FROM comment WHERE message_id = ?1",
        )?;
        let rows = st.query_map([message_id.to_string()], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (cid, s, e, quote) in anchors {
        let ok = body.get(s as usize..e as usize) == Some(quote.as_str());
        tx.execute(
            "UPDATE comment SET stale = ?2, updated_at = ?3 WHERE id = ?1 AND stale <> ?2",
            params![cid, !ok, t],
        )?;
    }
    Ok(())
}
