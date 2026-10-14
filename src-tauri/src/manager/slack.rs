//! The P3 Slack layer of the session manager: sections, flags, drafts, item marks, search,
//! the Activity list, prefs and the notification decision. It is a child module of
//! [`super::Manager`], so it reaches the manager's private state.
//!
//! # Notifications
//! Every event funnels through [`Manager::notify_event`]: one decision (see
//! `patchroom_prefs::decide`), one line in `<data dir>/notify-decisions.log`, and, when the
//! decision is to fire, one native notification plus one `notify:fire` event. Terminal
//! attention (BEL, OSC 9, OSC 777) is held for [`ManagerConfig::terminal_hold`] first, so the
//! hook-driven event for the same moment wins and the user hears about it once.
//!
//! # Locks
//! `slack.prefs`, `slack.search` and the other `slack.*` mutexes are leaves: take them last
//! and never call out (store, presence, sink) while holding one, except the search index,
//! which is only held for its own queries.

use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use chrono::{Local, NaiveDateTime};
use patchroom_claude::{ChatItem, ItemBody, Locator};
use patchroom_prefs::{
    decide, detect_sound_hooks, log_line, Decision, DetectedHook, Event, Facts, Prefs, Reason,
};
use patchroom_search::{
    file_stamp, needs_reindex, read_transcript, Scope, SearchIndex, SearchResult, EXTERNAL_PREFIX,
};
use patchroom_store::{Id, ItemMark, MarkKind, SNAPSHOT_CHARS};
use serde::Serialize;
use serde_json::Value;

use super::{
    lock, parse_id, Arc, Author, Duration, Error, Manager, Mutex, Result, UiEvent, DEFAULT_LIMIT,
};
use crate::notifier::{FocusProbe, Notifier};

/// File in the data dir that records every notification decision.
pub const DECISION_LOG: &str = "notify-decisions.log";
/// The decision log is rotated to `.1` past this size.
const LOG_MAX_BYTES: u64 = 1024 * 1024;
/// Setting key that holds the prefs JSON.
const PREFS_KEY: &str = "prefs";
/// How long the detected sound hooks are cached for decisions.
const HOOK_CACHE: Duration = Duration::from_secs(5);
/// A terminal bell or OSC message within this window of the previous one is dropped.
const TERMINAL_MIN_GAP: Duration = Duration::from_secs(2);
/// Structured events and terminal attention within this window count as the same moment.
const SAME_MOMENT: Duration = Duration::from_secs(3);
/// A focus hint from `session_view` or `session_mark_read` is believed this long.
const HINT_TTL: Duration = Duration::from_secs(8);
/// Longest draft the store accepts, in bytes.
const MAX_DRAFT: usize = 1024 * 1024;
/// Items after the located one that its `chat_locate` page reaches.
const LOCATE_AFTER: usize = 25;
/// Other Claude sessions indexed when `searchAllSessions` is on (newest first).
const MAX_EXTERNAL_SESSIONS: usize = 300;
/// Transcripts larger than this are not indexed as other sessions.
const MAX_EXTERNAL_BYTES: u64 = 100 * 1024 * 1024;
/// A forced reindex waits at most this long for a running sync to finish.
const SYNC_WAIT: Duration = Duration::from_secs(120);
/// Longest terminal message shown in a notification, in characters.
const MAX_BODY_CHARS: usize = 200;

type LocalClock = Arc<dyn Fn() -> NaiveDateTime + Send + Sync>;

/// Which DM the user is looking at, as far as the backend can tell.
struct FocusHint {
    id: String,
    /// `None`: told explicitly by `session_focus`, believed until changed.
    /// `Some`: inferred from another call, believed for [`HINT_TTL`].
    inferred_at: Option<Instant>,
}

/// State of the Slack layer inside the manager.
pub(super) struct SlackState {
    prefs: Mutex<Prefs>,
    search: Mutex<SearchIndex>,
    /// Deleted DMs. Checked under the `search` lock, so an index pass still in flight
    /// cannot re-insert a DM after `search_forget`.
    forgotten: Mutex<HashSet<String>>,
    focus: Mutex<Option<FocusHint>>,
    notifier: Mutex<Option<Arc<dyn Notifier>>>,
    probe: Mutex<Option<Arc<dyn FocusProbe>>>,
    hooks: Mutex<Option<(Instant, Vec<DetectedHook>)>>,
    last_structured: Mutex<HashMap<String, Instant>>,
    last_terminal: Mutex<HashMap<String, Instant>>,
    seen_errors: Mutex<HashSet<String>>,
    log: Mutex<Option<std::fs::File>>,
    clock: Mutex<Option<LocalClock>>,
    syncing: AtomicBool,
}

