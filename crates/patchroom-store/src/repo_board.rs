//! Channel task board: tasks and path claims.

use rusqlite::{params, OptionalExtension, Row};

use crate::error::{Error, Result};
use crate::repo_workspace::check_permutation;
use crate::store::{col_author, col_id, col_opt_author, col_parse, new_id, now, Store};
use crate::types::{Author, Claim, ConversationKind, Id, NewTask, Task, TaskGit, TaskStatus};

const TASK_COLS: &str = "id, author, created_at, updated_at, channel_id, title, description, \
                         owner, status, worktree, branch, pr_url, position";
const CLAIM_COLS: &str = "id, author, created_at, updated_at, task_id, path, released_at";

fn task_row(r: &Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        channel_id: col_id(r, 4)?,
        title: r.get(5)?,
        description: r.get(6)?,
        owner: col_opt_author(r, 7)?,
        status: col_parse(r, 8)?,
        worktree: r.get(9)?,
        branch: r.get(10)?,
        pr_url: r.get(11)?,
        position: r.get(12)?,
    })
}

fn claim_row(r: &Row<'_>) -> rusqlite::Result<Claim> {
    Ok(Claim {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        task_id: col_id(r, 4)?,
        path: r.get(5)?,
        released_at: r.get(6)?,
    })
}

/// Normalize a claimed path: forward slashes, no `.` or empty parts, no `..`, no leading slash.
pub fn normalize_claim_path(path: &str) -> Result<String> {
    let mut parts = Vec::new();
    let unified = path.replace('\\', "/");
    for p in unified.split('/') {
        match p {
            "" | "." => {}
            ".." => return Err(Error::invalid("claim path must not contain '..'")),
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        return Err(Error::invalid("claim path must not be empty"));
    }
    Ok(parts.join("/"))
}

/// True when one normalized path equals or contains the other.
pub fn paths_overlap(a: &str, b: &str) -> bool {
    a == b
        || a.strip_prefix(b).is_some_and(|r| r.starts_with('/'))
        || b.strip_prefix(a).is_some_and(|r| r.starts_with('/'))
}

/// Two active claims on overlapping paths held by different tasks.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimConflict {
    /// First claim.
    pub a: Claim,
    /// Second claim.
    pub b: Claim,
}

