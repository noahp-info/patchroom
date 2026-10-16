//! P3 backend integration tests: sections, flags, drafts, marks, search, Activity, prefs,
//! the notification decision and terminal attention. Real PTYs, a real bridge and a real
//! SQLite file; nothing here touches `~/.claude` or the user's data dir. Claude's config dir is
//! always a temp dir holding synthetic transcripts and settings.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use patchroom_lib::events::{EventSink, UiEvent};
use patchroom_lib::manager::{CreateRequest, Manager, ManagerConfig, PromptAnswer, SessionManager};
use patchroom_lib::notifier::{FocusProbe, Notifier};
use serde_json::{json, Value};

// ---- harness ----

#[derive(Default)]
struct Sink {
    events: Mutex<Vec<UiEvent>>,
    cv: Condvar,
}

impl EventSink for Sink {
    fn emit(&self, event: UiEvent) {
        self.events.lock().unwrap().push(event);
        self.cv.notify_all();
    }
}

impl Sink {
    fn names(&self) -> Vec<&'static str> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .map(UiEvent::name)
            .collect()
    }

    fn count(&self, name: &str) -> usize {
        self.names().iter().filter(|n| **n == name).count()
    }

    fn payloads(&self, name: &str) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.name() == name)
            .map(UiEvent::payload)
            .collect()
    }

    fn output(&self, id: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for e in self.events.lock().unwrap().iter() {
            if let UiEvent::Output { id: i, data } = e {
                if i == id {
                    out.extend(B64.decode(data).unwrap());
                }
            }
        }
        out
    }

    fn wait_for(&self, what: &str, timeout: Duration, mut f: impl FnMut(&[UiEvent]) -> bool) {
        let end = Instant::now() + timeout;
        let mut g = self.events.lock().unwrap();
        while !f(&g) {
            let left = end.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "timed out waiting for {what}");
            g = self.cv.wait_timeout(g, left).unwrap().0;
        }
    }

    fn wait_fire(&self, event: &str, timeout: Duration) -> Value {
        let mut found = Value::Null;
        self.wait_for(&format!("notify:fire {event}"), timeout, |evs| {
            evs.iter().any(|e| {
                let p = e.payload();
                let hit = e.name() == "notify:fire" && p["event"] == event;
                if hit {
                    found = p;
                }
                hit
            })
        });
        found
    }
}

#[derive(Default)]
struct Posts(Mutex<Vec<(String, String, String)>>);

impl Notifier for Posts {
    fn post(&self, dm: &str, title: &str, body: &str) {
        self.0
            .lock()
            .unwrap()
            .push((dm.into(), title.into(), body.into()));
    }
}

struct Probe(AtomicBool);

impl FocusProbe for Probe {
    fn window_active(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

fn hook_bin() -> PathBuf {
    static COPY: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    COPY.get_or_init(|| {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let staged = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("patchroom-hook-"))
            })
            .expect("build.rs stages binaries/patchroom-hook-<triple>");
        let tmp = tempfile::tempdir().unwrap();
        let copy = tmp.path().join("patchroom-hook");
        std::fs::copy(staged, &copy).unwrap();
        (tmp, copy)
    })
    .1
    .clone()
}

/// Short data dir: the unix socket path limit is about 100 bytes.
fn data_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("pr")
        .tempdir_in("/tmp")
        .unwrap()
}

struct Env {
    data: tempfile::TempDir,
    config: tempfile::TempDir,
    cwd: tempfile::TempDir,
    sink: Arc<Sink>,
    posts: Arc<Posts>,
    probe: Arc<Probe>,
    m: SessionManager,
}

/// A stand-in for `claude` that just stays alive, so no test ever starts the real CLI.
fn claude_stub() -> PathBuf {
    static STUB: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    STUB.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("claude-stub");
        std::fs::write(&p, "#!/bin/sh\nsleep 60\n").unwrap();
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        (dir, p)
    })
    .1
    .clone()
}

fn mk_manager(data: &Path, config: &Path, sink: &Arc<Sink>) -> SessionManager {
    let mut cfg = ManagerConfig::new(data, hook_bin());
    cfg.claude_program = claude_stub().to_string_lossy().into_owned();
    cfg.shell = Some("/bin/sh".into());
    cfg.kill_grace = Duration::from_millis(300);
    cfg.claude_config_dir = Some(config.to_path_buf());
    cfg.terminal_hold = Duration::from_millis(150);
    Manager::new(cfg, Arc::clone(sink) as Arc<dyn EventSink>).unwrap()
}

fn env() -> Env {
    let data = data_dir();
    let config = tempfile::tempdir().unwrap();
    let cwd = tempfile::tempdir().unwrap();
    let sink = Arc::new(Sink::default());
    let m = mk_manager(data.path(), config.path(), &sink);
    let posts = Arc::new(Posts::default());
    let probe = Arc::new(Probe(AtomicBool::new(false)));
    m.set_notifier(posts.clone());
    m.set_focus_probe(probe.clone());
    Env {
        data,
        config,
        cwd,
        sink,
        posts,
        probe,
        m,
    }
}

