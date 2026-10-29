//! Folder sections: sessions discovered under a home folder.
//!
//! A folder section lists the resumable Claude Code sessions whose launch folder is the home
//! folder, a folder inside it, or a linked git worktree of it (see `patchroom-folders`).
//! Discovery is read only: transcripts, the session-naming registry and git metadata are read
//! in place and nothing is written under the Claude config dir. A discovered session is a row,
//! not a process; [`Manager::folder_session_open`] creates its DM and runs
//! `claude --resume <id>` from the folder the transcript is filed under.
//!
//! A poller (1 s) compares a cheap fingerprint of each folder section's transcript directories
//! and emits `folder:changed {sectionId}` when a transcript appears or is written, so a session
//! started in another terminal shows up within about two seconds. Who runs a session elsewhere
//! comes from `claude agents --json` (the same source the presence reconciler uses), cached
//! for [`LIVE_TTL`] and refreshed in the background, never on the listing's critical path.
//! Until the first answer (and whenever the last one is older than [`LIVE_STALE`]) every row
//! reports `liveState: "checking"`, never "free". Opening a row re-checks synchronously and
//! mirrors a session that runs elsewhere instead of spawning it (see the `mirror` module).
//!
//! # Locks
//! `FolderState` mutexes are leaves: never held across a store, presence or sink call.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Weak;
use std::time::Instant;

use patchroom_folders::encode::{is_under, normalize};
use patchroom_folders::{signature, Discovery, FolderSession, Listing, Query};
use patchroom_store::{ConversationKind, NewConversation, Section};

use super::{
    lock, parse_id, AdapterState, Arc, Author, Duration, Error, Manager, Mutex, PresenceStatus,
    Result, SessionInfo, UiEvent, DEFAULT_COLS, DEFAULT_ROWS,
};

/// Poll period of the transcript watcher.
const WATCH_PERIOD: Duration = Duration::from_secs(1);
/// How long a `claude agents --json` answer is reused.
const LIVE_TTL: Duration = Duration::from_secs(5);
/// An answer older than this no longer proves a session is free.
const LIVE_STALE: Duration = Duration::from_secs(30);
/// Longest name given to a DM created from a discovered session, in characters.
const MAX_NAME: usize = 80;

/// State of the folder-section feature inside the manager.
pub(super) struct FolderState {
    discovery: Discovery,
    /// The History panel's listing of every session (its own light scan cache).
    pub(super) history: patchroom_folders::History,
    live: Mutex<Live>,
    /// Last fingerprint per folder section, for the watcher.
    sigs: Mutex<HashMap<String, u64>>,
    watching: AtomicBool,
    /// Test hook: pretend these session ids run in another terminal.
    pub(super) live_override: Mutex<Option<HashSet<String>>>,
}

#[derive(Default)]
struct Live {
    ids: HashSet<String>,
    at: Option<Instant>,
    refreshing: bool,
}

impl FolderState {
    pub(super) fn new() -> Self {
        Self {
            discovery: Discovery::new(),
            history: patchroom_folders::History::new(),
            live: Mutex::new(Live::default()),
            sigs: Mutex::new(HashMap::new()),
            watching: AtomicBool::new(false),
            live_override: Mutex::new(None),
        }
    }
}

/// The folder of a section, as an absolute path without a trailing slash.
fn clean_folder(path: &str) -> Result<String> {
    let p = path.trim();
    if !p.starts_with('/') {
        return Err(Error::Invalid("the folder must be an absolute path".into()));
    }
    if !Path::new(p).is_dir() {
        return Err(Error::Invalid(format!("not a folder: {p}")));
    }
    Ok(normalize(p))
}

impl Manager {
    // ---- commands ----

    /// `section_create_from_folder {path, name?}`: a section with a home folder, named after
    /// the folder by default.
    ///
    /// # Errors
    /// The path is not an existing absolute folder.
    pub fn section_create_from_folder(
        self: &Arc<Self>,
        path: &str,
        name: Option<&str>,
    ) -> Result<String> {
        let folder = clean_folder(path)?;
        let name = name
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map_or_else(|| super::folder_name(&folder), str::to_owned);
        let s = lock(&self.store).create_folder_section(
            &Author::me(),
            self.workspace,
            &name,
            &folder,
        )?;
        self.start_folder_watch();
        Ok(s.id.to_string())
    }

    /// `section_set_archive_days {id, days}`.
    ///
    /// # Errors
    /// Unknown section or days outside 1 to 3650.
    pub fn section_set_archive_days(&self, id: &str, days: i64) -> Result<()> {
        lock(&self.store).set_section_archive_days(parse_id(id)?, days)?;
        Ok(())
    }

