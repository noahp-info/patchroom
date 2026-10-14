//! Session parity in the manager: the live re-check before every spawn, the read-only mirror,
//! take-over, the terminal-only dialog signal and the typed send outcome.
//!
//! Claude is a stub that records every start in `starts.txt`; `claude agents --json` is a
//! fixed list the test edits. Nothing here touches a real session.

use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use patchroom_bridge::{AgentEntry, AgentsSource};
use patchroom_lib::events::{EventSink, UiEvent};
use patchroom_lib::manager::{CreateRequest, Manager, ManagerConfig, SendOutcome, SessionManager};
use serde_json::{json, Value};

const SID: &str = "aaaaaaaa-0000-4000-8000-000000000001";

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
    fn count(&self, name: &str) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.name() == name)
            .count()
    }

    /// Wait until more than `before` events called `name` arrived; return the newest payload.
    fn wait_for(&self, name: &str, before: usize, secs: u64) -> Value {
        let end = Instant::now() + Duration::from_secs(secs);
        let mut g = self.events.lock().unwrap();
        loop {
            let hits: Vec<Value> = g
                .iter()
                .filter(|e| e.name() == name)
                .map(UiEvent::payload)
                .collect();
            if hits.len() > before {
                return hits.last().unwrap().clone();
            }
            let left = end.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "no {name} event within {secs}s");
            g = self.cv.wait_timeout(g, left).unwrap().0;
        }
    }
}

/// `claude agents --json` as a list the test controls. `fail` makes the call error.
#[derive(Default)]
struct Agents {
    entries: Mutex<Vec<AgentEntry>>,
    fail: Mutex<bool>,
    calls: Mutex<usize>,
}

impl AgentsSource for Agents {
    fn list(&self) -> io::Result<Vec<AgentEntry>> {
        *self.calls.lock().unwrap() += 1;
        if *self.fail.lock().unwrap() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "claude agents timed out",
            ));
        }
        Ok(self.entries.lock().unwrap().clone())
    }
}

impl Agents {
    /// A session of this test process, so the pid is alive.
    fn run(&self, sid: &str, status: &str) {
        self.entries.lock().unwrap().push(AgentEntry {
            pid: std::process::id(),
            cwd: String::new(),
            kind: "interactive".into(),
            session_id: Some(sid.into()),
            name: None,
            status: status.into(),
            waiting_for: None,
        });
    }

    fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }
}

struct Env {
    _data: tempfile::TempDir,
    config: PathBuf,
    stub_dir: tempfile::TempDir,
    home: PathBuf,
    _root: tempfile::TempDir,
    sink: Arc<Sink>,
    agents: Arc<Agents>,
    m: SessionManager,
}