impl Env {
    /// A DM running `sh -c <script>` in the temp cwd.
    fn sh(&self, name: &str, script: &str) -> String {
        self.m
            .create(&CreateRequest {
                cwd: self.cwd.path().to_string_lossy().into_owned(),
                command: Some("sh".into()),
                args: Some(vec!["-c".into(), script.into()]),
                name: Some(name.into()),
                ..CreateRequest::default()
            })
            .unwrap()
    }

    /// A claude DM (the stub program); its transcript path is in the temp config dir and
    /// the test writes the file.
    fn claude_dm(&self, name: &str) -> (String, PathBuf) {
        let id = self
            .m
            .create(&CreateRequest {
                cwd: self.cwd.path().to_string_lossy().into_owned(),
                name: Some(name.into()),
                ..CreateRequest::default()
            })
            .unwrap();
        let sid = self
            .m
            .list()
            .unwrap()
            .into_iter()
            .find(|s| s.id == id)
            .and_then(|s| s.claude_session_id)
            .unwrap();
        let dir = self
            .config
            .path()
            .join("projects")
            .join(patchroom_claude::Locator::mangle(self.cwd.path()));
        std::fs::create_dir_all(&dir).unwrap();
        (id, dir.join(format!("{sid}.jsonl")))
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.m.decision_log_path()).unwrap_or_default()
    }

    fn wait_log(&self, what: &str, needle: &str) {
        let end = Instant::now() + Duration::from_secs(10);
        while !self.log().contains(needle) {
            assert!(
                Instant::now() < end,
                "no log line {what}: {needle:?} in\n{}",
                self.log()
            );
            std::thread::sleep(Duration::from_millis(30));
        }
    }
}

fn append(path: &Path, lines: &[Value]) {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    for l in lines {
        writeln!(f, "{l}").unwrap();
    }
}

fn user_line(uuid: &str, text: &str) -> Value {
    json!({"type":"user","uuid":uuid,"timestamp":"2026-01-01T00:00:01.000Z",
           "message":{"role":"user","content":text}})
}

fn assistant_line(uuid: &str, text: &str) -> Value {
    json!({"type":"assistant","uuid":uuid,"timestamp":"2026-01-01T00:00:02.000Z",
           "message":{"role":"assistant","model":"m","content":[{"type":"text","text":text}]}})
}

/// Send a hook event for DM `key` to the bridge socket, as `patchroom-hook` would.
fn send_hook(
    sock: &Path,
    key: &str,
    payload: Value,
    wait_ms: u64,
) -> std::os::unix::net::UnixStream {
    let mut s = std::os::unix::net::UnixStream::connect(sock).unwrap();
    let mut payload = payload;
    payload["session_id"] = json!("00000000-0000-4000-8000-0000000000aa");
    payload["cwd"] = json!("/tmp");
    let line = json!({
        "v": 1, "type": "hook", "session_key": key, "hook_pid": 1, "ppid": 0,
        "wait_ms": wait_ms, "payload": payload
    });
    s.write_all(format!("{line}\n").as_bytes()).unwrap();
    s.flush().unwrap();
    s
}

fn wait_until(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + timeout;
    while !f() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(40));
    }
}

fn section_names(m: &SessionManager) -> Vec<String> {
    m.sections().unwrap().into_iter().map(|s| s.name).collect()
}

fn section_id(m: &SessionManager, name: &str) -> String {
    m.sections()
        .unwrap()
        .into_iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| panic!("no section {name}"))
        .id
}

fn dm_ids_in(m: &SessionManager, section: &str) -> Vec<String> {
    m.list()
        .unwrap()
        .into_iter()
        .filter(|s| s.section_id.as_deref() == Some(section))
        .map(|s| s.name)
        .collect()
}

// ---- sections, placement, flags, drafts ----

