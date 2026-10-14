//! The Claude adapter: tails one session transcript and keeps its chat items.
//!
//! [`Adapter`] is synchronous and testable. [`Watcher`] runs one on a background thread
//! with a short poll interval and an immediate-poll `kick` (hook traffic calls it, so
//! new items usually arrive well inside 500 ms).
//!
//! Subagent threads live in `<transcript stem>/subagents/agent-<id>.jsonl` with a
//! `.meta.json` next to each that names the `toolUseId` of the Agent call.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::item::{ChatItem, ItemBody};
use crate::map::{collect_images, Accounting, Mapper, Meta};
use crate::tail::Tail;

/// Where the adapter looks for a transcript that has not appeared yet.
#[derive(Debug, Clone)]
pub struct Locator {
    /// Claude's config dir (`~/.claude`, or `$CLAUDE_CONFIG_DIR`).
    pub config_dir: PathBuf,
    /// Working directory the session was launched in.
    pub cwd: PathBuf,
    /// Claude session id (the transcript's file stem).
    pub session_id: String,
    /// Exact path, once a hook reported `transcript_path`. Wins over the search.
    pub explicit: Option<PathBuf>,
}

impl Locator {
    /// Directory name claude uses for a cwd: every non-alphanumeric char becomes `-`.
    #[must_use]
    pub fn mangle(cwd: &Path) -> String {
        cwd.to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect()
    }

    /// The transcript path if it exists: the explicit path, the path derived from the cwd
    /// (also trying its canonical form, since claude records the real path), or any project
    /// dir holding `<session id>.jsonl`.
    #[must_use]
    pub fn find(&self) -> Option<PathBuf> {
        if let Some(p) = self.explicit.as_ref().filter(|p| p.is_file()) {
            return Some(p.clone());
        }
        let projects = self.config_dir.join("projects");
        let file = format!("{}.jsonl", self.session_id);
        let mut cwds = vec![self.cwd.clone()];
        if let Ok(real) = self.cwd.canonicalize() {
            if real != self.cwd {
                cwds.push(real);
            }
        }
        for c in cwds {
            let p = projects.join(Self::mangle(&c)).join(&file);
            if p.is_file() {
                return Some(p);
            }
        }
        for entry in std::fs::read_dir(&projects).ok()?.flatten() {
            let p = entry.path().join(&file);
            if p.is_file() {
                return Some(p);
            }
        }
        None
    }
}

/// A position in the item list, for paging backwards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Cursor {
    /// Key of the oldest item the caller already has.
    Key(String),
    /// Position of the oldest item the caller already has (a previous page's `cursor`).
    Index(u64),
}

/// One page of history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// Items, oldest first.
    pub items: Vec<ChatItem>,
    /// There are older items.
    pub has_more: bool,
    /// Position of `items[0]`. Pass it as `before` to get the page before this one.
    pub cursor: u64,
}

/// What one poll found.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Update {
    /// Items created or updated, in order.
    pub items: Vec<ChatItem>,
    /// The first read of an existing file, or a re-read after a reset. These items are
    /// history: show them through `chat_history`, do not count them as new.
    pub initial: bool,
    /// The file was replaced. Drop all items held for this session.
    pub reset: bool,
    /// New `assistant` items that arrived live (0 for `initial` updates).
    pub new_assistant: u32,
    /// [`Adapter::meta`] changed.
    pub meta_changed: bool,
}

impl Update {
    /// Nothing happened.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty() && !self.reset && !self.meta_changed
    }
}

struct Thread {
    tail: Tail,
    mapper: Mapper,
}

/// Tails one transcript and its subagent files.
pub struct Adapter {
    locator: Locator,
    tail: Option<Tail>,
    mapper: Mapper,
    threads: HashMap<String, Thread>,
    synced_once: bool,
    /// The file existed before this adapter started, so its first read is history.
    preexisting: bool,
    /// The next update must carry `reset` (the transcript path changed under us).
    force_reset: bool,
}

impl Adapter {
    /// An adapter that waits for the transcript to appear.
    #[must_use]
    pub fn new(locator: Locator) -> Self {
        let preexisting = locator.find().is_some();
        Self {
            locator,
            tail: None,
            mapper: Mapper::new("main", None),
            threads: HashMap::new(),
            synced_once: false,
            preexisting,
            force_reset: false,
        }
    }

