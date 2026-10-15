//! Workspaces, sections, conversations, memberships.

use rusqlite::{params, OptionalExtension, Row};

use crate::error::{Error, Result};
use crate::store::{col_author, col_id, col_opt_id, col_opt_parse, col_parse, new_id, now, Store};
use crate::types::{
    Author, Conversation, ConversationKind, Id, Membership, NewConversation, Section, SectionKind,
    Workspace,
};

const WS_COLS: &str = "id, author, created_at, updated_at, name";
const SEC_COLS: &str = "id, author, created_at, updated_at, workspace_id, name, position, \
                        collapsed, folder, archive_days, kind, emoji";
const CONV_COLS: &str = "id, author, created_at, updated_at, workspace_id, section_id, position, \
                         kind, name, provider, cwd, worktree, session_id, adapter_state, \
                         assign_mode, lead_id, starred, archived";
const MEM_COLS: &str = "id, author, created_at, updated_at, channel_id, dm_id";

fn ws_row(r: &Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        name: r.get(4)?,
    })
}

fn sec_row(r: &Row<'_>) -> rusqlite::Result<Section> {
    Ok(Section {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        workspace_id: col_id(r, 4)?,
        name: r.get(5)?,
        position: r.get(6)?,
        collapsed: r.get(7)?,
        folder: r.get(8)?,
        archive_days: r.get(9)?,
        kind: col_parse(r, 10)?,
        emoji: r.get(11)?,
    })
}

fn conv_row(r: &Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        workspace_id: col_id(r, 4)?,
        section_id: col_opt_id(r, 5)?,
        position: r.get(6)?,
        kind: col_parse(r, 7)?,
        name: r.get(8)?,
        provider: r.get(9)?,
        cwd: r.get(10)?,
        worktree: r.get(11)?,
        session_id: r.get(12)?,
        adapter_state: r.get(13)?,
        assign_mode: col_opt_parse(r, 14)?,
        lead_id: col_opt_id(r, 15)?,
        starred: r.get(16)?,
        archived: r.get(17)?,
    })
}

fn mem_row(r: &Row<'_>) -> rusqlite::Result<Membership> {
    Ok(Membership {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        channel_id: col_id(r, 4)?,
        dm_id: col_id(r, 5)?,
    })
}

fn require_nonempty(what: &str, v: &str) -> Result<()> {
    if v.trim().is_empty() {
        return Err(Error::invalid(format!("{what} must not be empty")));
    }
    Ok(())
}

/// Longest emoji field kept, in bytes: room for a ZWJ family sequence, not for prose.
const MAX_EMOJI_BYTES: usize = 32;

/// Trim an emoji field; blank means none.
fn clean_emoji(emoji: Option<&str>) -> Result<Option<String>> {
    let e = emoji.map(str::trim).filter(|e| !e.is_empty());
    if let Some(e) = e {
        if e.len() > MAX_EMOJI_BYTES {
            return Err(Error::invalid("emoji is too long"));
        }
    }
    Ok(e.map(str::to_owned))
}

impl Store {
    // ---- workspaces ----