impl SlackState {
    pub(super) fn open(data_dir: &Path, stored_prefs: Option<&str>) -> Self {
        let search = open_index(data_dir);
        Self {
            prefs: Mutex::new(stored_prefs.map(Prefs::from_stored).unwrap_or_default()),
            search: Mutex::new(search),
            forgotten: Mutex::new(HashSet::new()),
            focus: Mutex::new(None),
            notifier: Mutex::new(None),
            probe: Mutex::new(None),
            hooks: Mutex::new(None),
            last_structured: Mutex::new(HashMap::new()),
            last_terminal: Mutex::new(HashMap::new()),
            seen_errors: Mutex::new(HashSet::new()),
            log: Mutex::new(open_log(data_dir)),
            clock: Mutex::new(None),
            syncing: AtomicBool::new(false),
        }
    }
}

/// Open the search index; a damaged file is deleted and rebuilt, and an index that cannot
/// be opened at all falls back to memory (search then only knows this run).
fn open_index(data_dir: &Path) -> SearchIndex {
    if let Ok(ix) = SearchIndex::open(data_dir) {
        return ix;
    }
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(
            data_dir.join(format!("{}{suffix}", patchroom_search::INDEX_FILE)),
        );
    }
    SearchIndex::open(data_dir)
        .or_else(|_| SearchIndex::open_in_memory())
        .expect("an in-memory search index always opens")
}

fn open_log(data_dir: &Path) -> Option<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt as _;
    let path = data_dir.join(DECISION_LOG);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_MAX_BYTES) {
        let _ = std::fs::rename(&path, data_dir.join(format!("{DECISION_LOG}.1")));
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
        .ok()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A pin, saved item or reaction as the UI receives it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MarkInfo {
    /// Row id of the mark.
    pub id: String,
    /// The DM the item belongs to.
    pub conversation_id: String,
    /// Key of the chat item.
    pub item_key: String,
    /// `pin`, `saved` or `reaction`.
    pub kind: &'static str,
    /// The emoji of a reaction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    /// Up to 280 characters of the item's text.
    pub snapshot: String,
    /// Creation time, epoch milliseconds.
    pub created_at: i64,
}

impl From<ItemMark> for MarkInfo {
    fn from(m: ItemMark) -> Self {
        Self {
            id: m.id.to_string(),
            conversation_id: m.conversation_id.to_string(),
            item_key: m.item_key,
            kind: m.kind.as_str(),
            emoji: (!m.emoji.is_empty()).then_some(m.emoji),
            snapshot: m.snapshot,
            created_at: m.created_at,
        }
    }
}

/// One row of `activity_list`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    /// The DM.
    pub id: String,
    /// `prompt` (needs you) or `unread` (a finished turn).
    pub kind: &'static str,
    /// When it began, epoch milliseconds.
    pub ts: i64,
    /// The prompt to answer, for a prompt row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    /// Chat item to scroll to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_key: Option<String>,
    /// One line of context.
    pub summary: String,
}

/// Result of `chat_locate`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Located {
    /// A `chat_history` cursor whose page holds the item; `None` means the newest page does.
    pub before: Option<String>,
}

/// Result of `search_reindex`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reindexed {
    /// Documents in the index afterwards.
    pub docs: u64,
    /// Time taken, milliseconds.
    pub took_ms: f64,
}

/// A saved snapshot text for a chat item.
fn snapshot_of(item: &ChatItem) -> String {
    let text = match item.body {
        ItemBody::Tool { .. } => item.summary(SNAPSHOT_CHARS),
        _ => item
            .search_text()
            .unwrap_or_else(|| item.summary(SNAPSHOT_CHARS)),
    };
    clip(&text, SNAPSHOT_CHARS)
}

fn parse_ids(ids: &[String]) -> Result<Vec<Id>> {
    ids.iter().map(|s| parse_id(s)).collect()
}

impl Manager {
    // ---- wiring (tests and the app shell) ----

    /// Install the native notification poster.
    pub fn set_notifier(&self, n: Arc<dyn Notifier>) {
        *lock(&self.slack.notifier) = Some(n);
    }

    /// Install the window focus probe. Without one, the app counts as not focused.
    pub fn set_focus_probe(&self, p: Arc<dyn FocusProbe>) {
        *lock(&self.slack.probe) = Some(p);
    }

    /// Replace the local wall clock (tests). `None` restores the system clock.
    pub fn set_local_clock(&self, c: Option<Arc<dyn Fn() -> NaiveDateTime + Send + Sync>>) {
        *lock(&self.slack.clock) = c;
    }

    /// Path of the notification decision log.
    #[must_use]
    pub fn decision_log_path(&self) -> PathBuf {
        self.cfg.data_dir.join(DECISION_LOG)
    }