    /// An adapter for a known file (the `dump` tool and tests).
    #[must_use]
    pub fn for_file(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let mut a = Self::new(Locator {
            config_dir: PathBuf::new(),
            cwd: PathBuf::new(),
            session_id: String::new(),
            explicit: Some(path.clone()),
        });
        a.tail = Some(Tail::new(path));
        a.preexisting = true;
        a
    }

    /// The transcript path, once known.
    #[must_use]
    pub fn path(&self) -> Option<&Path> {
        self.tail.as_ref().map(Tail::path)
    }

    /// Point the adapter at an exact transcript (a hook reported `transcript_path`).
    /// Returns true when this changes the file being tailed.
    pub fn set_transcript(&mut self, path: &Path) -> bool {
        if self.path() == Some(path) {
            return false;
        }
        self.locator.explicit = Some(path.to_owned());
        self.tail = Some(Tail::new(path));
        self.force_reset = !self.mapper.items().is_empty();
        self.mapper = Mapper::new("main", None);
        self.threads.clear();
        self.synced_once = false;
        self.preexisting = path.is_file();
        true
    }

    /// Session facts for the status strip chips.
    #[must_use]
    pub fn meta(&self) -> &Meta {
        self.mapper.meta()
    }

    /// Line accounting for the main transcript.
    #[must_use]
    pub fn accounting(&self) -> Accounting {
        self.mapper.accounting()
    }

    /// All items now held.
    #[must_use]
    pub fn items(&self) -> &[ChatItem] {
        self.mapper.items()
    }

    /// The mapper (accounting details for `dump`).
    #[must_use]
    pub fn mapper(&self) -> &Mapper {
        &self.mapper
    }

    /// Read what was appended and map it.
    pub fn poll(&mut self) -> Update {
        if self.tail.is_none() {
            let Some(p) = self.locator.find() else {
                return Update::default();
            };
            self.tail = Some(Tail::new(p));
        }
        let mut update = Update::default();
        if std::mem::take(&mut self.force_reset) {
            update.reset = true;
        }
        while let Some(tail) = self.tail.as_mut() {
            let Ok(poll) = tail.poll() else {
                break;
            };
            if poll.reset {
                self.mapper = Mapper::new("main", None);
                self.threads.clear();
                self.synced_once = false;
                self.preexisting = true;
                update = Update {
                    reset: true,
                    ..Update::default()
                };
            }
            let first = !self.synced_once && !poll.lines.is_empty() && self.preexisting;
            let before = self.mapper.items().len();
            let mut changed: Vec<usize> = Vec::new();
            for (offset, line) in &poll.lines {
                let f = self.mapper.feed(line, *offset);
                update.meta_changed |= f.meta_changed;
                for i in f.changed {
                    if !changed.contains(&i) {
                        changed.push(i);
                    }
                }
            }
            if !poll.lines.is_empty() {
                self.synced_once = true;
            }
            if first {
                update.initial = true;
            }
            // A file that appeared after the adapter started is live from its first line.
            if !update.initial {
                update.new_assistant += changed
                    .iter()
                    .filter(|&&i| {
                        i >= before
                            && matches!(self.mapper.items()[i].body, ItemBody::Assistant { .. })
                    })
                    .count() as u32;
            }
            update
                .items
                .extend(changed.iter().map(|&i| self.mapper.items()[i].clone()));
            if !poll.more {
                break;
            }
        }
        self.refresh_subagents(&mut update);
        update
    }

    /// Flush an unterminated last line (a file that will not grow).
    pub fn finish(&mut self) -> Update {
        let mut update = Update::default();
        let Some(tail) = self.tail.as_mut() else {
            return update;
        };
        if let Some((offset, line)) = tail.take_partial() {
            let f = self.mapper.feed(&line, offset);
            update.meta_changed |= f.meta_changed;
            update.items = f
                .changed
                .iter()
                .map(|&i| self.mapper.items()[i].clone())
                .collect();
        }
        update
    }