    /// `folder_sessions {sectionId}`: the discovered sessions of a folder section.
    ///
    /// Open DMs that need you come first, then busy ones; the rest follow by last activity,
    /// newest first. Hidden sessions (noise, or hidden by the user) are included with
    /// `hidden: true` and counted in `hiddenCount`.
    ///
    /// # Errors
    /// Unknown section, or a plain (non-folder) section.
    pub fn folder_sessions(self: &Arc<Self>, section_id: &str) -> Result<Listing> {
        let section = self.folder_section(section_id)?;
        let Some(home) = section.folder.clone() else {
            return Err(Error::Invalid("this section has no folder".into()));
        };
        let (hidden, dms) = {
            let store = lock(&self.store);
            let hidden = store.folder_hidden(section.id)?;
            let mut dms: HashMap<String, (String, String)> = HashMap::new();
            for c in store.list_conversations(self.workspace)? {
                if c.kind == ConversationKind::Dm {
                    if let Some(sid) = c.session_id {
                        dms.entry(sid).or_insert((c.id.to_string(), c.name));
                    }
                }
            }
            (hidden, dms)
        };
        let (live, live_checked) = self.live_elsewhere(&dms);
        // The watcher compares against the state the list was built from.
        self.prime_folder_sig(&section);
        let projects = self.projects_dirs();
        let registry = self.registry_path();
        let mut listing = self.folders.discovery.list(&Query {
            home: &home,
            projects_dirs: &projects,
            registry_path: registry.as_deref(),
            dms: &dms,
            hidden: &hidden,
            live: &live,
            live_checked,
        });
        self.rank_open_dms(&mut listing.sessions);
        self.start_folder_watch();
        Ok(listing)
    }

    /// `folder_session_open {sectionId, sessionId}`: the DM of a discovered session, created
    /// on first open and started with `claude --resume <id>` from the session's launch folder.
    /// An already-open DM is returned as it is, and restarted only if it had exited.
    ///
    /// Right before the spawn, `claude agents --json` is read synchronously (bounded at 3 s).
    /// A session that runs in another terminal is not spawned: the DM comes back as a read-only
    /// mirror (`SessionInfo.mirror`).
    ///
    /// # Errors
    /// Unknown section or session, a launch folder that no longer exists, a failed spawn, or a
    /// re-check that did not finish.
    pub fn folder_session_open(
        self: &Arc<Self>,
        section_id: &str,
        session_id: &str,
    ) -> Result<SessionInfo> {
        self.folder_session_open_with(section_id, session_id, false)
    }

    /// [`Manager::folder_session_open`]; `open_anyway` skips the live check (only after the
    /// user confirmed a `check_failed` error).
    ///
    /// # Errors
    /// As [`Manager::folder_session_open`].
    pub fn folder_session_open_with(
        self: &Arc<Self>,
        section_id: &str,
        session_id: &str,
        open_anyway: bool,
    ) -> Result<SessionInfo> {
        let section = self.folder_section(section_id)?;
        if !patchroom_folders::discover::is_session_id(session_id) {
            return Err(Error::Invalid("bad session id".into()));
        }
        let existing = lock(&self.store).conversation_by_session(self.workspace, session_id)?;
        let created = existing.is_none();
        let dm_id = if let Some(c) = existing {
            c.id.to_string()
        } else {
            let found = self
                .folder_sessions(section_id)?
                .sessions
                .into_iter()
                .find(|s| s.session_id == session_id)
                .ok_or_else(|| Error::Invalid(format!("no such session: {session_id}")))?;
            self.create_resume_dm(
                Some(section.id),
                &found.name,
                &found.launch_cwd,
                &found.session_id,
            )?
        };
        self.start_resumable(&dm_id, created, open_anyway)?;
        self.sink.emit(UiEvent::FolderChanged {
            section_id: section_id.to_owned(),
        });
        self.list()?
            .into_iter()
            .find(|s| s.id == dm_id)
            .ok_or(Error::NoSession(dm_id))
    }

    /// Start a discovered session's DM with `claude --resume`, unless it already runs here.
    /// The resume path re-checks `claude agents --json` and mirrors a session that runs in
    /// another process instead of spawning a second copy. A DM made for this open that never
    /// started is deleted again.
    ///
    /// # Errors
    /// A failed spawn or a re-check that did not finish.
    pub(super) fn start_resumable(
        self: &Arc<Self>,
        dm_id: &str,
        created: bool,
        open_anyway: bool,
    ) -> Result<()> {
        let running = lock(&self.live)
            .get(dm_id)
            .is_some_and(|l| l.pty.exit_info().is_none());
        if running {
            return Ok(());
        }
        let go = if open_anyway {
            self.resume_anyway(dm_id, Some(DEFAULT_COLS), Some(DEFAULT_ROWS))
        } else {
            self.resume(dm_id, Some(DEFAULT_COLS), Some(DEFAULT_ROWS))
        };
        if let Err(e) = go {
            if created {
                // A DM that never started should not linger in the sidebar.
                let _ = self.delete(dm_id);
            }
            return Err(e);
        }
        Ok(())
    }