    fn local_now(&self) -> NaiveDateTime {
        match lock(&self.slack.clock).as_ref() {
            Some(c) => c(),
            None => Local::now().naive_local(),
        }
    }

    // ---- sections, placement, flags ----

    /// `section_rename`.
    ///
    /// # Errors
    /// Unknown section or empty name.
    pub fn section_rename(&self, id: &str, name: &str) -> Result<()> {
        lock(&self.store).rename_section(parse_id(id)?, name.trim())?;
        Ok(())
    }

    /// `section_delete`: its DMs fall back to "Direct messages". That section itself stays.
    ///
    /// # Errors
    /// Unknown section, or the Direct messages section.
    pub fn section_delete(&self, id: &str) -> Result<()> {
        let sid = parse_id(id)?;
        if sid == self.defaults.dm {
            return Err(Error::Invalid(
                "the Direct messages section cannot be deleted".into(),
            ));
        }
        lock(&self.store).delete_section_into(sid, self.defaults.dm)?;
        Ok(())
    }

    /// `section_reorder`: listed sections first in that order, the rest after them in their
    /// current order.
    ///
    /// # Errors
    /// Unknown or repeated section ids.
    pub fn section_reorder(&self, ids: &[String]) -> Result<()> {
        let wanted = parse_ids(ids)?;
        let store = lock(&self.store);
        let current: Vec<Id> = store
            .list_sections(self.workspace)?
            .into_iter()
            .map(|s| s.id)
            .collect();
        if let Some(bad) = wanted.iter().find(|w| !current.contains(w)) {
            return Err(Error::Invalid(format!("no such section: {bad}")));
        }
        let mut order = wanted.clone();
        order.extend(current.iter().filter(|c| !wanted.contains(c)));
        let mut seen = HashSet::new();
        if !order.iter().all(|i| seen.insert(*i)) {
            return Err(Error::Invalid("a section is listed twice".into()));
        }
        store.reorder_sections(self.workspace, &order)?;
        Ok(())
    }

    /// `session_reorder`: put the DMs into `section_id` (or unplace them) in this order.
    ///
    /// # Errors
    /// Unknown ids or a repeated DM.
    pub fn session_reorder(&self, section_id: Option<&str>, ids: &[String]) -> Result<()> {
        let section = section_id.map(parse_id).transpose()?;
        let ids = parse_ids(ids)?;
        lock(&self.store).place_conversations(section, &ids)?;
        Ok(())
    }

    /// `session_set_flags`: star or archive a DM. Archiving hides it from badges and
    /// notifications (needs-you still gets through); un-archiving brings the badge back.
    ///
    /// # Errors
    /// Unknown DM.
    pub fn set_flags(&self, id: &str, starred: Option<bool>, archived: Option<bool>) -> Result<()> {
        let conv = parse_id(id)?;
        let b = {
            let store = lock(&self.store);
            store.set_conversation_flags(conv, starred, archived)?;
            store.badges(conv)?
        };
        self.emit_badges(id, b.unread, b.needs_you);
        self.sink.emit(UiEvent::ActivityChanged);
        Ok(())
    }

    // ---- drafts ----

    /// `draft_get`.
    ///
    /// # Errors
    /// Unknown DM.
    pub fn draft_get(&self, id: &str) -> Result<String> {
        let conv = parse_id(id)?;
        let store = lock(&self.store);
        store.conversation(conv)?;
        Ok(store.draft(conv)?.map(|d| d.body).unwrap_or_default())
    }

    /// `draft_set`: an empty body deletes the draft.
    ///
    /// # Errors
    /// Unknown DM or a draft over 1 MB.
    pub fn draft_set(&self, id: &str, body: &str) -> Result<()> {
        if body.len() > MAX_DRAFT {
            return Err(Error::Invalid("the draft is too large".into()));
        }
        let conv = parse_id(id)?;
        let store = lock(&self.store);
        store.conversation(conv)?;
        store.set_draft(&Author::me(), conv, body)?;
        Ok(())
    }

    // ---- marks: pins, saved items, reactions ----

    fn item_snapshot(self: &Arc<Self>, id: &str, item_key: &str) -> Result<String> {
        let chat = self.chat_for_read(id)?;
        chat.watcher.sync();
        chat.watcher
            .with(|a| a.mapper().item(item_key).map(snapshot_of))
            .ok_or_else(|| Error::Invalid(format!("no chat item {item_key:?} in this DM")))
    }