    /// A page of history, newest page first. `before` is the oldest item the caller has.
    pub fn history(&mut self, before: Option<&Cursor>, limit: usize) -> Page {
        let end = match before {
            None => self.mapper.items().len(),
            Some(Cursor::Key(k)) => self
                .mapper
                .position(k)
                .unwrap_or_else(|| self.mapper.items().len()),
            Some(Cursor::Index(i)) => usize::try_from(*i).map_or(self.mapper.items().len(), |i| {
                i.min(self.mapper.items().len())
            }),
        };
        let limit = limit.clamp(1, 2_000);
        let start = end.saturating_sub(limit);
        Page {
            items: self.mapper.items()[start..end].to_vec(),
            has_more: start > 0,
            cursor: start as u64,
        }
    }

    /// Move a tool item between `pending` (a permission prompt is open) and `running`.
    pub fn set_tool_pending(&mut self, tool_use_id: &str, pending: bool) -> Option<ChatItem> {
        let i = self.mapper.set_tool_pending(tool_use_id, pending)?;
        Some(self.mapper.items()[i].clone())
    }

    /// Find the id of the newest not-yet-resolved tool call with this name and input.
    /// Used to link a permission prompt (which has no tool use id) to its item.
    #[must_use]
    pub fn find_open_tool(&self, name: &str, input: &Value, exclude: &[String]) -> Option<String> {
        self.mapper
            .items()
            .iter()
            .rev()
            .find_map(|i| match &i.body {
                ItemBody::Tool {
                    tool_use_id,
                    name: n,
                    input: inp,
                    state: crate::item::ToolState::Pending | crate::item::ToolState::Running,
                    ..
                } if n == name && inp == input && !exclude.contains(tool_use_id) => {
                    Some(tool_use_id.clone())
                }
                ItemBody::Plan {
                    tool_use_id,
                    state: crate::item::PlanState::Pending,
                    ..
                } if name == "ExitPlanMode" && !exclude.contains(tool_use_id) => {
                    Some(tool_use_id.clone())
                }
                _ => None,
            })
    }

    /// The items of a subagent thread, oldest first.
    pub fn thread(&mut self, tool_use_id: &str) -> Vec<ChatItem> {
        if !self.thread_ready(tool_use_id) {
            return Vec::new();
        }
        let Some(t) = self.threads.get_mut(tool_use_id) else {
            return Vec::new();
        };
        sync_thread(t);
        t.mapper.items().to_vec()
    }

    /// The `data:` URL of an image ref from an item.
    #[must_use]
    pub fn image(&self, image_ref: &str) -> Option<String> {
        let (tag, rest) = image_ref.split_once('@')?;
        let (offset, n) = rest.split_once('#')?;
        let offset: u64 = offset.parse().ok()?;
        let n: usize = n.parse().ok()?;
        if tag.is_empty()
            || !tag
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return None;
        }
        let path = if tag == "main" {
            self.path()?.to_owned()
        } else {
            self.subagent_dir()?.join(format!("agent-{tag}.jsonl"))
        };
        let mut f = std::fs::File::open(path).ok()?;
        f.seek(SeekFrom::Start(offset)).ok()?;
        let mut line = String::new();
        BufReader::new(f).read_line(&mut line).ok()?;
        let v: Value = serde_json::from_str(line.trim()).ok()?;
        let (media, data) = collect_images(&v).into_iter().nth(n)?;
        if data.is_empty() {
            return None;
        }
        Some(format!("data:{media};base64,{data}"))
    }

    // ---- subagents ----

    fn subagent_dir(&self) -> Option<PathBuf> {
        let p = self.path()?;
        Some(p.with_extension("").join("subagents"))
    }

    /// Make sure a thread entry exists for `tool_use_id`, locating its file.
    fn thread_ready(&mut self, tool_use_id: &str) -> bool {
        if self.threads.contains_key(tool_use_id) {
            return true;
        }
        let Some(dir) = self.subagent_dir() else {
            return false;
        };
        let agent = self
            .mapper
            .agent_id_of(tool_use_id)
            .map(str::to_owned)
            .or_else(|| find_agent_by_meta(&dir, tool_use_id));
        let Some(agent) = agent else {
            return false;
        };
        let file = dir.join(format!("agent-{agent}.jsonl"));
        if !file.is_file() {
            return false;
        }
        self.threads.insert(
            tool_use_id.to_owned(),
            Thread {
                tail: Tail::new(file),
                mapper: Mapper::new(agent, Some(tool_use_id.to_owned())),
            },
        );
        true
    }

    /// Update `itemCount` of subagent items from their files.
    fn refresh_subagents(&mut self, update: &mut Update) {
        let mut ids: Vec<String> = self.mapper.running_subagents();
        for item in &update.items {
            if let ItemBody::Subagent { tool_use_id, .. } = &item.body {
                if !ids.contains(tool_use_id) {
                    ids.push(tool_use_id.clone());
                }
            }
        }
        for id in ids {
            if !self.thread_ready(&id) {
                continue;
            }
            let Some(t) = self.threads.get_mut(&id) else {
                continue;
            };
            sync_thread(t);
            let count = t.mapper.items().len() as u64;
            if let Some(i) = self.mapper.set_subagent_count(&id, count) {
                let item = self.mapper.items()[i].clone();
                match update.items.iter_mut().find(|x| x.key == item.key) {
                    Some(slot) => *slot = item,
                    None => update.items.push(item),
                }
            }
        }
    }
}