impl Store {
    /// Add a card to the end of a channel's board.
    pub fn create_task(&self, author: &Author, new: &NewTask) -> Result<Task> {
        if new.title.trim().is_empty() {
            return Err(Error::invalid("task title must not be empty"));
        }
        let chan = self.conversation(new.channel_id)?;
        if chan.kind != ConversationKind::Channel {
            return Err(Error::invalid("tasks live on channels"));
        }
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT INTO task (id, author, created_at, updated_at, channel_id, title, description, position)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM task WHERE channel_id = ?4))",
            params![
                id.to_string(),
                author.to_string(),
                t,
                new.channel_id.to_string(),
                new.title,
                new.description
            ],
        )?;
        self.task(id)
    }

    /// Fetch a task.
    pub fn task(&self, id: Id) -> Result<Task> {
        self.conn
            .query_row(
                &format!("SELECT {TASK_COLS} FROM task WHERE id = ?1"),
                [id.to_string()],
                task_row,
            )
            .optional()?
            .ok_or_else(|| Error::not_found("task", id))
    }

    /// The board of a channel in order.
    pub fn list_tasks(&self, channel_id: Id) -> Result<Vec<Task>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {TASK_COLS} FROM task WHERE channel_id = ?1 ORDER BY position, rowid"
        ))?;
        let rows = st.query_map([channel_id.to_string()], task_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Reserve an unowned task for `claimer`. Fails with `Conflict` when it already has an owner.
    pub fn claim_task(&self, task_id: Id, claimer: &Author) -> Result<Task> {
        let n = self.conn.execute(
            "UPDATE task SET owner = ?2, status = 'claimed', updated_at = ?3
             WHERE id = ?1 AND owner IS NULL",
            params![task_id.to_string(), claimer.to_string(), now()],
        )?;
        if n == 0 {
            let t = self.task(task_id)?;
            return Err(Error::Conflict(format!(
                "task already owned by {}",
                t.owner.map(|o| o.to_string()).unwrap_or_default()
            )));
        }
        self.task(task_id)
    }

    /// Assign (or clear) the owner directly, as an @mention or lead dispatch does.
    pub fn assign_task(&self, task_id: Id, owner: Option<&Author>) -> Result<Task> {
        let n = self.conn.execute(
            "UPDATE task SET owner = ?2, updated_at = ?3,
                 status = CASE WHEN ?2 IS NULL AND status = 'claimed' THEN 'todo'
                               WHEN ?2 IS NOT NULL AND status = 'todo' THEN 'claimed'
                               ELSE status END
             WHERE id = ?1",
            params![task_id.to_string(), owner.map(|o| o.to_string()), now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("task", task_id));
        }
        self.task(task_id)
    }

    /// Move a card to another column.
    pub fn set_task_status(&self, task_id: Id, status: TaskStatus) -> Result<Task> {
        let n = self.conn.execute(
            "UPDATE task SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![task_id.to_string(), status.as_str(), now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("task", task_id));
        }
        self.task(task_id)
    }

    /// Edit title and description.
    pub fn edit_task(&self, task_id: Id, title: &str, description: &str) -> Result<Task> {
        if title.trim().is_empty() {
            return Err(Error::invalid("task title must not be empty"));
        }
        let n = self.conn.execute(
            "UPDATE task SET title = ?2, description = ?3, updated_at = ?4 WHERE id = ?1",
            params![task_id.to_string(), title, description, now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("task", task_id));
        }
        self.task(task_id)
    }

    /// Record worktree, branch and PR for a card.
    pub fn set_task_git(&self, task_id: Id, git: &TaskGit) -> Result<Task> {
        let n = self.conn.execute(
            "UPDATE task SET worktree = ?2, branch = ?3, pr_url = ?4, updated_at = ?5 WHERE id = ?1",
            params![task_id.to_string(), git.worktree, git.branch, git.pr_url, now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("task", task_id));
        }
        self.task(task_id)
    }

    /// Reorder a channel's board. `ordered` must list every task exactly once.
    pub fn reorder_tasks(&self, channel_id: Id, ordered: &[Id]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let current: Vec<Id> = self
            .list_tasks(channel_id)?
            .into_iter()
            .map(|t| t.id)
            .collect();
        check_permutation(&current, ordered)?;
        let t = now();
        for (pos, id) in ordered.iter().enumerate() {
            tx.execute(
                "UPDATE task SET position = ?2, updated_at = ?3 WHERE id = ?1",
                params![id.to_string(), pos as i64, t],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Delete a card with its claims.
    pub fn delete_task(&self, task_id: Id) -> Result<()> {
        let n = self
            .conn
            .execute("DELETE FROM task WHERE id = ?1", [task_id.to_string()])?;
        if n == 0 {
            return Err(Error::not_found("task", task_id));
        }
        Ok(())
    }

    // ---- claims ----

    /// Claim a file or area for a task. The path is normalized first.
    pub fn claim_path(&self, claimer: &Author, task_id: Id, path: &str) -> Result<Claim> {
        let path = normalize_claim_path(path)?;
        self.task(task_id)?;
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT INTO claim (id, author, created_at, updated_at, task_id, path)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
            params![
                id.to_string(),
                claimer.to_string(),
                t,
                task_id.to_string(),
                path
            ],
        )?;
        self.claim(id)
    }

    /// Fetch a claim.
    pub fn claim(&self, id: Id) -> Result<Claim> {
        self.conn
            .query_row(
                &format!("SELECT {CLAIM_COLS} FROM claim WHERE id = ?1"),
                [id.to_string()],
                claim_row,
            )
            .optional()?
            .ok_or_else(|| Error::not_found("claim", id))
    }

    /// Release a claim (kept for history, no longer active).
    pub fn release_claim(&self, id: Id) -> Result<Claim> {
        let t = now();
        let n = self.conn.execute(
            "UPDATE claim SET released_at = ?2, updated_at = ?2 WHERE id = ?1 AND released_at IS NULL",
            params![id.to_string(), t],
        )?;
        if n == 0 {
            self.claim(id)?;
        }
        self.claim(id)
    }

    /// Claims of one task, active and released.
    pub fn list_task_claims(&self, task_id: Id) -> Result<Vec<Claim>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {CLAIM_COLS} FROM claim WHERE task_id = ?1 ORDER BY created_at, rowid"
        ))?;
        let rows = st.query_map([task_id.to_string()], claim_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Active claims across a channel's board.
    pub fn list_active_claims(&self, channel_id: Id) -> Result<Vec<Claim>> {
        let mut st = self.conn.prepare(
            "SELECT c.id, c.author, c.created_at, c.updated_at, c.task_id, c.path, c.released_at
             FROM claim c JOIN task t ON t.id = c.task_id
             WHERE t.channel_id = ?1 AND c.released_at IS NULL
             ORDER BY c.created_at, c.rowid",
        )?;
        let rows = st.query_map([channel_id.to_string()], claim_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Overlapping active claims held by different tasks, for the board to flag.
    pub fn find_claim_conflicts(&self, channel_id: Id) -> Result<Vec<ClaimConflict>> {
        let claims = self.list_active_claims(channel_id)?;
        let mut out = Vec::new();
        for (i, a) in claims.iter().enumerate() {
            for b in &claims[i + 1..] {
                if a.task_id != b.task_id && paths_overlap(&a.path, &b.path) {
                    out.push(ClaimConflict {
                        a: a.clone(),
                        b: b.clone(),
                    });
                }
            }
        }
        Ok(out)
    }
}