#[test]
fn default_sections_exist_and_the_whole_layout_survives_a_restart() {
    let e = env();
    assert_eq!(section_names(&e.m), ["Starred", "Sessions", "Archived"]);
    let dm = section_id(&e.m, "Sessions");
    let a = e.sh("a", "sleep 30");
    let b = e.sh("b", "sleep 30");
    let c = e.sh("c", "sleep 30");
    assert_eq!(
        dm_ids_in(&e.m, &dm),
        ["a", "b", "c"],
        "new sessions land in Sessions"
    );

    // Create, rename, reorder and collapse sections.
    let work = e.m.create_section("Work").unwrap();
    e.m.section_rename(&work, "Client work").unwrap();
    e.m.set_section_collapsed(&work, true).unwrap();
    let starred = section_id(&e.m, "Starred");
    let archived = section_id(&e.m, "Archived");
    e.m.section_reorder(&[work.clone(), starred.clone()])
        .unwrap();
    assert_eq!(
        section_names(&e.m),
        ["Client work", "Starred", "Sessions", "Archived"],
        "unlisted sections follow in their old order"
    );
    assert!(e.m.section_reorder(&["nope".into()]).is_err());

    // Move and order DMs in one call; unlisted DMs of the section stay after.
    e.m.session_reorder(Some(&work), &[c.clone(), a.clone()])
        .unwrap();
    assert_eq!(dm_ids_in(&e.m, &work), ["c", "a"]);
    assert_eq!(dm_ids_in(&e.m, &dm), ["b"]);
    e.m.session_reorder(Some(&work), std::slice::from_ref(&b))
        .unwrap();
    assert_eq!(dm_ids_in(&e.m, &work), ["b", "c", "a"]);
    assert!(e
        .m
        .session_reorder(Some(&work), &[b.clone(), b.clone()])
        .is_err());
    assert!(e.m.session_reorder(Some("bogus"), &[]).is_err());

    // Flags and drafts.
    e.m.set_flags(&a, Some(true), None).unwrap();
    e.m.set_flags(&b, None, Some(true)).unwrap();
    e.m.draft_set(&c, "half a thought").unwrap();
    assert_eq!(e.m.draft_get(&c).unwrap(), "half a thought");
    assert_eq!(e.m.draft_get(&a).unwrap(), "");
    assert!(e.m.draft_get("bogus").is_err());
    let _ = archived;
    e.m.shutdown();

    // Restart over the same data dir.
    let sink2 = Arc::new(Sink::default());
    let m2 = mk_manager(e.data.path(), e.config.path(), &sink2);
    assert_eq!(
        section_names(&m2),
        ["Client work", "Starred", "Sessions", "Archived"]
    );
    assert!(m2.sections().unwrap()[0].collapsed);
    assert_eq!(dm_ids_in(&m2, &work), ["b", "c", "a"]);
    let list = m2.list().unwrap();
    let by = |n: &str| list.iter().find(|s| s.name == n).unwrap().clone();
    assert!(by("a").starred && !by("a").archived);
    assert!(by("b").archived && !by("b").starred);
    assert!(by("c").has_draft && !by("a").has_draft);
    assert_eq!(m2.draft_get(&c).unwrap(), "half a thought");

    // An empty draft deletes it.
    m2.draft_set(&c, "").unwrap();
    assert!(!m2.list().unwrap().iter().any(|s| s.has_draft));

    // Deleting a section sends its sessions to Sessions; that section cannot be deleted.
    m2.section_delete(&work).unwrap();
    assert_eq!(dm_ids_in(&m2, &dm), ["b", "c", "a"]);
    assert!(!section_names(&m2).contains(&"Client work".to_owned()));
    assert!(m2.section_delete(&dm).is_err());
    assert!(m2.section_delete(&work).is_err(), "already gone");
    m2.shutdown();
}

#[test]
fn archiving_zeroes_the_badge_and_unarchiving_restores_it() {
    let e = env();
    let (id, transcript) = e.claude_dm("arch");
    append(
        &transcript,
        &[user_line("u1", "hi"), assistant_line("a1", "hello there")],
    );
    e.m.chat_history(&id, None, None).unwrap();
    wait_until("an unread badge", Duration::from_secs(5), || {
        e.m.list().unwrap()[0].unread == 1
    });
    e.m.set_flags(&id, None, Some(true)).unwrap();
    assert_eq!(e.m.list().unwrap()[0].unread, 0, "archived DMs never badge");
    let last = e.sink.payloads("session:badges").pop().unwrap();
    assert_eq!(last["unread"], 0);
    assert!(
        e.m.activity_list().unwrap().is_empty(),
        "archived unread is not activity"
    );
    e.m.set_flags(&id, None, Some(false)).unwrap();
    assert_eq!(e.m.list().unwrap()[0].unread, 1);
    assert_eq!(
        e.sink.payloads("session:badges").pop().unwrap()["unread"],
        1
    );
    assert!(e.sink.count("activity:changed") > 0);
    e.m.shutdown();
}

// ---- marks, search, locate, activity ----

fn history_keys(m: &SessionManager, id: &str) -> Vec<String> {
    m.chat_history(id, None, Some(2000))
        .unwrap()
        .items
        .into_iter()
        .map(|i| i.key)
        .collect()
}