fn sync_thread(t: &mut Thread) {
    loop {
        let Ok(poll) = t.tail.poll() else { return };
        if poll.reset {
            t.mapper = Mapper::new(t.mapper_tag(), t.mapper_parent());
        }
        for (off, line) in &poll.lines {
            t.mapper.feed(line, *off);
        }
        if !poll.more {
            break;
        }
    }
}

impl Thread {
    fn mapper_tag(&self) -> String {
        self.tail
            .path()
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("agent-"))
            .unwrap_or("agent")
            .to_owned()
    }

    fn mapper_parent(&self) -> Option<String> {
        self.mapper
            .items()
            .first()
            .and_then(|i| i.parent_tool_use_id.clone())
    }
}

fn find_agent_by_meta(dir: &Path, tool_use_id: &str) -> Option<String> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(agent) = name
            .strip_prefix("agent-")
            .and_then(|n| n.strip_suffix(".meta.json"))
        else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if v.get("toolUseId").and_then(Value::as_str) == Some(tool_use_id) {
            return Some(agent.to_owned());
        }
    }
    None
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

type UpdateFn = dyn Fn(&mut Adapter, Update) + Send + Sync;

struct Shared {
    adapter: Mutex<Adapter>,
    on_update: Box<UpdateFn>,
    interval_ms: AtomicU64,
    stop: AtomicBool,
    kicked: Mutex<bool>,
    cv: Condvar,
}

impl Shared {
    /// Poll once and hand a non-empty update to the callback, all under the adapter lock,
    /// so updates reach the callback in file order.
    fn poll_and_notify(&self) {
        let mut adapter = lock(&self.adapter);
        let update = adapter.poll();
        if !update.is_empty() {
            (self.on_update)(&mut adapter, update);
        }
    }
}