    /// `mark_add`: pin, save or react to a chat item. Adding the same mark again is a no-op
    /// that returns the existing one. Nothing is written to the PTY.
    ///
    /// # Errors
    /// Unknown DM or item, an unknown kind, or a reaction without an emoji.
    pub fn mark_add(
        self: &Arc<Self>,
        id: &str,
        item_key: &str,
        kind: &str,
        emoji: Option<&str>,
    ) -> Result<MarkInfo> {
        let kind: MarkKind = kind.parse()?;
        let conv = parse_id(id)?;
        let snapshot = self.item_snapshot(id, item_key)?;
        let mark =
            lock(&self.store).add_mark(&Author::me(), conv, item_key, kind, emoji, &snapshot)?;
        Ok(mark.into())
    }

    /// `mark_remove`.
    ///
    /// # Errors
    /// Unknown kind, or a reaction without an emoji.
    pub fn mark_remove(
        &self,
        id: &str,
        item_key: &str,
        kind: &str,
        emoji: Option<&str>,
    ) -> Result<()> {
        let kind: MarkKind = kind.parse()?;
        lock(&self.store).remove_mark(parse_id(id)?, item_key, kind, emoji)?;
        Ok(())
    }

    /// `mark_list`: one DM's marks, or every DM's; newest first.
    ///
    /// # Errors
    /// Malformed id or unknown kind.
    pub fn mark_list(&self, id: Option<&str>, kind: Option<&str>) -> Result<Vec<MarkInfo>> {
        let conv = id.map(parse_id).transpose()?;
        let kind = kind.map(str::parse::<MarkKind>).transpose()?;
        Ok(lock(&self.store)
            .list_marks(conv, kind)?
            .into_iter()
            .map(MarkInfo::from)
            .collect())
    }

    // ---- chat_locate ----

    /// `chat_locate {id, itemKey}`: a `chat_history` cursor whose page contains the item.
    ///
    /// # Errors
    /// Unknown DM, or no such item.
    pub fn chat_locate(self: &Arc<Self>, id: &str, item_key: &str) -> Result<Located> {
        let chat = self.chat_for_read(id)?;
        chat.watcher.sync();
        chat.watcher.with(|a| {
            let m = a.mapper();
            let pos = m
                .position(item_key)
                .ok_or_else(|| Error::Invalid(format!("no chat item {item_key:?} in this DM")))?;
            let end = pos + LOCATE_AFTER;
            // The page ends just before the item at `end`; none past the newest end means
            // the newest page already has it.
            Ok(Located {
                before: m.items().get(end).map(|i| i.key.clone()),
            })
        })
    }

    // ---- search ----

    /// Feed live transcript items to the index. Subagent thread items are not searched.
    pub(super) fn index_items(&self, id: &str, items: &[ChatItem], replace_all: bool) {
        let own: Vec<ChatItem> = items
            .iter()
            .filter(|i| i.parent_tool_use_id.is_none())
            .cloned()
            .collect();
        let mut ix = lock(&self.slack.search);
        if lock(&self.slack.forgotten).contains(id) {
            return;
        }
        let r = if replace_all {
            ix.replace_conversation(id, &own)
        } else {
            ix.upsert_items(id, &own)
        };
        if let Err(e) = r {
            eprintln!("patchroom: search index update failed: {e}");
        }
    }