    /// `folder_session_hide {sectionId, sessionId, hidden}`: remove a row from the list only.
    /// The transcript is never touched.
    ///
    /// # Errors
    /// Unknown section.
    pub fn folder_session_hide(
        &self,
        section_id: &str,
        session_id: &str,
        hidden: bool,
    ) -> Result<()> {
        let section = self.folder_section(section_id)?;
        lock(&self.store).set_folder_hidden(&Author::me(), section.id, session_id, hidden)?;
        self.sink.emit(UiEvent::FolderChanged {
            section_id: section_id.to_owned(),
        });
        Ok(())
    }

    // ---- internals ----

    fn folder_section(&self, section_id: &str) -> Result<Section> {
        let section = lock(&self.store).section(parse_id(section_id)?)?;
        if section.folder.is_none() {
            return Err(Error::Invalid("this section has no folder".into()));
        }
        Ok(section)
    }

    /// Create the DM row of a discovered session (not started), in `section` or ungrouped.
    pub(super) fn create_resume_dm(
        &self,
        section: Option<patchroom_store::Id>,
        name: &str,
        launch_cwd: &str,
        session_id: &str,
    ) -> Result<String> {
        if !Path::new(launch_cwd).is_dir() {
            return Err(Error::Invalid(format!(
                "the session's folder no longer exists: {launch_cwd}"
            )));
        }
        let store = lock(&self.store);
        let conv = store.create_conversation(
            &Author::me(),
            &NewConversation {
                workspace_id: self.workspace,
                section_id: section,
                kind: ConversationKind::Dm,
                name: name.chars().take(MAX_NAME).collect(),
                provider: Some("claude".into()),
                cwd: Some(launch_cwd.to_owned()),
                worktree: None,
                session_id: Some(session_id.to_owned()),
                assign_mode: None,
            },
        )?;
        store.set_adapter_state(
            conv.id,
            &serde_json::to_string(&AdapterState::default()).unwrap_or_else(|_| "{}".into()),
        )?;
        Ok(conv.id.to_string())
    }

    /// Transcript roots: the Claude config dir's `projects`, then any extra roots.
    pub(super) fn projects_dirs(&self) -> Vec<PathBuf> {
        self.cfg
            .claude_config_dir
            .iter()
            .map(|d| d.join("projects"))
            .chain(self.cfg.extra_projects_dirs.iter().cloned())
            .collect()
    }

    fn registry_path(&self) -> Option<PathBuf> {
        self.cfg
            .claude_config_dir
            .as_ref()
            .map(|d| d.join(".state").join("session-names.jsonl"))
    }

    /// Open DMs first (needs you, then busy), then the rest in the order given.
    fn rank_open_dms(&self, sessions: &mut [FolderSession]) {
        let needs_you: HashSet<String> = lock(&self.store)
            .list_badges()
            .map(|b| {
                b.into_iter()
                    .filter(|b| b.needs_you)
                    .map(|b| b.conversation_id.to_string())
                    .collect()
            })
            .unwrap_or_default();
        let presence = lock(&self.presence);
        let rank = |s: &FolderSession| -> u8 {
            let Some(dm) = s.dm_id.as_deref() else {
                return 2;
            };
            match presence.get(dm).map(|p| p.status) {
                Some(PresenceStatus::Waiting) => 0,
                _ if needs_you.contains(dm) => 0,
                Some(PresenceStatus::Busy) => 1,
                _ => 2,
            }
        };
        sessions.sort_by_key(rank);
    }

    /// Session ids running in another terminal, from the cached `claude agents --json`, and
    /// whether that cache is fresh enough to call every other session free. A stale cache is
    /// refreshed in the background; until it answers the listing says "checking".
    pub(super) fn live_elsewhere(
        self: &Arc<Self>,
        dms: &HashMap<String, (String, String)>,
    ) -> (HashSet<String>, bool) {
        if let Some(o) = lock(&self.folders.live_override).clone() {
            return (self.minus_own(o, dms), true);
        }
        if self.background_source().is_none() {
            // This manager never runs the CLI (tests): there is nothing to wait for.
            return (HashSet::new(), true);
        }
        self.refresh_live_if_stale();
        let (ids, fresh) = {
            let live = lock(&self.folders.live);
            (
                live.ids.clone(),
                live.at.is_some_and(|t| t.elapsed() <= LIVE_STALE),
            )
        };
        (self.minus_own(ids, dms), fresh)
    }