/// A background poller around an [`Adapter`].
pub struct Watcher {
    shared: Arc<Shared>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl Watcher {
    /// Start polling every `interval`. `on_update` runs on the poller thread (or on the
    /// caller of [`Watcher::sync`]) with the adapter locked, for every non-empty update.
    /// It must not call back into this watcher.
    pub fn spawn(
        adapter: Adapter,
        interval: Duration,
        on_update: impl Fn(&mut Adapter, Update) + Send + Sync + 'static,
    ) -> std::io::Result<Self> {
        let shared = Arc::new(Shared {
            adapter: Mutex::new(adapter),
            on_update: Box::new(on_update),
            interval_ms: AtomicU64::new(interval.as_millis().try_into().unwrap_or(50)),
            stop: AtomicBool::new(false),
            kicked: Mutex::new(false),
            cv: Condvar::new(),
        });
        let s = Arc::clone(&shared);
        let handle = std::thread::Builder::new()
            .name("patchroom-transcript".into())
            .spawn(move || {
                while !s.stop.load(Ordering::SeqCst) {
                    s.poll_and_notify();
                    let wait = Duration::from_millis(s.interval_ms.load(Ordering::SeqCst));
                    let mut k = lock(&s.kicked);
                    if !*k {
                        k =
                            s.cv.wait_timeout(k, wait)
                                .unwrap_or_else(PoisonError::into_inner)
                                .0;
                    }
                    *k = false;
                }
            })?;
        Ok(Self {
            shared,
            handle: Mutex::new(Some(handle)),
        })
    }

    /// Change the poll interval (fast while a session is live, slow when it has exited).
    pub fn set_interval(&self, interval: Duration) {
        let ms = interval.as_millis().try_into().unwrap_or(50);
        self.shared.interval_ms.store(ms, Ordering::SeqCst);
        self.kick();
    }

    /// Poll now instead of waiting for the next tick (asynchronous).
    pub fn kick(&self) {
        *lock(&self.shared.kicked) = true;
        self.shared.cv.notify_all();
    }

    /// Poll now on the calling thread. Anything found goes through the callback.
    pub fn sync(&self) {
        self.shared.poll_and_notify();
    }

    /// Run `f` on the adapter. Holds the adapter lock, so keep it short.
    pub fn with<R>(&self, f: impl FnOnce(&mut Adapter) -> R) -> R {
        f(&mut lock(&self.shared.adapter))
    }

    /// Stop the poller and wait for it.
    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.kick();
        if let Some(h) = lock(&self.handle).take() {
            let _ = h.join();
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;
    use std::sync::mpsc;

    fn append(p: &Path, v: &Value) {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .unwrap();
        writeln!(f, "{v}").unwrap();
    }

    fn asst(uuid: &str, text: &str) -> Value {
        json!({"type":"assistant","uuid":uuid,"timestamp":"2026-01-01T00:00:00Z",
               "message":{"model":"m","content":[{"type":"text","text":text}]}})
    }

    #[test]
    fn initial_sync_is_history_then_live_items_count() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        append(&p, &asst("a", "old"));
        let mut a = Adapter::for_file(&p);
        let u = a.poll();
        assert!(u.initial);
        assert_eq!(u.new_assistant, 0);
        assert_eq!(u.items.len(), 1);
        append(&p, &asst("b", "new"));
        let u = a.poll();
        assert!(!u.initial);
        assert_eq!(u.new_assistant, 1);
        assert_eq!(u.items[0].key, "b:0");
        assert!(a.poll().is_empty());
    }

    #[test]
    fn history_pages_newest_first_by_key_or_index() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        for i in 0..10 {
            append(&p, &asst(&format!("u{i}"), &format!("m{i}")));
        }
        let mut a = Adapter::for_file(&p);
        a.poll();
        let p1 = a.history(None, 4);
        assert_eq!(p1.items.len(), 4);
        assert_eq!(p1.items[0].key, "u6:0");
        assert_eq!(p1.items[3].key, "u9:0");
        assert!(p1.has_more);
        let p2 = a.history(Some(&Cursor::Index(p1.cursor)), 4);
        assert_eq!(p2.items[0].key, "u2:0");
        assert_eq!(p2.items[3].key, "u5:0");
        let p3 = a.history(Some(&Cursor::Key(p2.items[0].key.clone())), 4);
        assert_eq!(p3.items.len(), 2);
        assert!(!p3.has_more);
        assert_eq!(p3.cursor, 0);
        let none = a.history(Some(&Cursor::Index(0)), 4);
        assert!(none.items.is_empty() && !none.has_more);
    }