    /// Create a workspace.
    pub fn create_workspace(&self, author: &Author, name: &str) -> Result<Workspace> {
        require_nonempty("workspace name", name)?;
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT INTO workspace (id, author, created_at, updated_at, name) VALUES (?1, ?2, ?3, ?3, ?4)",
            params![id.to_string(), author.to_string(), t, name],
        )?;
        self.workspace(id)
    }

    /// Fetch a workspace.
    pub fn workspace(&self, id: Id) -> Result<Workspace> {
        self.conn
            .query_row(
                &format!("SELECT {WS_COLS} FROM workspace WHERE id = ?1"),
                [id.to_string()],
                ws_row,
            )
            .optional()?
            .ok_or_else(|| Error::not_found("workspace", id))
    }

    /// All workspaces, oldest first.
    pub fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {WS_COLS} FROM workspace ORDER BY created_at, rowid"
        ))?;
        let rows = st.query_map([], ws_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Rename a workspace.
    pub fn rename_workspace(&self, id: Id, name: &str) -> Result<Workspace> {
        require_nonempty("workspace name", name)?;
        let n = self.conn.execute(
            "UPDATE workspace SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id.to_string(), name, now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("workspace", id));
        }
        self.workspace(id)
    }

    /// Delete a workspace and everything under it.
    pub fn delete_workspace(&self, id: Id) -> Result<()> {
        let n = self
            .conn
            .execute("DELETE FROM workspace WHERE id = ?1", [id.to_string()])?;
        if n == 0 {
            return Err(Error::not_found("workspace", id));
        }
        Ok(())
    }

    // ---- sections ----

    /// Append a section at the end of the workspace.
    pub fn create_section(&self, author: &Author, workspace_id: Id, name: &str) -> Result<Section> {
        self.create_section_of(author, workspace_id, name, SectionKind::Section, None)
    }

    /// Append a section or a divider, with an optional emoji. A divider may have an empty name
    /// (a rule with no label); a section may not.
    pub fn create_section_of(
        &self,
        author: &Author,
        workspace_id: Id,
        name: &str,
        kind: SectionKind,
        emoji: Option<&str>,
    ) -> Result<Section> {
        let name = name.trim();
        if kind == SectionKind::Section {
            require_nonempty("section name", name)?;
        }
        let emoji = clean_emoji(emoji)?;
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT INTO section (id, author, created_at, updated_at, workspace_id, name, position,
                                  kind, emoji)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5,
                     (SELECT COALESCE(MAX(position) + 1, 0) FROM section WHERE workspace_id = ?4),
                     ?6, ?7)",
            params![
                id.to_string(),
                author.to_string(),
                t,
                workspace_id.to_string(),
                name,
                kind.as_str(),
                emoji
            ],
        )?;
        self.section(id)
    }

    /// Set or clear the emoji of a section or divider.
    pub fn set_section_emoji(&self, id: Id, emoji: Option<&str>) -> Result<Section> {
        let emoji = clean_emoji(emoji)?;
        let n = self.conn.execute(
            "UPDATE section SET emoji = ?2, updated_at = ?3 WHERE id = ?1",
            params![id.to_string(), emoji, now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("section", id));
        }
        self.section(id)
    }

    /// Append a folder section: a section with a home folder, placed last.
    pub fn create_folder_section(
        &self,
        author: &Author,
        workspace_id: Id,
        name: &str,
        folder: &str,
    ) -> Result<Section> {
        require_nonempty("folder", folder)?;
        let section = self.create_section(author, workspace_id, name)?;
        self.conn.execute(
            "UPDATE section SET folder = ?2 WHERE id = ?1",
            params![section.id.to_string(), folder],
        )?;
        self.section(section.id)
    }

    /// Set the "Older than X days" threshold of a section (1 to 3650 days).
    pub fn set_section_archive_days(&self, id: Id, days: i64) -> Result<Section> {
        if !(1..=3650).contains(&days) {
            return Err(Error::invalid("archive days must be between 1 and 3650"));
        }
        let n = self.conn.execute(
            "UPDATE section SET archive_days = ?2, updated_at = ?3 WHERE id = ?1",
            params![id.to_string(), days, now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("section", id));
        }
        self.section(id)
    }

    /// Session ids the user hid from a folder section.
    pub fn folder_hidden(&self, section_id: Id) -> Result<std::collections::HashSet<String>> {
        let mut st = self
            .conn
            .prepare("SELECT session_id FROM folder_hidden WHERE section_id = ?1")?;
        let rows = st.query_map([section_id.to_string()], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Hide or unhide a session in a folder section's list. Idempotent.
    pub fn set_folder_hidden(
        &self,
        author: &Author,
        section_id: Id,
        session_id: &str,
        hidden: bool,
    ) -> Result<()> {
        self.section(section_id)?;
        if hidden {
            let t = now();
            self.conn.execute(
                "INSERT OR IGNORE INTO folder_hidden
                     (id, author, created_at, updated_at, section_id, session_id)
                 VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
                params![
                    new_id().to_string(),
                    author.to_string(),
                    t,
                    section_id.to_string(),
                    session_id
                ],
            )?;
        } else {
            self.conn.execute(
                "DELETE FROM folder_hidden WHERE section_id = ?1 AND session_id = ?2",
                params![section_id.to_string(), session_id],
            )?;
        }
        Ok(())
    }

    /// The DM conversation that runs a Claude session id, if one exists.
    pub fn conversation_by_session(
        &self,
        workspace_id: Id,
        session_id: &str,
    ) -> Result<Option<Conversation>> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT {CONV_COLS} FROM conversation
                     WHERE workspace_id = ?1 AND kind = 'dm' AND session_id = ?2
                     ORDER BY rowid LIMIT 1"
                ),
                params![workspace_id.to_string(), session_id],
                conv_row,
            )
            .optional()?)
    }

    /// Fetch a section.
    pub fn section(&self, id: Id) -> Result<Section> {
        self.conn
            .query_row(
                &format!("SELECT {SEC_COLS} FROM section WHERE id = ?1"),
                [id.to_string()],
                sec_row,
            )
            .optional()?
            .ok_or_else(|| Error::not_found("section", id))
    }

    /// Sections of a workspace in display order.
    pub fn list_sections(&self, workspace_id: Id) -> Result<Vec<Section>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {SEC_COLS} FROM section WHERE workspace_id = ?1 ORDER BY position, rowid"
        ))?;
        let rows = st.query_map([workspace_id.to_string()], sec_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Rename a section. A divider may be renamed to the empty string (no label).
    pub fn rename_section(&self, id: Id, name: &str) -> Result<Section> {
        let name = name.trim();
        if self.section(id)?.kind == SectionKind::Section {
            require_nonempty("section name", name)?;
        }
        let n = self.conn.execute(
            "UPDATE section SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id.to_string(), name, now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("section", id));
        }
        self.section(id)
    }

    /// Collapse or expand a section.
    pub fn set_section_collapsed(&self, id: Id, collapsed: bool) -> Result<Section> {
        let n = self.conn.execute(
            "UPDATE section SET collapsed = ?2, updated_at = ?3 WHERE id = ?1",
            params![id.to_string(), collapsed, now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("section", id));
        }
        self.section(id)
    }

    /// Set the order of a workspace's sections. `ordered` must list every section exactly once.
    pub fn reorder_sections(&self, workspace_id: Id, ordered: &[Id]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let current: Vec<Id> = self
            .list_sections(workspace_id)?
            .into_iter()
            .map(|s| s.id)
            .collect();
        check_permutation(&current, ordered)?;
        let t = now();
        for (pos, id) in ordered.iter().enumerate() {
            tx.execute(
                "UPDATE section SET position = ?2, updated_at = ?3 WHERE id = ?1",
                params![id.to_string(), pos as i64, t],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Delete a section. Its conversations become unplaced.
    pub fn delete_section(&self, id: Id) -> Result<()> {
        let n = self
            .conn
            .execute("DELETE FROM section WHERE id = ?1", [id.to_string()])?;
        if n == 0 {
            return Err(Error::not_found("section", id));
        }
        Ok(())
    }

    // ---- conversations ----

    /// Create a DM or channel, placed last in its section.
    pub fn create_conversation(
        &self,
        author: &Author,
        new: &NewConversation,
    ) -> Result<Conversation> {
        require_nonempty("conversation name", &new.name)?;
        if new.kind == ConversationKind::Dm && new.assign_mode.is_some() {
            return Err(Error::invalid("assign_mode applies to channels only"));
        }
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT INTO conversation (id, author, created_at, updated_at, workspace_id, section_id,
                 position, kind, name, provider, cwd, worktree, session_id, assign_mode)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM conversation WHERE section_id IS ?5),
                 ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id.to_string(),
                author.to_string(),
                t,
                new.workspace_id.to_string(),
                new.section_id.map(|s| s.to_string()),
                new.kind.as_str(),
                new.name,
                new.provider,
                new.cwd,
                new.worktree,
                new.session_id,
                new.assign_mode.map(|m| m.as_str()),
            ],
        )?;
        self.conversation(id)
    }

    /// Fetch a conversation.
    pub fn conversation(&self, id: Id) -> Result<Conversation> {
        self.conn
            .query_row(
                &format!("SELECT {CONV_COLS} FROM conversation WHERE id = ?1"),
                [id.to_string()],
                conv_row,
            )
            .optional()?
            .ok_or_else(|| Error::not_found("conversation", id))
    }

    /// Conversations of a workspace, grouped by section order then position.
    pub fn list_conversations(&self, workspace_id: Id) -> Result<Vec<Conversation>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {CONV_COLS} FROM conversation c WHERE workspace_id = ?1
             ORDER BY (SELECT position FROM section s WHERE s.id = c.section_id) IS NULL,
                      (SELECT position FROM section s WHERE s.id = c.section_id), position, rowid"
        ))?;
        let rows = st.query_map([workspace_id.to_string()], conv_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Conversations in one section, in order.
    pub fn list_section_conversations(&self, section_id: Id) -> Result<Vec<Conversation>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {CONV_COLS} FROM conversation WHERE section_id = ?1 ORDER BY position, rowid"
        ))?;
        let rows = st.query_map([section_id.to_string()], conv_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Rename a conversation.
    pub fn rename_conversation(&self, id: Id, name: &str) -> Result<Conversation> {
        require_nonempty("conversation name", name)?;
        self.touch_conv(
            id,
            "UPDATE conversation SET name = ?2, updated_at = ?3 WHERE id = ?1",
            name,
        )
    }

    /// Record the CLI session id (used for `--resume`).
    pub fn set_conversation_session(
        &self,
        id: Id,
        session_id: Option<&str>,
    ) -> Result<Conversation> {
        let n = self.conn.execute(
            "UPDATE conversation SET session_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id.to_string(), session_id, now()],
        )?;
        self.after_update(n, id)
    }

    /// Record the worktree path.
    pub fn set_conversation_worktree(
        &self,
        id: Id,
        worktree: Option<&str>,
    ) -> Result<Conversation> {
        let n = self.conn.execute(
            "UPDATE conversation SET worktree = ?2, updated_at = ?3 WHERE id = ?1",
            params![id.to_string(), worktree, now()],
        )?;
        self.after_update(n, id)
    }

    /// Replace the opaque adapter state. Must be valid-looking JSON text (object or array).
    pub fn set_adapter_state(&self, id: Id, json: &str) -> Result<Conversation> {
        let t = json.trim();
        if !(t.starts_with('{') && t.ends_with('}') || t.starts_with('[') && t.ends_with(']')) {
            return Err(Error::invalid(
                "adapter state must be a JSON object or array",
            ));
        }
        self.touch_conv(
            id,
            "UPDATE conversation SET adapter_state = ?2, updated_at = ?3 WHERE id = ?1",
            json,
        )
    }

    /// Set the channel assignment mode and optional lead DM.
    pub fn set_assign_mode(
        &self,
        channel_id: Id,
        mode: crate::types::AssignMode,
        lead: Option<Id>,
    ) -> Result<Conversation> {
        let chan = self.conversation(channel_id)?;
        if chan.kind != ConversationKind::Channel {
            return Err(Error::invalid("assign mode applies to channels only"));
        }
        let n = self.conn.execute(
            "UPDATE conversation SET assign_mode = ?2, lead_id = ?3, updated_at = ?4 WHERE id = ?1",
            params![
                channel_id.to_string(),
                mode.as_str(),
                lead.map(|l| l.to_string()),
                now()
            ],
        )?;
        self.after_update(n, channel_id)
    }

    /// Move a conversation to `section_id` (or unplace it) at `index`, renumbering neighbors.
    pub fn move_conversation(&self, id: Id, section_id: Option<Id>, index: usize) -> Result<()> {
        let conv = self.conversation(id)?;
        let tx = self.conn.unchecked_transaction()?;
        if let Some(s) = section_id {
            let sec = self.section(s)?;
            if sec.workspace_id != conv.workspace_id {
                return Err(Error::invalid("section belongs to a different workspace"));
            }
            if sec.kind == SectionKind::Divider {
                return Err(Error::invalid("a divider cannot hold conversations"));
            }
        }
        let mut ids: Vec<String> = {
            let mut st = tx.prepare(
                "SELECT id FROM conversation WHERE section_id IS ?1 AND id <> ?2
                 ORDER BY position, rowid",
            )?;
            let rows = st.query_map(
                params![section_id.map(|s| s.to_string()), id.to_string()],
                |r| r.get(0),
            )?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        ids.insert(index.min(ids.len()), id.to_string());
        let t = now();
        for (pos, cid) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE conversation SET section_id = ?2, position = ?3, updated_at = ?4 WHERE id = ?1",
                params![cid, section_id.map(|s| s.to_string()), pos as i64, t],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Delete a conversation with its messages, tasks and drafts.
    pub fn delete_conversation(&self, id: Id) -> Result<()> {
        let n = self
            .conn
            .execute("DELETE FROM conversation WHERE id = ?1", [id.to_string()])?;
        if n == 0 {
            return Err(Error::not_found("conversation", id));
        }
        Ok(())
    }

    fn touch_conv(&self, id: Id, sql: &str, val: &str) -> Result<Conversation> {
        let n = self
            .conn
            .execute(sql, params![id.to_string(), val, now()])?;
        self.after_update(n, id)
    }

    fn after_update(&self, changed: usize, id: Id) -> Result<Conversation> {
        if changed == 0 {
            return Err(Error::not_found("conversation", id));
        }
        self.conversation(id)
    }

    // ---- memberships ----

    /// Add a DM to a channel. Adding twice returns the existing membership.
    pub fn add_member(&self, author: &Author, channel_id: Id, dm_id: Id) -> Result<Membership> {
        let chan = self.conversation(channel_id)?;
        let dm = self.conversation(dm_id)?;
        if chan.kind != ConversationKind::Channel || dm.kind != ConversationKind::Dm {
            return Err(Error::invalid("membership links a channel to a dm"));
        }
        if let Some(m) = self.find_member(channel_id, dm_id)? {
            return Ok(m);
        }
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT INTO membership (id, author, created_at, updated_at, channel_id, dm_id)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
            params![
                id.to_string(),
                author.to_string(),
                t,
                channel_id.to_string(),
                dm_id.to_string()
            ],
        )?;
        self.find_member(channel_id, dm_id)?
            .ok_or_else(|| Error::not_found("membership", id))
    }

    fn find_member(&self, channel_id: Id, dm_id: Id) -> Result<Option<Membership>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {MEM_COLS} FROM membership WHERE channel_id = ?1 AND dm_id = ?2"),
                [channel_id.to_string(), dm_id.to_string()],
                mem_row,
            )
            .optional()?)
    }

    /// Remove a DM from a channel.
    pub fn remove_member(&self, channel_id: Id, dm_id: Id) -> Result<()> {
        let n = self.conn.execute(
            "DELETE FROM membership WHERE channel_id = ?1 AND dm_id = ?2",
            [channel_id.to_string(), dm_id.to_string()],
        )?;
        if n == 0 {
            return Err(Error::not_found(
                "membership",
                format!("{channel_id}/{dm_id}"),
            ));
        }
        Ok(())
    }

    /// Members of a channel in join order.
    pub fn list_members(&self, channel_id: Id) -> Result<Vec<Membership>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {MEM_COLS} FROM membership WHERE channel_id = ?1 ORDER BY created_at, rowid"
        ))?;
        let rows = st.query_map([channel_id.to_string()], mem_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Channels a DM has joined.
    pub fn list_channels_of(&self, dm_id: Id) -> Result<Vec<Membership>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {MEM_COLS} FROM membership WHERE dm_id = ?1 ORDER BY created_at, rowid"
        ))?;
        let rows = st.query_map([dm_id.to_string()], mem_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

pub(crate) fn check_permutation(current: &[Id], ordered: &[Id]) -> Result<()> {
    let mut a = current.to_vec();
    let mut b = ordered.to_vec();
    a.sort();
    b.sort();
    if a != b {
        return Err(Error::invalid(
            "ordering must list every existing item exactly once",
        ));
    }
    Ok(())
}