#[test]
fn marks_search_locate_and_index_cleanup() {
    let e = env();
    let (id, transcript) = e.claude_dm("marks");
    let mut lines = Vec::new();
    for i in 0..120 {
        let text = if i == 7 {
            "the zebrafish migration plan".to_owned()
        } else {
            format!("routine message number {i} about caching")
        };
        lines.push(user_line(&format!("u{i}"), &text));
        lines.push(assistant_line(&format!("a{i}"), &format!("ack {i}")));
    }
    append(&transcript, &lines);
    let keys = history_keys(&e.m, &id);
    assert_eq!(keys.len(), 240);

    // Search finds the exact message and gives UTF-16 ranges for the highlight.
    wait_until(
        "the index to have the transcript",
        Duration::from_secs(10),
        || e.m.search("zebrafish", None, None).unwrap().hits.len() == 1,
    );
    let r = e.m.search("zebrafish migr", None, None).unwrap();
    assert_eq!(r.hits.len(), 1);
    let hit = &r.hits[0];
    assert_eq!(hit.id, id);
    assert!(keys.contains(&hit.item_key));
    let units: Vec<u16> = hit.snippet.encode_utf16().collect();
    let marked: Vec<String> = hit
        .ranges
        .iter()
        .map(|[s, e]| String::from_utf16_lossy(&units[*s..*e]))
        .collect();
    assert_eq!(marked, ["zebrafish", "migration"]);
    assert!(
        e.m.search("zebrafish", Some(&id), Some(5))
            .unwrap()
            .hits
            .len()
            == 1
    );
    assert!(e
        .m
        .search("zebrafish", Some("other"), None)
        .unwrap()
        .hits
        .is_empty());
    assert!(e.m.search("   ", None, None).unwrap().hits.is_empty());
    assert!(r.took_ms < 200.0);

    // chat_locate: the cursor's page (default 30 items here) contains the hit.
    let loc = e.m.chat_locate(&id, &hit.item_key).unwrap();
    let before = loc.before.clone().expect("an old item needs a cursor");
    let page =
        e.m.chat_history(&id, Some(patchroom_claude::Cursor::Key(before)), Some(30))
            .unwrap();
    assert!(page.items.iter().any(|i| i.key == hit.item_key));
    // A recent item is on the newest page.
    let newest = keys.last().unwrap();
    assert_eq!(e.m.chat_locate(&id, newest).unwrap().before, None);
    assert!(e.m.chat_locate(&id, "no-such-key").is_err());
    assert!(e.m.chat_locate("bogus", newest).is_err());

    // Pins, saved items and reactions anchor to (DM, item key).
    let pin = e.m.mark_add(&id, &hit.item_key, "pin", None).unwrap();
    assert_eq!(pin.kind, "pin");
    assert!(pin.snapshot.contains("zebrafish"));
    let again = e.m.mark_add(&id, &hit.item_key, "pin", None).unwrap();
    assert_eq!(again.id, pin.id, "adding twice is a no-op");
    e.m.mark_add(&id, &hit.item_key, "saved", None).unwrap();
    e.m.mark_add(&id, newest, "reaction", Some(":white_check_mark:"))
        .unwrap();
    e.m.mark_add(&id, newest, "reaction", Some("\u{1f389}"))
        .unwrap();
    assert!(e.m.mark_add(&id, newest, "reaction", None).is_err());
    assert!(e.m.mark_add(&id, "no-such-key", "pin", None).is_err());
    assert!(e.m.mark_add(&id, newest, "bogus", None).is_err());
    assert_eq!(e.m.mark_list(Some(&id), None).unwrap().len(), 4);
    assert_eq!(e.m.mark_list(None, Some("reaction")).unwrap().len(), 2);
    let saved = e.m.mark_list(None, Some("saved")).unwrap();
    assert_eq!(saved[0].conversation_id, id);
    assert_eq!(saved[0].item_key, hit.item_key);
    e.m.mark_remove(&id, newest, "reaction", Some("\u{1f389}"))
        .unwrap();
    assert_eq!(e.m.mark_list(None, Some("reaction")).unwrap().len(), 1);

    // Marks and the index survive a restart; deleting the DM deletes both.
    e.m.shutdown();
    let sink2 = Arc::new(Sink::default());
    let m2 = mk_manager(e.data.path(), e.config.path(), &sink2);
    assert_eq!(m2.mark_list(Some(&id), None).unwrap().len(), 3);
    wait_until("the index after restart", Duration::from_secs(10), || {
        m2.search("zebrafish", None, None).unwrap().hits.len() == 1
    });
    m2.delete(&id).unwrap();
    assert!(m2.search("zebrafish", None, None).unwrap().hits.is_empty());
    assert!(m2.mark_list(None, None).unwrap().is_empty());
    m2.shutdown();
}

#[test]
fn other_claude_sessions_are_searched_only_when_the_pref_is_on() {
    let e = env();
    let (id, transcript) = e.claude_dm("mine");
    append(&transcript, &[user_line("u1", "my own quokka note")]);
    e.m.chat_history(&id, None, None).unwrap();
    // Another Claude Code session, which Patchroom does not own.
    let other = e.config.path().join("projects").join("-some-other-project");
    std::fs::create_dir_all(&other).unwrap();
    let other_file = other.join("11111111-2222-4333-8444-555555555555.jsonl");
    append(
        &other_file,
        &[user_line("x1", "somebody else's quokka secret")],
    );
    let before = std::fs::read(&other_file).unwrap();

    wait_until("own transcript indexed", Duration::from_secs(10), || {
        !e.m.search("quokka", None, None).unwrap().hits.is_empty()
    });
    let hits = e.m.search("quokka", None, None).unwrap().hits;
    assert_eq!(hits.len(), 1, "default: Patchroom DMs only");
    assert_eq!(hits[0].id, id);
    assert!(!e.m.prefs_get().search_all_sessions);

    e.m.prefs_set(&json!({"searchAllSessions": true})).unwrap();
    wait_until(
        "the other session to be indexed",
        Duration::from_secs(15),
        || e.m.search("quokka", None, None).unwrap().hits.len() == 2,
    );
    let ids: Vec<String> =
        e.m.search("quokka", None, None)
            .unwrap()
            .hits
            .into_iter()
            .map(|h| h.id)
            .collect();
    assert!(ids.iter().any(|i| i.starts_with("claude:")), "{ids:?}");

    e.m.prefs_set(&json!({"searchAllSessions": false})).unwrap();
    assert_eq!(e.m.search("quokka", None, None).unwrap().hits.len(), 1);
    assert_eq!(
        std::fs::read(&other_file).unwrap(),
        before,
        "transcripts are read only"
    );
    e.m.shutdown();
}