    /// `search {query, scope?, limit?}`.
    ///
    /// # Errors
    /// Index failures.
    pub fn search(
        &self,
        query: &str,
        scope_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<SearchResult> {
        let all_sessions = lock(&self.slack.prefs).search_all_sessions;
        if scope_id.is_some_and(|s| s.starts_with(EXTERNAL_PREFIX)) && !all_sessions {
            return Ok(SearchResult {
                hits: Vec::new(),
                took_ms: 0.0,
            });
        }
        let scope = Scope {
            conv: scope_id,
            include_external: all_sessions,
        };
        lock(&self.slack.search)
            .search(query, &scope, limit.unwrap_or(DEFAULT_LIMIT))
            .map_err(|e| Error::Invalid(e.to_string()))
    }

    /// `search_reindex`: rebuild the index from the transcripts now.
    ///
    /// # Errors
    /// Index failures.
    pub fn search_reindex(&self) -> Result<Reindexed> {
        let started = Instant::now();
        self.sync_search(true);
        let docs = lock(&self.slack.search)
            .doc_count(None)
            .map_err(|e| Error::Invalid(e.to_string()))?;
        Ok(Reindexed {
            docs,
            took_ms: (started.elapsed().as_secs_f64() * 1000.0).round(),
        })
    }

    /// The transcript file of a claude DM, if it exists.
    fn transcript_path(&self, id: &str, conv: &patchroom_store::Conversation) -> Option<PathBuf> {
        if let Some(p) = self
            .chat_of(id)
            .and_then(|c| c.watcher.with(|a| a.path().map(Path::to_path_buf)))
        {
            return Some(p);
        }
        Locator {
            config_dir: self.cfg.claude_config_dir.clone()?,
            cwd: PathBuf::from(conv.cwd.clone().unwrap_or_default()),
            session_id: conv.session_id.clone()?,
            explicit: None,
        }
        .find()
    }

    /// Bring the index up to date with the transcripts. `force` re-reads every file; without
    /// it only files whose size or mtime changed since they were indexed are read. Other
    /// Claude sessions are included only while `searchAllSessions` is on, and removed when
    /// it is off. Parsing happens outside the index lock.
    pub(super) fn sync_search(&self, force: bool) {
        // One sync at a time. A background sync that finds another running just ends; a forced
        // one (the reindex command) waits its turn, so it always does a full pass.
        let end = Instant::now() + SYNC_WAIT;
        while self.slack.syncing.swap(true, Ordering::SeqCst) {
            if !force || Instant::now() >= end || self.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.sync_search_inner(force);
        self.slack.syncing.store(false, Ordering::SeqCst);
    }

    fn sync_search_inner(&self, force: bool) {
        let convs = lock(&self.store)
            .list_conversations(self.workspace)
            .unwrap_or_default();
        let mut own_sessions: HashSet<String> = HashSet::new();
        let mut live_ids: HashSet<String> = HashSet::new();
        for c in &convs {
            live_ids.insert(c.id.to_string());
            own_sessions.extend(c.session_id.clone());
        }
        for c in &convs {
            if self.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            let id = c.id.to_string();
            let is_claude = super::AdapterState::parse(&c.adapter_state).is_claude();
            let Some(path) = is_claude.then(|| self.transcript_path(&id, c)).flatten() else {
                continue;
            };
            self.index_path(&id, &path, force);
        }
        // Documents of DMs that no longer exist.
        let stale: Vec<String> = lock(&self.slack.search)
            .conversations()
            .unwrap_or_default()
            .into_iter()
            .filter(|k| !k.starts_with(EXTERNAL_PREFIX) && !live_ids.contains(k))
            .collect();
        for k in stale {
            let _ = lock(&self.slack.search).delete_conversation(&k);
        }
        if lock(&self.slack.prefs).search_all_sessions {
            self.sync_external(force, &own_sessions);
        } else {
            let _ = lock(&self.slack.search).delete_external();
        }
    }

    fn index_path(&self, conv: &str, path: &Path, force: bool) {
        if !force && !needs_reindex(&lock(&self.slack.search), conv, path).unwrap_or(true) {
            return;
        }
        let stamp = file_stamp(path);
        let items = read_transcript(path);
        let mut ix = lock(&self.slack.search);
        if lock(&self.slack.forgotten).contains(conv) {
            return;
        }
        if ix.replace_conversation(conv, &items).is_ok() {
            if let Some((size, mtime)) = stamp {
                let _ = ix.set_source_state(conv, &path.to_string_lossy(), size, mtime);
            }
        }
    }

    /// Index other Claude Code sessions' transcripts (read only), newest first.
    fn sync_external(&self, force: bool, own_sessions: &HashSet<String>) {
        let Some(root) = self
            .cfg
            .claude_config_dir
            .as_ref()
            .map(|c| c.join("projects"))
        else {
            return;
        };
        let mut files: Vec<(std::time::SystemTime, PathBuf, String)> = Vec::new();
        for dir in std::fs::read_dir(root).into_iter().flatten().flatten() {
            for f in std::fs::read_dir(dir.path())
                .into_iter()
                .flatten()
                .flatten()
            {
                let p = f.path();
                if p.extension().is_none_or(|e| e != "jsonl") {
                    continue;
                }
                let Some(stem) = p.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
                    continue;
                };
                let Ok(meta) = f.metadata() else { continue };
                if own_sessions.contains(&stem) || meta.len() > MAX_EXTERNAL_BYTES {
                    continue;
                }
                files.push((meta.modified().unwrap_or(std::time::UNIX_EPOCH), p, stem));
            }
        }
        files.sort_by_key(|f| std::cmp::Reverse(f.0));
        for (_, path, stem) in files.into_iter().take(MAX_EXTERNAL_SESSIONS) {
            if self.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            self.index_path(&format!("{EXTERNAL_PREFIX}{stem}"), &path, force);
        }
    }

    /// Start a background index sync (startup, and when `searchAllSessions` turns on).
    pub(super) fn spawn_search_sync(self: &Arc<Self>, force: bool) {
        let me = Arc::clone(self);
        let r = std::thread::Builder::new()
            .name("patchroom-search-sync".into())
            .spawn(move || me.sync_search(force));
        if let Err(e) = r {
            eprintln!("patchroom: cannot start the search sync: {e}");
        }
    }

    /// Drop a deleted DM's documents.
    pub(super) fn search_forget(&self, id: &str) {
        let mut ix = lock(&self.slack.search);
        lock(&self.slack.forgotten).insert(id.to_owned());
        let _ = ix.delete_conversation(id);
    }

    // ---- activity ----

    /// `activity_list`: every prompt waiting on the user and every unread finished turn,
    /// oldest first.
    ///
    /// # Errors
    /// Store failures.
    pub fn activity_list(&self) -> Result<Vec<ActivityRow>> {
        let (marks, convs) = {
            let store = lock(&self.store);
            (
                store.activity_marks()?,
                store.list_conversations(self.workspace)?,
            )
        };
        let archived: HashSet<String> = convs
            .iter()
            .filter(|c| c.archived)
            .map(|c| c.id.to_string())
            .collect();
        let mut rows: Vec<ActivityRow> = Vec::new();
        let mut has_prompt: HashSet<String> = HashSet::new();
        let chats: Vec<(String, Arc<super::chat::Chat>)> = lock(&self.chats)
            .iter()
            .map(|(k, v)| (k.clone(), Arc::clone(v)))
            .collect();
        for (id, chat) in chats {
            for row in chat.open_prompt_rows(&id) {
                has_prompt.insert(id.clone());
                rows.push(row);
            }
        }
        for m in marks {
            let id = m.conversation_id.to_string();
            // Waiting with no chat prompt (a dialog only the terminal can answer). Not when a
            // prompt was just answered here and the tool is still running.
            let answered_here = m.needs_since.is_some_and(|since| {
                self.chat_of(&id)
                    .is_some_and(|c| c.last_resolved_ms() >= since)
            });
            if m.needs_you && !has_prompt.contains(&id) && !answered_here {
                rows.push(ActivityRow {
                    id: id.clone(),
                    kind: "prompt",
                    ts: m.needs_since.unwrap_or_else(now_ms),
                    prompt_id: None,
                    item_key: None,
                    summary: "Waiting for you".into(),
                });
            }
            if m.unread > 0 && !archived.contains(&id) {
                let what = m.unread_summary.clone().unwrap_or_default();
                rows.push(ActivityRow {
                    id,
                    kind: "unread",
                    ts: m.unread_since.unwrap_or(0),
                    prompt_id: None,
                    item_key: m.unread_key.clone(),
                    summary: if m.unread > 1 {
                        format!("{} new: {what}", m.unread)
                    } else {
                        what
                    },
                });
            }
        }
        rows.sort_by(|a, b| a.ts.cmp(&b.ts).then_with(|| a.id.cmp(&b.id)));
        Ok(rows)
    }

    // ---- prefs ----

    /// `prefs_get`.
    #[must_use]
    pub fn prefs_get(&self) -> Prefs {
        lock(&self.slack.prefs).clone()
    }

    /// `prefs_set {patch}`: replace the given top-level keys, persist, emit `prefs:changed`.
    ///
    /// # Errors
    /// A patch with the wrong shape, or a store failure.
    pub fn prefs_set(self: &Arc<Self>, patch: &Value) -> Result<Prefs> {
        let (next, search_changed) = {
            let mut cur = lock(&self.slack.prefs);
            let next = cur
                .patched(patch)
                .map_err(|e| Error::Invalid(e.to_string()))?;
            let json = serde_json::to_string(&next).map_err(|e| Error::Invalid(e.to_string()))?;
            lock(&self.store).set_setting(&Author::me(), PREFS_KEY, &json)?;
            let changed = cur.search_all_sessions != next.search_all_sessions;
            *cur = next.clone();
            (next, changed)
        };
        if search_changed {
            if next.search_all_sessions {
                self.spawn_search_sync(false);
            } else {
                let _ = lock(&self.slack.search).delete_external();
            }
        }
        self.sink.emit(UiEvent::PrefsChanged {
            prefs: serde_json::to_value(&next).unwrap_or(Value::Null),
        });
        Ok(next)
    }

    // ---- sound hooks ----

    fn project_dirs(&self) -> Vec<PathBuf> {
        let convs = lock(&self.store)
            .list_conversations(self.workspace)
            .unwrap_or_default();
        let mut dirs: Vec<PathBuf> = convs
            .into_iter()
            .filter_map(|c| c.cwd.map(PathBuf::from))
            .collect();
        dirs.sort();
        dirs.dedup();
        dirs
    }

    /// `sound_hooks_detect`: the user's audio command hooks (user, project and local Claude
    /// settings). Read only.
    #[must_use]
    pub fn sound_hooks_detect(&self) -> Vec<DetectedHook> {
        let found = detect_sound_hooks(self.cfg.claude_config_dir.as_deref(), &self.project_dirs());
        *lock(&self.slack.hooks) = Some((Instant::now(), found.clone()));
        found
    }

    fn cached_hooks(&self) -> Vec<DetectedHook> {
        if let Some((at, h)) = lock(&self.slack.hooks).as_ref() {
            if at.elapsed() < HOOK_CACHE {
                return h.clone();
            }
        }
        self.sound_hooks_detect()
    }

    // ---- focus ----

    /// `session_focus {id?}`: the DM the user is looking at (null: none). The UI calls it
    /// when the shown DM changes.
    pub fn session_focus(&self, id: Option<&str>) {
        *lock(&self.slack.focus) = id.map(|id| FocusHint {
            id: id.to_owned(),
            inferred_at: None,
        });
    }

    /// Remember that the user just touched `id` (another call implies they are looking at it).
    pub(super) fn hint_focus(&self, id: &str) {
        let mut f = lock(&self.slack.focus);
        // An explicit focus is only replaced by an explicit one.
        if f.as_ref().is_some_and(|h| h.inferred_at.is_none()) {
            return;
        }
        *f = Some(FocusHint {
            id: id.to_owned(),
            inferred_at: Some(Instant::now()),
        });
    }

    fn is_focused_dm(&self, id: &str) -> bool {
        let looking = lock(&self.slack.focus)
            .as_ref()
            .is_some_and(|h| h.id == id && h.inferred_at.is_none_or(|t| t.elapsed() < HINT_TTL));
        looking
            && lock(&self.slack.probe)
                .as_ref()
                .is_some_and(|p| p.window_active())
    }

    // ---- notifications ----

    fn write_log(&self, line: &str) {
        if let Some(f) = lock(&self.slack.log).as_mut() {
            let _ = writeln!(f, "{line}");
        }
    }

    fn timestamp() -> String {
        Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string()
    }

    /// Decide, log and, when the decision is to fire, notify. `body` is the native
    /// notification text; it is never logged.
    pub(super) fn notify_event(&self, id: &str, event: Event, body: &str) {
        if self.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let Ok(conv_id) = parse_id(id) else { return };
        let Ok(conv) = lock(&self.store).conversation(conv_id) else {
            return;
        };
        if matches!(event, Event::Needs | Event::Done | Event::Error) {
            lock(&self.slack.last_structured).insert(id.to_owned(), Instant::now());
        }
        let prefs = self.prefs_get();
        let detected = self.cached_hooks();
        let decision = decide(
            &prefs,
            &Facts {
                dm: id,
                event,
                focused: self.is_focused_dm(id),
                archived: conv.archived,
                local_now: self.local_now(),
                detected: &detected,
            },
        );
        self.write_log(&log_line(&Self::timestamp(), event, id, decision));
        if decision.fire {
            self.fire(id, event, &conv.name, body);
        }
    }

    fn fire(&self, id: &str, event: Event, title: &str, body: &str) {
        if let Some(n) = lock(&self.slack.notifier).clone() {
            n.post(id, title, body);
        }
        self.sink.emit(UiEvent::NotifyFire {
            id: id.to_owned(),
            event: event.as_str(),
            title: title.to_owned(),
            body: body.to_owned(),
        });
    }

    /// `notify_test`: post a test notification now, whatever the levels, focus or DND say.
    pub fn notify_test(&self) {
        self.write_log(&log_line(
            &Self::timestamp(),
            Event::Message,
            "test",
            Decision {
                fire: true,
                reason: Reason::Test,
            },
        ));
        self.fire(
            "",
            Event::Message,
            "Patchroom",
            "This is a test notification.",
        );
    }

    /// BEL, OSC 9 or OSC 777 from the terminal of `id`. Held briefly so that a hook-driven
    /// notification for the same moment (Claude emits both for a permission prompt) wins and
    /// the user is told once.
    pub(super) fn on_terminal_attention(self: &Arc<Self>, id: &str, event: Event, body: String) {
        let arrived = Instant::now();
        {
            let mut last = lock(&self.slack.last_terminal);
            if last
                .get(id)
                .is_some_and(|t| arrived.duration_since(*t) < TERMINAL_MIN_GAP)
            {
                return;
            }
            last.insert(id.to_owned(), arrived);
        }
        let me = Arc::clone(self);
        let id = id.to_owned();
        let hold = self.cfg.terminal_hold;
        let r = std::thread::Builder::new()
            .name("patchroom-terminal-attention".into())
            .spawn(move || {
                std::thread::sleep(hold);
                me.finish_terminal_attention(&id, event, &body, arrived);
            });
        if let Err(e) = r {
            eprintln!("patchroom: cannot hold terminal attention: {e}");
        }
    }

    fn finish_terminal_attention(&self, id: &str, event: Event, body: &str, arrived: Instant) {
        let near = lock(&self.slack.last_structured).get(id).is_some_and(|t| {
            if *t >= arrived {
                true
            } else {
                arrived.duration_since(*t) < SAME_MOMENT
            }
        });
        if near {
            self.write_log(&log_line(
                &Self::timestamp(),
                event,
                id,
                Decision {
                    fire: false,
                    reason: Reason::Duplicate,
                },
            ));
            return;
        }
        let text = if body.trim().is_empty() {
            match event {
                Event::Bell => "Terminal bell".to_owned(),
                _ => "Needs your attention".to_owned(),
            }
        } else {
            clip(&one_line(body), MAX_BODY_CHARS)
        };
        self.notify_event(id, event, &text);
    }

    /// New live `api_error` system items notify once each.
    pub(super) fn notify_api_errors(&self, id: &str, items: &[ChatItem]) {
        for item in items {
            let ItemBody::System { subtype, .. } = &item.body else {
                continue;
            };
            if subtype != "api_error" {
                continue;
            }
            let first = {
                let mut seen = lock(&self.slack.seen_errors);
                if seen.len() > 1000 {
                    seen.clear();
                }
                seen.insert(format!("{id}:{}", item.key))
            };
            if first {
                self.notify_event(id, Event::Error, "The API returned an error");
            }
        }
    }

    /// Body text for a needs-you notification.
    pub(super) fn needs_body(&self, id: &str) -> &'static str {
        match lock(&self.presence).get(id).and_then(|p| p.needs) {
            Some(crate::events::Needs::Permission) => "Waiting for your permission",
            Some(crate::events::Needs::Question) => "Has a question for you",
            _ => "Waiting for you",
        }
    }

