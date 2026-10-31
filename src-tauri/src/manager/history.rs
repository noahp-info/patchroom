//! The History panel: every Claude Code session on this Mac, across all folders.
//!
//! Listing is a read-only scan of the transcript roots (`patchroom-folders::history`). It
//! never writes under the Claude config dir and reports only a title, the first prompt and
//! where the session ran. Opening a row goes through the folder-section open path: an open
//! DM is returned as it is, a new one is created and started with `claude --resume <id>` in
//! the session's launch folder, and a session that runs in another process comes back as a
//! read-only mirror, never a second copy.

use std::collections::HashMap;

use patchroom_folders::encode::is_under;
use patchroom_folders::{HistoryListing, HistoryQuery};
use patchroom_store::ConversationKind;

use super::{lock, Arc, Error, Manager, Result, SessionInfo};

impl Manager {
    /// `history_sessions {}`: every resumable session across all folders, newest first.
    /// Read only; nothing starts.
    ///
    /// # Errors
    /// Store failures.
    pub fn history_sessions(self: &Arc<Self>) -> Result<HistoryListing> {
        let named = self.dms_by_session()?;
        let (live, live_checked) = self.live_elsewhere(&named);
        let dms: HashMap<String, String> =
            named.into_iter().map(|(sid, (dm, _))| (sid, dm)).collect();
        let roots = self.projects_dirs();
        Ok(self.folders.history.list(&HistoryQuery {
            projects_dirs: &roots,
            dms: &dms,
            live: &live,
            live_checked,
        }))
    }

    /// `history_session_open {sessionId, openAnyway?}`: the DM of a session from History.
    /// A new DM goes into the folder section that holds its launch folder, else ungrouped.
    ///
    /// # Errors
    /// A bad or unknown session id, a launch folder that no longer exists, a failed spawn or a
    /// re-check that did not finish.
    pub fn history_session_open(
        self: &Arc<Self>,
        session_id: &str,
        open_anyway: bool,
    ) -> Result<SessionInfo> {
        if !patchroom_folders::discover::is_session_id(session_id) {
            return Err(Error::Invalid("bad session id".into()));
        }
        let existing = lock(&self.store).conversation_by_session(self.workspace, session_id)?;
        let created = existing.is_none();
        let dm_id = if let Some(c) = existing {
            c.id.to_string()
        } else {
            let found = self
                .history_sessions()?
                .sessions
                .into_iter()
                .find(|s| s.session_id == session_id)
                .ok_or_else(|| Error::Invalid(format!("no such session: {session_id}")))?;
            let section = lock(&self.store)
                .list_sections(self.workspace)?
                .into_iter()
                .filter(|s| {
                    s.folder
                        .as_deref()
                        .is_some_and(|f| is_under(f, &found.launch_cwd))
                })
                // The deepest folder wins: a section for `app/web` beats one for `app`.
                .max_by_key(|s| s.folder.as_deref().map_or(0, str::len))
                .map(|s| s.id);
            self.create_resume_dm(section, &found.title, &found.launch_cwd, &found.session_id)?
        };
        self.start_resumable(&dm_id, created, open_anyway)?;
        self.list()?
            .into_iter()
            .find(|s| s.id == dm_id)
            .ok_or(Error::NoSession(dm_id))
    }

    /// Patchroom DMs by Claude session id: `(dm id, dm name)`.
    fn dms_by_session(&self) -> Result<HashMap<String, (String, String)>> {
        let store = lock(&self.store);
        let mut dms = HashMap::new();
        for c in store.list_conversations(self.workspace)? {
            if c.kind == ConversationKind::Dm {
                if let Some(sid) = c.session_id {
                    dms.entry(sid).or_insert((c.id.to_string(), c.name));
                }
            }
        }
        Ok(dms)
    }
}