#[test]
fn search_reindex_rebuilds_from_the_transcripts() {
    let e = env();
    let (id, transcript) = e.claude_dm("re");
    append(&transcript, &[user_line("u1", "alpacas are great")]);
    e.m.chat_history(&id, None, None).unwrap();
    wait_until("indexed", Duration::from_secs(10), || {
        e.m.search("alpacas", None, None).unwrap().hits.len() == 1
    });
    let r = e.m.search_reindex().unwrap();
    assert!(r.docs >= 1);
    assert_eq!(e.m.search("alpacas", None, None).unwrap().hits.len(), 1);
    e.m.shutdown();
}

#[test]
fn activity_lists_prompts_and_unread_oldest_first_and_clears_on_answer() {
    let e = env();
    let (id, transcript) = e.claude_dm("act");
    assert!(e.m.activity_list().unwrap().is_empty());

    // An unread finished turn.
    append(
        &transcript,
        &[
            user_line("u1", "do it"),
            assistant_line("a1", "Done: wrote the file"),
        ],
    );
    e.m.chat_history(&id, None, None).unwrap();
    wait_until("an unread row", Duration::from_secs(5), || {
        !e.m.activity_list().unwrap().is_empty()
    });
    let rows = e.m.activity_list().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, "unread");
    assert_eq!(rows[0].id, id);
    assert!(
        rows[0].summary.contains("wrote the file"),
        "{}",
        rows[0].summary
    );
    assert!(rows[0].item_key.is_some());

    // A permission prompt, newer than the unread row.
    std::thread::sleep(Duration::from_millis(5));
    let sock = e.data.path().join("bridge.sock");
    let hook = send_hook(
        &sock,
        &id,
        json!({"hook_event_name":"PermissionRequest","tool_name":"Bash",
               "tool_input":{"command":"cargo test"},"permission_suggestions":[]}),
        30_000,
    );
    e.sink
        .wait_for("prompt:pending", Duration::from_secs(5), |evs| {
            evs.iter().any(|v| v.name() == "prompt:pending")
        });
    let rows = e.m.activity_list().unwrap();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(rows[0].kind, "unread", "oldest first");
    let prompt = &rows[1];
    assert_eq!(prompt.kind, "prompt");
    assert!(prompt
        .prompt_id
        .as_deref()
        .is_some_and(|p| p.starts_with("prompt-")));
    assert!(prompt.summary.contains("cargo test"), "{}", prompt.summary);
    assert!(prompt.ts >= rows[0].ts);

    // Answering removes the prompt row; reading removes the unread row.
    let pid = prompt.prompt_id.clone().unwrap();
    e.m.prompt_answer(&id, &pid, PromptAnswer::Allow).unwrap();
    drop(hook);
    wait_until("prompt row gone", Duration::from_secs(5), || {
        e.m.activity_list()
            .unwrap()
            .iter()
            .all(|r| r.kind != "prompt")
    });
    e.m.mark_read(&id).unwrap();
    assert!(e.m.activity_list().unwrap().is_empty());
    assert!(e.sink.count("activity:changed") >= 2);
    e.m.shutdown();
}

// ---- prefs ----

#[test]
fn prefs_persist_validate_and_emit() {
    let e = env();
    let p = e.m.prefs_get();
    assert_eq!(serde_json::to_value(&p).unwrap()["themeId"], "homeroom");
    let next = e
        .m
        .prefs_set(&json!({
            "themeId": "patchbay",
            "mode": "dark",
            "notify": {"default": "needs", "perDm": {"d1": "mute"}},
            "dnd": {"manual": false, "schedule": {"days": [1, 2], "start": "22:00", "end": "07:00"}},
            "termPerDm": {"d1": {"themeId": "scrollback", "fontSize": 14}},
            "customThemes": [{"id": "mine", "name": "Mine"}]
        }))
        .unwrap();
    assert_eq!(
        serde_json::to_value(&next).unwrap()["notify"]["default"],
        "needs"
    );
    let changed = e.sink.payloads("prefs:changed");
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0]["prefs"]["themeId"], "patchbay");

    // Bad patches change nothing and emit nothing.
    assert!(e.m.prefs_set(&json!({"mode": "purple"})).is_err());
    assert!(e.m.prefs_set(&json!({"nope": 1})).is_err());
    assert!(e.m.prefs_set(&json!("str")).is_err());
    assert_eq!(e.sink.count("prefs:changed"), 1);
    assert_eq!(e.m.prefs_get(), next);
    e.m.shutdown();

    let sink2 = Arc::new(Sink::default());
    let m2 = mk_manager(e.data.path(), e.config.path(), &sink2);
    assert_eq!(m2.prefs_get(), next, "prefs survive a restart");
    m2.shutdown();
}