/// The stub appends a line to `starts.txt` on every start, then runs `body`.
fn claude_stub(dir: &Path, body: &str) -> PathBuf {
    let p = dir.join("claude-stub");
    std::fs::write(
        &p,
        format!(
            "#!/bin/sh\necho started >> '{d}/starts.txt'\n{body}\n",
            d = dir.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    p
}

fn env(stub_body: &str) -> Env {
    let data = tempfile::Builder::new()
        .prefix("pr")
        .tempdir_in("/tmp")
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(root.path()).unwrap();
    let config = base.join("claude");
    std::fs::create_dir_all(config.join("projects")).unwrap();
    let home = base.join("work").join("proj");
    std::fs::create_dir_all(&home).unwrap();
    let stub_dir = tempfile::tempdir().unwrap();
    let stub = claude_stub(stub_dir.path(), stub_body);
    let hook = base.join("patchroom-hook");
    std::fs::write(&hook, "").unwrap();
    let sink = Arc::new(Sink::default());
    let agents = Arc::new(Agents::default());
    let mut cfg = ManagerConfig::new(data.path(), hook);
    cfg.claude_program = stub.to_string_lossy().into_owned();
    cfg.shell = Some("/bin/sh".into());
    cfg.kill_grace = Duration::from_millis(300);
    cfg.claude_config_dir = Some(config.clone());
    cfg.mirror_poll = Duration::from_millis(100);
    let m = Manager::new(cfg, Arc::clone(&sink) as Arc<dyn EventSink>).unwrap();
    m.set_agents_override(Some(Arc::clone(&agents) as Arc<dyn AgentsSource>));
    Env {
        _data: data,
        config,
        stub_dir,
        home,
        _root: root,
        sink,
        agents,
        m,
    }
}

impl Env {
    fn transcript(&self, sid: &str) {
        let enc: String = self
            .home
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let dir = self.config.join("projects").join(enc);
        std::fs::create_dir_all(&dir).unwrap();
        let line = json!({"type":"user","isSidechain":false,"cwd":self.home,"gitBranch":"main",
            "entrypoint":"cli","timestamp":"2026-03-01T10:00:00Z","origin":{"kind":"human"},
            "message":{"role":"user","content":"hello from the other terminal"}});
        std::fs::write(dir.join(format!("{sid}.jsonl")), format!("{line}\n")).unwrap();
    }

    fn section(&self) -> String {
        self.m
            .section_create_from_folder(self.home.to_str().unwrap(), None)
            .unwrap()
    }

    fn starts(&self) -> usize {
        std::fs::read_to_string(self.stub_dir.path().join("starts.txt"))
            .map_or(0, |t| t.lines().count())
    }

    fn wait_starts(&self, n: usize) {
        let end = Instant::now() + Duration::from_secs(10);
        while self.starts() < n {
            assert!(Instant::now() < end, "stub never started {n} time(s)");
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    fn info(&self, id: &str) -> patchroom_lib::manager::SessionInfo {
        self.m
            .list()
            .unwrap()
            .into_iter()
            .find(|s| s.id == id)
            .unwrap()
    }
}

fn wait_until(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(secs);
    while !f() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(40));
    }
}

#[test]
fn opening_a_session_that_runs_elsewhere_mirrors_it_and_never_spawns() {
    let e = env("sleep 60");
    e.transcript(SID);
    let sec = e.section();
    e.agents.run(SID, "idle");

    let dm = e.m.folder_session_open(&sec, SID).unwrap();
    let mirror = dm.mirror.clone().expect("a mirror, not a process");
    assert_eq!(mirror.pid, std::process::id());
    assert!(!mirror.takeover_when_closed);
    assert!(!mirror.place.is_empty());
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(e.starts(), 0, "claude was started");
    assert!(e.m.pid_of(&dm.id).is_none(), "the DM owns a process");
    assert_eq!(e.sink.count("session:mirror"), 1);

    // The composer is read only, the terminal takes no input, take-over refuses.
    assert!(matches!(
        e.m.send_text(&dm.id, "hi".into()).unwrap(),
        SendOutcome::MirrorReadonly { pid, .. } if pid == std::process::id()
    ));
    assert!(e.m.write(&dm.id, b"x".to_vec()).is_err());
    let err = e.m.takeover(&dm.id, None, None).unwrap_err().to_string();
    assert!(err.contains("still running in"), "{err}");
    assert!(e.m.resize(&dm.id, 100, 30).is_ok());
    assert_eq!(e.starts(), 0);

    // Opening it again, and a plain resume, re-check and still spawn nothing.
    e.m.folder_session_open(&sec, SID).unwrap();
    e.m.resume(&dm.id, None, None).unwrap();
    assert_eq!(e.starts(), 0);

    // The listing marks the row live and linked to the mirror DM.
    wait_until("the row to be live", 5, || {
        let l = e.m.folder_sessions(&sec).unwrap();
        l.sessions
            .iter()
            .any(|s| s.session_id == SID && s.live_elsewhere && s.dm_id.is_some())
    });

    // Killing a mirror only stops mirroring.
    e.m.kill(&dm.id).unwrap();
    assert!(e.info(&dm.id).mirror.is_none());
    assert_eq!(
        e.sink.payload_of_last("session:mirror")["mirror"],
        Value::Null
    );
    e.m.shutdown();
}

impl Sink {
    fn payload_of_last(&self, name: &str) -> Value {
        self.events
            .lock()
            .unwrap()
            .iter()
            .rfind(|e| e.name() == name)
            .map(UiEvent::payload)
            .unwrap()
    }
}

#[test]
fn the_mirror_takes_over_when_the_other_process_exits() {
    let e = env("sleep 60");
    e.transcript(SID);
    let sec = e.section();
    e.agents.run(SID, "busy");
    let dm = e.m.folder_session_open(&sec, SID).unwrap();
    assert!(dm.mirror.is_some());
    e.m.set_mirror_takeover(&dm.id, true).unwrap();
    assert!(e.info(&dm.id).mirror.unwrap().takeover_when_closed);

    // Still running: no take-over however long we wait.
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(e.starts(), 0);

    // The other process exits: this DM resumes the session, once.
    e.agents.clear();
    e.wait_starts(1);
    wait_until("the DM to own a process", 5, || {
        e.m.pid_of(&dm.id).is_some()
    });
    let now = e.info(&dm.id);
    assert!(now.mirror.is_none());
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(e.starts(), 1, "resumed more than once");
    e.m.shutdown();
}

#[test]
fn a_mirror_without_takeover_just_ends_when_the_other_process_exits() {
    let e = env("sleep 60");
    e.transcript(SID);
    let sec = e.section();
    e.agents.run(SID, "idle");
    let dm = e.m.folder_session_open(&sec, SID).unwrap();
    e.agents.clear();
    wait_until("the mirror to end", 5, || e.info(&dm.id).mirror.is_none());
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(e.starts(), 0, "nothing starts by itself");
    // A manual take-over now works, because nothing else runs it.
    let info = e.m.takeover(&dm.id, None, None).unwrap();
    assert!(info.mirror.is_none());
    e.wait_starts(1);
    e.m.shutdown();
}

#[test]
fn every_resume_rechecks_before_spawning() {
    let e = env("sleep 60");
    e.transcript(SID);
    let sec = e.section();
    // Free at first: the open spawns.
    let dm = e.m.folder_session_open(&sec, SID).unwrap();
    assert!(dm.mirror.is_none());
    e.wait_starts(1);
    let calls = *e.agents.calls.lock().unwrap();
    assert!(calls >= 1, "the open did not check claude agents");
    e.m.kill(&dm.id).unwrap();
    wait_until("exit", 5, || e.m.child_exited(&dm.id));

    // A terminal picks the session up meanwhile. The restore (session_resume) must notice.
    e.agents.run(SID, "idle");
    e.m.resume(&dm.id, None, None).unwrap();
    assert!(e.info(&dm.id).mirror.is_some());
    assert!(*e.agents.calls.lock().unwrap() > calls);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(e.starts(), 1, "resume spawned a second process");
    e.m.shutdown();
}

#[test]
fn a_recheck_that_cannot_finish_refuses_to_spawn() {
    let e = env("sleep 60");
    e.transcript(SID);
    let sec = e.section();
    *e.agents.fail.lock().unwrap() = true;
    let err = e.m.folder_session_open(&sec, SID).unwrap_err().to_string();
    assert!(err.contains("could not check"), "{err}");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(e.starts(), 0);
    assert!(
        e.m.list().unwrap().is_empty(),
        "a failed open left a DM row"
    );
    // The listing never calls it free while it cannot check.
    let l = e.m.folder_sessions(&sec).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let l2 = e.m.folder_sessions(&sec).unwrap();
    let states = |l: &patchroom_folders::Listing| {
        l.sessions
            .iter()
            .map(|s| serde_json::to_value(s.live_state).unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(states(&l), [json!("checking")]);
    assert_eq!(states(&l2), [json!("checking")]);

    // Once the CLI answers, the same open works and the row turns free.
    *e.agents.fail.lock().unwrap() = false;
    wait_until("the row to be free", 8, || {
        let l = e.m.folder_sessions(&sec).unwrap();
        states(&l) == [json!("free")]
    });
    e.m.folder_session_open(&sec, SID).unwrap();
    e.wait_starts(1);
    e.m.shutdown();
}

/// A dialog footer on screen, then (after 3 s) the idle composer.
const DIALOG_STUB: &str = "printf 'Settings\\r\\n\\r\\n\\342\\235\\257 1. Haiku\\r\\n  2. Sonnet\\r\\n\\r\\nEnter to confirm - Esc to cancel\\r\\n'\nsleep 3\nprintf '\\033[2J\\033[H> \\r\\n  ? for shortcuts\\r\\n'\nsleep 60";

fn dm_in(e: &Env) -> String {
    e.m.create(&CreateRequest {
        cwd: e.home.to_string_lossy().into_owned(),
        ..CreateRequest::default()
    })
    .unwrap()
}

#[test]
fn a_terminal_only_dialog_is_signalled_blocks_the_composer_and_clears() {
    let e = env(DIALOG_STUB);
    let id = dm_in(&e);
    let started = Instant::now();

    let p = e.sink.wait_for("session:terminal_wait", 0, 3);
    assert_eq!(p["id"], id.as_str());
    assert!(
        started.elapsed() < Duration::from_millis(2500),
        "signalled after {:?}",
        started.elapsed()
    );
    assert_eq!(p["reason"], "dialog open");
    assert!(p["since"].as_i64().unwrap() > 1_700_000_000_000);

    // Presence and activity follow.
    let info = e.info(&id);
    assert_eq!(info.terminal_wait.as_ref().unwrap().reason, "dialog open");
    assert!(info.needs_you, "needs-you was not raised");
    let rows = e.m.activity_list().unwrap();
    let row = rows.iter().find(|r| r.id == id).expect("an activity row");
    assert!(
        row.summary
            .contains("Claude is showing something in the terminal"),
        "{}",
        row.summary
    );

    // The composer's text is refused, not written.
    let out = e.m.send_text(&id, "typed into the void".into()).unwrap();
    assert_eq!(
        out,
        SendOutcome::BlockedDialog {
            reason: "dialog open".into()
        }
    );
    assert_eq!(
        serde_json::to_value(&out).unwrap(),
        json!({"outcome":"blocked_dialog","reason":"dialog open"})
    );

    // The dialog goes away (the stub repaints): the wait clears and sends work again.
    let c = e.sink.wait_for("session:terminal_wait_clear", 0, 8);
    assert_eq!(c["id"], id.as_str());
    wait_until("needs-you to drop", 3, || !e.info(&id).needs_you);
    assert!(e.info(&id).terminal_wait.is_none());
    assert_eq!(
        e.m.send_text(&id, "hello".into()).unwrap(),
        SendOutcome::Sent
    );
    e.m.shutdown();
}

#[test]
fn a_send_checks_the_screen_itself_so_a_fresh_dialog_still_blocks() {
    // The dialog is drawn, then the test sends at once: before the debounce could raise.
    let e = env(&DIALOG_STUB.replace("sleep 3", "sleep 20"));
    let id = dm_in(&e);
    wait_until("the dialog to draw", 5, || {
        e.m.send_text(&id, "x".into())
            .is_ok_and(|o| matches!(o, SendOutcome::BlockedDialog { .. }))
    });
    e.m.shutdown();
}

#[test]
fn sends_report_sent_or_queued() {
    let e = env("sleep 60");
    let id = dm_in(&e);
    assert_eq!(e.m.send_text(&id, "one".into()).unwrap(), SendOutcome::Sent);
    // A UserPromptSubmit hook makes the DM busy, as claude does when a turn starts.
    let mut s =
        std::os::unix::net::UnixStream::connect(e._data.path().join("bridge.sock")).unwrap();
    let line = json!({"v":1,"type":"hook","session_key":id,"hook_pid":1,"ppid":0,"wait_ms":1000,
        "payload":{"hook_event_name":"UserPromptSubmit","session_id":"00000000-0000-4000-8000-0000000000aa","cwd":"/tmp"}});
    s.write_all(format!("{line}\n").as_bytes()).unwrap();
    wait_until("busy", 5, || {
        e.info(&id).status == patchroom_lib::events::PresenceStatus::Busy
    });
    assert_eq!(
        e.m.send_text(&id, "two".into()).unwrap(),
        SendOutcome::Queued
    );
    // No terminal-wait signal for plain output.
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(e.sink.count("session:terminal_wait"), 0);
    assert!(e
        .m
        .send_text("01JNOSUCHSESSION00000000000", "x".into())
        .is_err());
    e.m.shutdown();
}

#[test]
fn the_wait_ends_when_the_process_exits() {
    let e = env(&DIALOG_STUB.replace("sleep 3", "sleep 30"));
    let id = dm_in(&e);
    e.sink.wait_for("session:terminal_wait", 0, 3);
    e.m.kill(&id).unwrap();
    e.sink.wait_for("session:terminal_wait_clear", 0, 5);
    assert!(e.info(&id).terminal_wait.is_none());
    e.m.shutdown();
}

/// Live: the real `claude agents --json` through the login shell answers within the 3 s bound
/// and a session nobody runs is spawned (the stub). Read only on the real CLI; run with
/// `cargo test -p patchroom --test session_parity -- --ignored`.
#[test]
#[ignore = "runs the real `claude agents --json` (read only)"]
fn live_the_real_recheck_is_bounded_and_lets_a_free_session_start() {
    let data = tempfile::Builder::new()
        .prefix("pr")
        .tempdir_in("/tmp")
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(root.path()).unwrap();
    let config = base.join("claude");
    std::fs::create_dir_all(config.join("projects")).unwrap();
    let home = base.join("proj");
    std::fs::create_dir_all(&home).unwrap();
    let stub_dir = tempfile::tempdir().unwrap();
    let stub = claude_stub(stub_dir.path(), "sleep 30");
    let hook = base.join("patchroom-hook");
    std::fs::write(&hook, "").unwrap();
    let mut cfg = ManagerConfig::new(data.path(), hook);
    cfg.claude_program = stub.to_string_lossy().into_owned();
    cfg.reconcile = true;
    cfg.kill_grace = Duration::from_millis(300);
    cfg.claude_config_dir = Some(config.clone());
    let sink = Arc::new(Sink::default());
    let m = Manager::new(cfg, sink as Arc<dyn EventSink>).unwrap();
    let enc: String = home
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir = config.join("projects").join(enc);
    std::fs::create_dir_all(&dir).unwrap();
    let line = json!({"type":"user","isSidechain":false,"cwd":home,"entrypoint":"cli",
        "timestamp":"2026-03-01T10:00:00Z","message":{"role":"user","content":"hi"}});
    std::fs::write(dir.join(format!("{SID}.jsonl")), format!("{line}\n")).unwrap();
    let sec = m
        .section_create_from_folder(home.to_str().unwrap(), None)
        .unwrap();
    let t0 = Instant::now();
    let dm = m.folder_session_open(&sec, SID).unwrap();
    let took = t0.elapsed();
    println!("LIVE recheck+open took {took:?}");
    assert!(took < Duration::from_secs(5), "took {took:?}");
    assert!(dm.mirror.is_none());
    assert!(m.pid_of(&dm.id).is_some());
    m.shutdown();
}