    /// Start a background refresh when the cache is older than [`LIVE_TTL`] (or empty).
    pub(super) fn refresh_live_if_stale(self: &Arc<Self>) {
        let mut live = lock(&self.folders.live);
        let stale = live.at.is_none_or(|t| t.elapsed() > LIVE_TTL);
        if stale && !live.refreshing {
            live.refreshing = true;
            let me = Arc::clone(self);
            let spawned = std::thread::Builder::new()
                .name("patchroom-folder-live".into())
                .spawn(move || me.refresh_live());
            if spawned.is_err() {
                live.refreshing = false;
            }
        }
    }

    /// Sessions this app runs itself are not "elsewhere". A mirror is elsewhere by definition.
    fn minus_own(
        &self,
        mut ids: HashSet<String>,
        dms: &HashMap<String, (String, String)>,
    ) -> HashSet<String> {
        let presence = lock(&self.presence);
        ids.retain(|sid| {
            !dms.get(sid).is_some_and(|(dm, _)| {
                presence
                    .get(dm)
                    .is_some_and(|p| p.status != PresenceStatus::Exited)
                    && self.mirror_of(dm).is_none()
            })
        });
        ids
    }

    fn refresh_live(self: &Arc<Self>) {
        let answer = self
            .background_source()
            .map(|source| source.list())
            .and_then(|r| r.ok());
        let changed = {
            let mut live = lock(&self.folders.live);
            live.refreshing = false;
            // A failed call keeps the old ids and the old timestamp: the cache goes stale, and
            // a stale cache reports "checking", never "free".
            answer.is_some_and(|entries| {
                let ids: HashSet<String> = entries
                    .into_iter()
                    .filter(|e| e.kind.is_empty() || e.kind == "interactive")
                    .filter_map(|e| e.session_id)
                    .collect();
                let changed = live.at.is_none() || live.ids != ids;
                live.ids = ids;
                live.at = Some(Instant::now());
                changed
            })
        };
        if changed {
            self.emit_folder_changed_all();
        }
    }

    fn emit_folder_changed_all(&self) {
        let sections = lock(&self.store)
            .list_sections(self.workspace)
            .unwrap_or_default();
        for s in sections.into_iter().filter(|s| s.folder.is_some()) {
            self.sink.emit(UiEvent::FolderChanged {
                section_id: s.id.to_string(),
            });
        }
    }

    fn prime_folder_sig(&self, section: &Section) {
        let Some(home) = section.folder.as_deref() else {
            return;
        };
        let sig = signature(&self.projects_dirs(), &self.folders.discovery.roots(home));
        lock(&self.folders.sigs)
            .entry(section.id.to_string())
            .or_insert(sig);
    }

    /// Set the session ids reported as running elsewhere (tests; `None` restores the real
    /// source).
    pub fn set_folder_live_override(&self, ids: Option<HashSet<String>>) {
        *lock(&self.folders.live_override) = ids;
    }

    /// Chip text for a DM whose cwd is outside its folder section, else `None`.
    pub(super) fn folder_chip(folder: Option<&str>, cwd: &str) -> Option<String> {
        let folder = folder?;
        if cwd.is_empty() {
            return None;
        }
        let inside = is_under(folder, cwd)
            || std::fs::canonicalize(folder)
                .ok()
                .and_then(|p| p.to_str().map(str::to_owned))
                .is_some_and(|c| is_under(&c, cwd))
            || std::fs::canonicalize(cwd)
                .ok()
                .and_then(|p| p.to_str().map(str::to_owned))
                .is_some_and(|c| is_under(folder, &c));
        (!inside).then(|| super::folder_name(cwd))
    }

    // ---- watcher ----

    /// Start the poller at launch when folder sections already exist.
    pub(super) fn start_folder_watch_if_any(self: &Arc<Self>) {
        let any = lock(&self.store)
            .list_sections(self.workspace)
            .is_ok_and(|v| v.iter().any(|s| s.folder.is_some()));
        if any {
            self.start_folder_watch();
            // Ask `claude agents` now, so the first listing is not stuck on "checking".
            if self.background_source().is_some() {
                self.refresh_live_if_stale();
            }
        }
    }