// ---- sound hooks ----

fn write_settings(dir: &Path, name: &str, v: &Value) -> Vec<u8> {
    std::fs::create_dir_all(dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, v.to_string()).unwrap();
    std::fs::read(p).unwrap()
}

#[test]
fn sound_hooks_are_detected_read_only_from_user_project_and_local_settings() {
    let e = env();
    let user = write_settings(
        e.config.path(),
        "settings.json",
        &json!({"hooks": {"Stop": [{"hooks": [{"type":"command","command":"afplay /s/done.aiff"}]}],
                          "PreToolUse": [{"hooks": [{"type":"command","command":"./lint.sh"}]}]}}),
    );
    let proj_dir = e.cwd.path().join(".claude");
    let _ = e.sh("p", "sleep 30");
    let proj = write_settings(
        &proj_dir,
        "settings.json",
        &json!({"hooks": {"Notification": [{"hooks": [{"type":"command","command":"say needs you"}]}]}}),
    );
    let local = write_settings(
        &proj_dir,
        "settings.local.json",
        &json!({"hooks": {"TaskCompleted": [{"hooks": [{"type":"command","command":"osascript -e 'beep'"}]}]}}),
    );
    let found = e.m.sound_hooks_detect();
    let mut got: Vec<(String, String)> = found
        .iter()
        .map(|h| (h.source.clone(), h.event.clone()))
        .collect();
    got.sort();
    assert_eq!(
        got,
        [
            ("local".to_owned(), "TaskCompleted".to_owned()),
            ("project".to_owned(), "Notification".to_owned()),
            ("user".to_owned(), "Stop".to_owned()),
        ]
    );
    assert_eq!(
        std::fs::read(e.config.path().join("settings.json")).unwrap(),
        user
    );
    assert_eq!(std::fs::read(proj_dir.join("settings.json")).unwrap(), proj);
    assert_eq!(
        std::fs::read(proj_dir.join("settings.local.json")).unwrap(),
        local
    );
    e.m.shutdown();
}

// ---- notifications ----

const HOLD_SETTLE: Duration = Duration::from_millis(900);

#[test]
fn bell_osc9_and_osc777_notify_once_each_without_altering_the_bytes() {
    let e = env();
    let id = e.sh(
        "term",
        "sleep 0.4; printf 'A\\007B'; sleep 2.2; printf '\\033]9;build finished\\007'; \
         sleep 2.2; printf '\\033]777;notify;Deploy;SECRET-BODY-TEXT\\033\\\\'; sleep 3",
    );
    let bell = e.sink.wait_fire("bell", Duration::from_secs(10));
    assert_eq!(bell["id"], id);
    assert_eq!(bell["title"], "term");
    let msg = e.sink.wait_fire("message", Duration::from_secs(10));
    assert_eq!(msg["body"], "build finished");
    e.sink
        .wait_for("the OSC 777 message", Duration::from_secs(10), |evs| {
            evs.iter()
                .filter(|v| v.name() == "notify:fire" && v.payload()["event"] == "message")
                .count()
                == 2
        });
    let posts = e.posts.0.lock().unwrap().clone();
    assert_eq!(
        posts.len(),
        3,
        "one native notification per event: {posts:?}"
    );
    assert!(posts.iter().all(|p| p.0 == id && p.1 == "term"));
    assert_eq!(posts[2].2, "Deploy: SECRET-BODY-TEXT");

    // The terminal still gets every byte, escape sequences included.
    wait_until("output", Duration::from_secs(10), || {
        e.sink.output(&id).windows(4).any(|w| w == b"\x1b]77")
    });
    let out = e.sink.output(&id);
    assert!(
        out.windows(3).any(|w| w == b"A\x07B"),
        "the BEL reaches xterm"
    );
    let text = String::from_utf8_lossy(&out).into_owned();
    assert!(text.contains("\u{1b}]9;build finished\u{7}"), "{text:?}");
    assert!(
        text.contains("\u{1b}]777;notify;Deploy;SECRET-BODY-TEXT\u{1b}\\"),
        "{text:?}"
    );

    // The decision log has the facts and never the message text.
    let log = e.log();
    assert!(
        log.contains(&format!("event=bell dm={id} decision=fire reason=ok")),
        "{log}"
    );
    assert!(
        log.contains(&format!("event=message dm={id} decision=fire reason=ok")),
        "{log}"
    );
    assert!(
        !log.contains("SECRET-BODY-TEXT") && !log.contains("build finished"),
        "{log}"
    );
    e.m.shutdown();
}