    /// An unexpected process exit notifies as an error. A kill, delete or quit does not.
    pub(super) fn notify_exit(&self, id: &str, code: i64) {
        if code == 0 || lock(&self.killed).contains(id) {
            return;
        }
        self.notify_event(
            id,
            Event::Error,
            &format!("The session exited with code {code}"),
        );
    }
}

/// A one-line description of a prompt for the Activity list.
pub(super) fn prompt_summary(
    kind: &str,
    tool_name: &str,
    input: &Value,
    questions: &Option<Value>,
) -> String {
    match kind {
        "question" => {
            let q = questions
                .as_ref()
                .and_then(|q| q.get(0))
                .and_then(|q| q.get("question"))
                .and_then(Value::as_str)
                .unwrap_or("A question");
            clip(&one_line(q), SNAPSHOT_CHARS)
        }
        "plan" => "Plan waiting for approval".to_owned(),
        _ => {
            let detail = [
                "command",
                "file_path",
                "path",
                "pattern",
                "url",
                "description",
            ]
            .iter()
            .find_map(|k| input.get(*k).and_then(Value::as_str))
            .unwrap_or("");
            clip(&one_line(&format!("{tool_name} {detail}")), SNAPSHOT_CHARS)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mark_info_json_shape() {
        let m = MarkInfo {
            id: "m1".into(),
            conversation_id: "c1".into(),
            item_key: "k".into(),
            kind: "pin",
            emoji: None,
            snapshot: "s".into(),
            created_at: 5,
        };
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            json!({"id":"m1","conversationId":"c1","itemKey":"k","kind":"pin","snapshot":"s","createdAt":5})
        );
        let r = MarkInfo {
            emoji: Some("x".into()),
            kind: "reaction",
            ..m
        };
        assert_eq!(serde_json::to_value(&r).unwrap()["emoji"], "x");
    }

    #[test]
    fn activity_row_json_shape() {
        let r = ActivityRow {
            id: "d".into(),
            kind: "prompt",
            ts: 1,
            prompt_id: Some("prompt-1".into()),
            item_key: None,
            summary: "Bash ls".into(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({"id":"d","kind":"prompt","ts":1,"promptId":"prompt-1","summary":"Bash ls"})
        );
    }

    #[test]
    fn prompt_summaries() {
        let bash = prompt_summary(
            "permission",
            "Bash",
            &json!({"command":"cargo  test"}),
            &None,
        );
        assert_eq!(bash, "Bash cargo test");
        let q = Some(json!([{"question":"Which color?"}]));
        assert_eq!(
            prompt_summary("question", "AskUserQuestion", &json!({}), &q),
            "Which color?"
        );
        assert_eq!(
            prompt_summary("plan", "ExitPlanMode", &json!({}), &None),
            "Plan waiting for approval"
        );
    }
}