    /// Start the transcript poller (once). It stops at shutdown and does nothing while no
    /// folder section exists.
    pub(super) fn start_folder_watch(self: &Arc<Self>) {
        if self.folders.watching.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak: Weak<Manager> = Arc::downgrade(self);
        let spawned = std::thread::Builder::new()
            .name("patchroom-folder-watch".into())
            .spawn(move || loop {
                std::thread::sleep(WATCH_PERIOD);
                let Some(me) = weak.upgrade() else { break };
                if me.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                me.folder_watch_tick();
            });
        if spawned.is_err() {
            self.folders.watching.store(false, Ordering::SeqCst);
        }
    }

    /// One poll: emit `folder:changed` for each folder section whose transcripts changed.
    pub(super) fn folder_watch_tick(&self) {
        let projects = self.projects_dirs();
        if projects.is_empty() {
            return;
        }
        let sections: Vec<Section> = lock(&self.store)
            .list_sections(self.workspace)
            .unwrap_or_default()
            .into_iter()
            .filter(|s| s.folder.is_some())
            .collect();
        let mut seen = HashSet::new();
        for s in sections {
            let Some(home) = s.folder.as_deref() else {
                continue;
            };
            let id = s.id.to_string();
            let sig = signature(&projects, &self.folders.discovery.roots(home));
            seen.insert(id.clone());
            let prev = lock(&self.folders.sigs).insert(id.clone(), sig);
            if prev.is_some_and(|p| p != sig) {
                self.sink.emit(UiEvent::FolderChanged { section_id: id });
            }
        }
        lock(&self.folders.sigs).retain(|k, _| seen.contains(k));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{EventSink, Needs};
    use crate::manager::{ManagerConfig, SessionManager};

    struct NullSink;
    impl EventSink for NullSink {
        fn emit(&self, _event: UiEvent) {}
    }

    fn transcript(config: &Path, cwd: &Path, sid: &str, ts: &str) {
        let enc: String = cwd
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let dir = config.join("projects").join(enc);
        std::fs::create_dir_all(&dir).unwrap();
        let line = serde_json::json!({
            "type": "user", "cwd": cwd, "timestamp": ts, "entrypoint": "cli",
            "message": {"content": format!("prompt of {sid}")}
        });
        std::fs::write(dir.join(format!("{sid}.jsonl")), format!("{line}\n")).unwrap();
    }

    fn manager(root: &Path) -> (SessionManager, PathBuf, PathBuf, tempfile::TempDir) {
        let data = tempfile::Builder::new()
            .prefix("pr")
            .tempdir_in("/tmp")
            .unwrap();
        let stub = root.join("claude-stub");
        std::fs::write(&stub, "#!/bin/sh\nsleep 60\n").unwrap();
        std::fs::set_permissions(&stub, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let hook = root.join("patchroom-hook");
        std::fs::write(&hook, "").unwrap();
        let config = root.join("claude");
        std::fs::create_dir_all(&config).unwrap();
        let home = root.join("proj");
        std::fs::create_dir_all(&home).unwrap();
        let mut cfg = ManagerConfig::new(data.path(), &hook);
        cfg.claude_program = stub.to_string_lossy().into_owned();
        cfg.shell = Some("/bin/sh".into());
        cfg.claude_config_dir = Some(config.clone());
        let m = Manager::new(cfg, Arc::new(NullSink)).unwrap();
        (m, config, std::fs::canonicalize(home).unwrap(), data)
    }

    #[test]
    fn open_dms_that_need_you_come_first_then_busy_then_by_activity() {
        let root = tempfile::tempdir().unwrap();
        let (m, config, home, _data) = manager(root.path());
        let sids = ["s-new", "s-mid", "s-old", "s-older"];
        for (i, sid) in sids.iter().enumerate() {
            let ts = format!("2026-03-0{}T10:00:00Z", 4 - i);
            transcript(&config, &home, sid, &ts);
        }
        let sec = m
            .section_create_from_folder(home.to_str().unwrap(), None)
            .unwrap();
        let order = |m: &SessionManager| -> Vec<String> {
            m.folder_sessions(&sec)
                .unwrap()
                .sessions
                .into_iter()
                .map(|s| s.session_id)
                .collect()
        };
        assert_eq!(order(&m), sids, "no DMs open: newest activity first");
        let busy = m.folder_session_open(&sec, "s-old").unwrap();
        let waiting = m.folder_session_open(&sec, "s-older").unwrap();
        m.set_status(&busy.id, PresenceStatus::Busy, None);
        m.set_status(
            &waiting.id,
            PresenceStatus::Waiting,
            Some(Needs::Permission),
        );
        assert_eq!(order(&m), ["s-older", "s-old", "s-new", "s-mid"]);
        m.shutdown();
    }
}