#[test]
fn osc_title_sets_session_title_and_info_title() {
    let e = env();
    let id = e.sh(
        "t",
        "sleep 0.3; printf '\\033]0;Fixing the build\\007x\\033]2;second\\033\\\\'; sleep 3",
    );
    e.sink
        .wait_for("second title", Duration::from_secs(10), |evs| {
            evs.iter().filter(|v| v.name() == "session:title").count() >= 2
        });
    let titles: Vec<Value> = e.sink.payloads("session:title");
    assert_eq!(titles[0], json!({"id": id, "title": "Fixing the build"}));
    assert_eq!(titles[1], json!({"id": id, "title": "second"}));
    assert_eq!(e.m.list().unwrap()[0].title, "second");
    e.m.shutdown();
}

#[test]
fn levels_dnd_focus_and_archive_decide_and_every_decision_is_logged() {
    let e = env();
    // A bell every 3 s for a while; each is its own decision.
    let id = e.sh(
        "dm",
        "i=0; while [ $i -lt 40 ]; do printf '\\007'; sleep 2.5; i=$((i+1)); done",
    );
    let fires = |n: usize| {
        e.sink.wait_for("fires", Duration::from_secs(12), |evs| {
            evs.iter().filter(|v| v.name() == "notify:fire").count() >= n
        });
    };
    fires(1);
    let log = e.log();
    assert!(log.contains("decision=fire reason=ok"), "{log}");

    // Needs-only: bells are suppressed with the reason in the log.
    e.m.prefs_set(&json!({"notify": {"default": "needs", "perDm": {}}}))
        .unwrap();
    e.wait_log("needs-only", "decision=suppress reason=level_needs_only");
    // A per-DM level beats the default.
    e.m.prefs_set(&json!({"notify": {"default": "needs", "perDm": {id.clone(): "mute"}}}))
        .unwrap();
    e.wait_log("muted", "decision=suppress reason=dm_muted");
    e.m.prefs_set(&json!({"notify": {"default": "all", "perDm": {}}}))
        .unwrap();
    let fired = e.sink.count("notify:fire");
    fires(fired + 1);

    // Manual DND.
    e.m.prefs_set(&json!({"dnd": {"manual": true, "schedule": null}}))
        .unwrap();
    e.wait_log("dnd", "decision=suppress reason=dnd");
    e.m.prefs_set(&json!({"dnd": {"manual": false, "schedule": null}}))
        .unwrap();

    // A schedule crossing midnight, judged on the injected local clock (Monday 23:30, then noon).
    let clock = Arc::new(Mutex::new(
        chrono::NaiveDate::from_ymd_opt(2026, 10, 12)
            .unwrap()
            .and_hms_opt(23, 30, 0)
            .unwrap(),
    ));
    let c2 = Arc::clone(&clock);
    e.m.set_local_clock(Some(Arc::new(move || *c2.lock().unwrap())));
    e.m.prefs_set(&json!({"dnd": {"manual": false,
        "schedule": {"days": [1], "start": "22:00", "end": "07:00"}}}))
        .unwrap();
    let n = e.log().matches("reason=dnd").count();
    wait_until(
        "a scheduled-dnd suppression",
        Duration::from_secs(10),
        || e.log().matches("reason=dnd").count() > n,
    );
    *clock.lock().unwrap() = chrono::NaiveDate::from_ymd_opt(2026, 10, 13)
        .unwrap()
        .and_hms_opt(6, 59, 0)
        .unwrap();
    let n = e.log().matches("reason=dnd").count();
    wait_until(
        "still in the window past midnight",
        Duration::from_secs(10),
        || e.log().matches("reason=dnd").count() > n,
    );
    *clock.lock().unwrap() = chrono::NaiveDate::from_ymd_opt(2026, 10, 13)
        .unwrap()
        .and_hms_opt(7, 0, 0)
        .unwrap();
    let fired = e.sink.count("notify:fire");
    fires(fired + 1);
    e.m.set_local_clock(None);
    e.m.prefs_set(&json!({"dnd": {"manual": false, "schedule": null}}))
        .unwrap();

    // Focus: the DM the user is looking at, in an active window, does not notify.
    e.m.session_focus(Some(&id));
    e.probe.0.store(true, Ordering::SeqCst);
    e.wait_log("focus", "decision=suppress reason=focused");
    e.probe.0.store(false, Ordering::SeqCst);
    let fired = e.sink.count("notify:fire");
    fires(fired + 1);
    // Another DM in focus does not hide this one.
    e.probe.0.store(true, Ordering::SeqCst);
    e.m.session_focus(Some("some-other-dm"));
    let fired = e.sink.count("notify:fire");
    fires(fired + 1);
    e.m.session_focus(None);

    // Archived: only needs-you gets through.
    e.m.set_flags(&id, None, Some(true)).unwrap();
    e.wait_log("archived", "decision=suppress reason=archived");

    // One line per decision: each carries event, dm id, decision and reason, nothing else.
    for line in e.log().lines() {
        let rest = line.split_once(' ').unwrap().1;
        let keys: Vec<&str> = rest
            .split(' ')
            .map(|kv| kv.split('=').next().unwrap())
            .collect();
        assert_eq!(keys, ["event", "dm", "decision", "reason"], "{line}");
    }
    e.m.shutdown();
}