    #[test]
    fn reset_on_rewrite_rebuilds_items() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        append(&p, &asst("a", "one"));
        append(&p, &asst("b", "two"));
        let mut a = Adapter::for_file(&p);
        a.poll();
        std::fs::write(&p, format!("{}\n", asst("c", "compacted"))).unwrap();
        let u = a.poll();
        assert!(u.reset && u.initial);
        assert_eq!(a.items().len(), 1);
        assert_eq!(a.items()[0].key, "c:0");
    }

    #[test]
    fn waits_for_the_file_and_finds_it_by_session_id() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("cfg");
        let cwd = dir.path().join("proj");
        std::fs::create_dir_all(&cwd).unwrap();
        let mut a = Adapter::new(Locator {
            config_dir: cfg.clone(),
            cwd: cwd.clone(),
            session_id: "sid-1".into(),
            explicit: None,
        });
        assert!(a.poll().is_empty());
        let pd = cfg
            .join("projects")
            .join(Locator::mangle(&cwd.canonicalize().unwrap()));
        std::fs::create_dir_all(&pd).unwrap();
        append(&pd.join("sid-1.jsonl"), &asst("a", "hi"));
        assert_eq!(a.poll().items.len(), 1);
    }

    #[test]
    fn mangle_matches_claudes_directory_names() {
        assert_eq!(
            Locator::mangle(Path::new("/Users/x/temp/my.proj_1")),
            "-Users-x-temp-my-proj-1"
        );
    }

    #[test]
    fn subagent_threads_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sess.jsonl");
        append(
            &p,
            &json!({"type":"assistant","uuid":"x","message":{"content":[
                {"type":"tool_use","id":"toolu_ag","name":"Agent","input":{"description":"d"}}]}}),
        );
        let sub = dir.path().join("sess").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(
            sub.join("agent-a1.meta.json"),
            json!({"toolUseId":"toolu_ag","agentType":"general-purpose"}).to_string(),
        )
        .unwrap();
        append(&sub.join("agent-a1.jsonl"), &asst("s1", "working"));
        let mut a = Adapter::for_file(&p);
        let u = a.poll();
        let sa = u.items.iter().find(|i| i.key == "toolu_ag").unwrap();
        assert!(
            matches!(&sa.body, ItemBody::Subagent { item_count: 1, .. }),
            "{sa:?}"
        );
        append(&sub.join("agent-a1.jsonl"), &asst("s2", "more"));
        let u = a.poll();
        assert!(matches!(
            &u.items[0].body,
            ItemBody::Subagent { item_count: 2, .. }
        ));
        let th = a.thread("toolu_ag");
        assert_eq!(th.len(), 2);
        assert_eq!(th[0].parent_tool_use_id.as_deref(), Some("toolu_ag"));
        assert!(a.thread("nope").is_empty());
    }

    #[test]
    fn image_ref_round_trips_and_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let line = json!({"type":"user","uuid":"u","message":{"content":[
            {"type":"text","text":"hi"},
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"QUJD"}}]}});
        append(&p, &asst("a", "x"));
        append(&p, &line);
        let mut a = Adapter::for_file(&p);
        let u = a.poll();
        let img = match &u.items[1].body {
            ItemBody::User { images, .. } => images[0].image_ref.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(a.image(&img).unwrap(), "data:image/png;base64,QUJD");
        assert!(a.image("../../etc@0#0").is_none());
        assert!(a.image("main@0#5").is_none());
        assert!(a.image("garbage").is_none());
    }

    #[test]
    fn watcher_delivers_live_lines_quickly() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        append(&p, &asst("a", "old"));
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let w = Watcher::spawn(
            Adapter::for_file(&p),
            Duration::from_millis(20),
            move |_, u| {
                let _ = lock(&tx).send(u);
            },
        )
        .unwrap();
        let first = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(first.initial);
        let t0 = std::time::Instant::now();
        append(&p, &asst("b", "live"));
        let u = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(t0.elapsed() < Duration::from_millis(500));
        assert_eq!(u.new_assistant, 1);
        assert_eq!(w.with(|a| a.items().len()), 2);
        w.stop();
    }

    #[test]
    fn find_open_tool_links_prompts_to_items() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        append(
            &p,
            &json!({"type":"assistant","uuid":"x","message":{"content":[
                {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}),
        );
        let mut a = Adapter::for_file(&p);
        a.poll();
        assert_eq!(
            a.find_open_tool("Bash", &json!({"command":"ls"}), &[])
                .as_deref(),
            Some("t1")
        );
        assert!(a
            .find_open_tool("Bash", &json!({"command":"ls"}), &["t1".into()])
            .is_none());
        let pending = a.set_tool_pending("t1", true).unwrap();
        assert!(matches!(
            pending.body,
            ItemBody::Tool {
                state: crate::item::ToolState::Pending,
                ..
            }
        ));
        assert!(a.set_tool_pending("t1", true).is_none());
    }
}