#[test]
fn a_permission_prompt_notifies_once_even_when_the_terminal_also_rings() {
    let e = env();
    let id = e.sh(
        "perm",
        "sleep 1.2; printf '\\033]9;Claude needs your permission\\007'; sleep 6",
    );
    let sock = e.data.path().join("bridge.sock");
    std::thread::sleep(Duration::from_millis(900));
    let hook = send_hook(
        &sock,
        &id,
        json!({"hook_event_name":"PermissionRequest","tool_name":"Bash",
               "tool_input":{"command":"ls"},"permission_suggestions":[]}),
        30_000,
    );
    let fire = e.sink.wait_fire("needs", Duration::from_secs(10));
    assert_eq!(fire["id"], id);
    assert_eq!(fire["body"], "Waiting for your permission");
    // The OSC 9 from the same moment is held, then dropped as a duplicate.
    e.wait_log("duplicate", "event=message");
    std::thread::sleep(HOLD_SETTLE);
    let log = e.log();
    assert!(
        log.contains(&format!(
            "event=message dm={id} decision=suppress reason=duplicate"
        )),
        "{log}"
    );
    assert_eq!(e.posts.0.lock().unwrap().len(), 1, "told once: {log}");
    assert_eq!(e.sink.count("notify:fire"), 1);
    drop(hook);
    e.m.shutdown();
}

#[test]
fn a_finished_turn_notifies_done_and_respects_the_users_own_stop_hook() {
    let e = env();
    let settings = write_settings(
        e.config.path(),
        "settings.json",
        &json!({"hooks": {"Stop": [{"hooks": [{"type":"command","command":"afplay /s/done.aiff"}]}]}}),
    );
    let id = e.sh("done", "sleep 60");
    let sock = e.data.path().join("bridge.sock");
    let turn = |n: usize| {
        drop(send_hook(
            &sock,
            &id,
            json!({"hook_event_name":"UserPromptSubmit"}),
            1000,
        ));
        wait_until("busy", Duration::from_secs(5), || {
            e.m.list().unwrap()[0].status == patchroom_lib::events::PresenceStatus::Busy
        });
        drop(send_hook(
            &sock,
            &id,
            json!({"hook_event_name":"Stop"}),
            1000,
        ));
        wait_until("the decision count", Duration::from_secs(5), || {
            e.log().matches("event=done").count() >= n
        });
    };

    // Default policy is "keep yours": Patchroom stays silent for Stop.
    turn(1);
    assert!(
        e.log().contains(&format!(
            "event=done dm={id} decision=suppress reason=hook_keep"
        )),
        "{}",
        e.log()
    );
    assert_eq!(e.sink.count("notify:fire"), 0);

    // "Play both" lets it through.
    e.m.prefs_set(&json!({"sound": {
        "enabled": true, "volume": 0.5,
        "perEvent": {"needs":{"on":true,"sound":"needs"}},
        "perDm": {}, "hookPolicy": {"Stop": "both"}}}))
        .unwrap();
    turn(2);
    let fire = e.sink.wait_fire("done", Duration::from_secs(5));
    assert_eq!(fire["id"], id);
    assert_eq!(fire["title"], "done");
    assert_eq!(e.posts.0.lock().unwrap().len(), 1);
    assert_eq!(
        std::fs::read(e.config.path().join("settings.json")).unwrap(),
        settings,
        "the user's hook file is never touched"
    );
    e.m.shutdown();
}

#[test]
fn notify_test_posts_and_fires_regardless_of_dnd() {
    let e = env();
    e.m.prefs_set(&json!({"dnd": {"manual": true, "schedule": null}}))
        .unwrap();
    e.m.notify_test();
    let fire = e.sink.wait_fire("message", Duration::from_secs(2));
    assert_eq!(fire["id"], "");
    assert_eq!(fire["title"], "Patchroom");
    assert_eq!(e.posts.0.lock().unwrap().len(), 1);
    assert!(e.log().contains("dm=test decision=fire reason=test"));
    e.m.shutdown();
}

#[test]
fn an_unexpected_exit_notifies_an_error_but_a_user_kill_does_not() {
    let e = env();
    let crashed = e.sh("crash", "sleep 0.5; exit 3");
    let fire = e.sink.wait_fire("error", Duration::from_secs(10));
    assert_eq!(fire["id"], crashed);
    assert_eq!(fire["body"], "The session exited with code 3");
    let killed = e.sh("killme", "sleep 60");
    e.m.kill(&killed).unwrap();
    wait_until("the killed DM to exit", Duration::from_secs(10), || {
        e.m.list()
            .unwrap()
            .iter()
            .any(|s| s.id == killed && s.status == patchroom_lib::events::PresenceStatus::Exited)
    });
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        e.sink.payloads("notify:fire").len(),
        1,
        "only the crash notified: {}",
        e.log()
    );
    e.m.shutdown();
}
