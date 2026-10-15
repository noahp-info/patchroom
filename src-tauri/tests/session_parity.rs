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
use patchroom_lib::manager::{
    CreateRequest, Manager, ManagerConfig, SendOutcome, SessionManager, TerminalOps,
};
use serde_json::{json, Value};

const SID: &str = "aaaaaaaa-0000-4000-8000-000000000001";

#[derive(Default)]
struct Sink {
    events: Mutex<Vec<(Instant, UiEvent)>>,
    cv: Condvar,
}

impl EventSink for Sink {
    fn emit(&self, event: UiEvent) {
        self.events.lock().unwrap().push((Instant::now(), event));
        self.cv.notify_all();
    }
}

impl Sink {
    fn count(&self, name: &str) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, e)| e.name() == name)
            .count()
    }

    /// When the first event of this DM that `name`s and satisfies `pred` reached the sink.
    fn first_at(&self, name: &str, pred: impl Fn(&Value) -> bool) -> Option<Instant> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .find(|(_, e)| e.name() == name && pred(&e.payload()))
            .map(|(t, _)| *t)
    }

    /// Everything the PTY of `id` has printed so far (the `pty:output` stream), decoded.
    fn pty_text(&self, id: &str) -> String {
        use base64::Engine as _;
        let bytes: Vec<u8> = self
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, e)| e.name() == "pty:output")
            .map(|(_, e)| e.payload())
            .filter(|p| p["id"] == id)
            .flat_map(|p| {
                base64::engine::general_purpose::STANDARD
                    .decode(p["data"].as_str().unwrap())
                    .unwrap()
            })
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// Wait until more than `before` events called `name` arrived; return the newest payload.
    fn wait_for(&self, name: &str, before: usize, secs: u64) -> Value {
        let end = Instant::now() + Duration::from_secs(secs);
        let mut g = self.events.lock().unwrap();
        loop {
            let hits: Vec<Value> = g
                .iter()
                .filter(|(_, e)| e.name() == name)
                .map(|(_, e)| e.payload())
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
            .rfind(|(_, e)| e.name() == name)
            .map(|(_, e)| e.payload())
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
    assert!(err.starts_with("check_failed:"), "not typed: {err}");
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

#[test]
fn open_anyway_skips_the_failed_check_and_spawns() {
    let e = env("sleep 60");
    e.transcript(SID);
    let sec = e.section();
    *e.agents.fail.lock().unwrap() = true;
    let err = e.m.folder_session_open(&sec, SID).unwrap_err().to_string();
    assert!(err.starts_with("check_failed:"), "{err}");
    assert_eq!(e.starts(), 0);
    // The check still fails; the user confirmed: the same open, without the check.
    let dm = e.m.folder_session_open_with(&sec, SID, true).unwrap();
    e.wait_starts(1);
    assert!(dm.mirror.is_none());
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

    let p = e.sink.wait_for("session:terminal_wait", 0, 3);
    assert_eq!(p["id"], id.as_str());
    // Measure from the dialog appearing in the PTY output, not from the DM's creation (the
    // spawn and the stub's start-up are not the signal's latency).
    let shown_at = e
        .sink
        .first_at("pty:output", |p| {
            p["id"] == id.as_str()
                && p["data"].as_str().is_some_and(|d| {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD
                        .decode(d)
                        .is_ok_and(|b| String::from_utf8_lossy(&b).contains("Esc to cancel"))
                })
        })
        .expect("the dialog footer never reached the PTY output");
    let signalled_at = e
        .sink
        .first_at("session:terminal_wait", |p| p["id"] == id.as_str())
        .unwrap();
    let latency = signalled_at.saturating_duration_since(shown_at);
    println!("terminal_wait latency from the dialog drawing: {latency:?}");
    assert!(
        signalled_at >= shown_at,
        "the wait was signalled before the dialog was on screen"
    );
    assert!(
        latency < Duration::from_secs(2),
        "terminal_wait came {latency:?} after the dialog drew"
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

    // Nothing reached the PTY: not in the output stream, not on the emulated screen. The tty
    // echoes whatever is written to it, so a write would show up in both. The control token
    // proves the check can see a write.
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        !e.sink.pty_text(&id).contains("typed into the void"),
        "the refused text was echoed by the PTY"
    );
    assert!(
        !e.m.screen_text(&id)
            .unwrap()
            .contains("typed into the void"),
        "the refused text is on the terminal screen"
    );
    e.m.write(&id, b"CONTROL-TOKEN".to_vec()).unwrap();
    wait_until("the control write to echo", 2, || {
        e.sink.pty_text(&id).contains("CONTROL-TOKEN")
            && e.m.screen_text(&id).unwrap().contains("CONTROL-TOKEN")
    });

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

/// Open a chat permission prompt for DM `key` through the bridge socket, as `patchroom-hook`
/// would. The returned stream stays open: the reply comes only when the prompt resolves.
fn open_permission_prompt(sock: &Path, key: &str) -> std::os::unix::net::UnixStream {
    let mut s = std::os::unix::net::UnixStream::connect(sock).unwrap();
    let line = json!({"v":1,"type":"hook","session_key":key,"hook_pid":1,"ppid":0,"wait_ms":30000,
        "payload":{"hook_event_name":"PermissionRequest",
            "session_id":"00000000-0000-4000-8000-0000000000bb","tool_name":"Bash",
            "tool_input":{"command":"echo held"},"cwd":"/tmp","permission_suggestions":[]}});
    s.write_all(format!("{line}\n").as_bytes()).unwrap();
    s.flush().unwrap();
    s
}

fn send_plain_hook(sock: &Path, key: &str, event: &str) {
    let mut s = std::os::unix::net::UnixStream::connect(sock).unwrap();
    let line = json!({"v":1,"type":"hook","session_key":key,"hook_pid":1,"ppid":0,"wait_ms":0,
        "payload":{"hook_event_name":event,"session_id":"00000000-0000-4000-8000-0000000000bb",
            "tool_name":"Bash","tool_input":{"command":"echo held"},"cwd":"/tmp"}});
    s.write_all(format!("{line}\n").as_bytes()).unwrap();
    s.flush().unwrap();
    read_hook_reply(&s, 5);
}

/// One reply line from the bridge, or `None` if the stream closed or `secs` passed.
fn read_hook_reply(s: &std::os::unix::net::UnixStream, secs: u64) -> Option<String> {
    use std::io::BufRead as _;
    // macOS rejects a read timeout (EINVAL) once the peer has closed; a closed socket
    // cannot block, so the read below still returns at once.
    let _ = s.set_read_timeout(Some(Duration::from_secs(secs)));
    let mut line = String::new();
    match io::BufReader::new(s).read_line(&mut line) {
        Ok(n) if n > 0 => Some(line),
        _ => None,
    }
}

/// The newest `session:badges` needs-you flag the sink saw for `id`.
fn last_badge_needs_you(sink: &Sink, id: &str) -> Option<bool> {
    sink.events
        .lock()
        .unwrap()
        .iter()
        .rev()
        .filter(|(_, e)| e.name() == "session:badges")
        .map(|(_, e)| e.payload())
        .find(|p| p["id"] == id)
        .map(|p| p["needsYou"].as_bool().unwrap())
}

/// Real Manager, real PTY, real bridge: a terminal wait cleared while a chat
/// prompt is open must leave needs-you true (in the store, which `list` reads, and in the
/// emitted badge) until the prompt resolves. Every step waits on an event or polls to a
/// deadline; the stub is gated by files, never by sleeps.
#[test]
fn a_terminal_wait_clear_keeps_needs_you_while_a_chat_prompt_is_open() {
    let gate = tempfile::tempdir().unwrap();
    let g = gate.path().display();
    let stub = format!(
        "while [ ! -e '{g}/draw' ]; do sleep 0.05; done\n\
         printf 'Settings\\r\\n\\r\\n\\342\\235\\257 1. Haiku\\r\\n  2. Sonnet\\r\\n\\r\\nEnter to confirm - Esc to cancel\\r\\n'\n\
         while [ ! -e '{g}/release' ]; do sleep 0.05; done\n\
         printf '\\033[2J\\033[H> \\r\\n  ? for shortcuts\\r\\n'\nsleep 60"
    );
    let e = env(&stub);
    let id = dm_in(&e);
    let sock = e._data.path().join("bridge.sock");

    // 1. A terminal-only dialog draws: the wait rises and needs-you with it. The raise
    //    reconciles before it emits, so the event is the cue: no sleep, no threshold.
    std::fs::write(gate.path().join("draw"), "").unwrap();
    e.sink.wait_for("session:terminal_wait", 0, 15);
    assert!(e.info(&id).terminal_wait.is_some());
    assert!(
        e.info(&id).needs_you,
        "needs-you was not raised by the wait"
    );

    // 2. A chat prompt opens while the dialog is still on screen. The chat owns the ask, so
    //    the terminal wait ends (a clear) while the prompt stays open.
    let hook = open_permission_prompt(&sock, &id);
    let p = e.sink.wait_for("prompt:pending", 0, 10);
    assert_eq!(p["id"], id.as_str());
    e.sink.wait_for("session:terminal_wait_clear", 0, 15);

    // 3. The clear reconciles before it emits, so the first look after the event must
    //    already see needs-you true, in the store (`list` reads it) and in the badge.
    assert!(e.info(&id).terminal_wait.is_none());
    assert!(
        e.info(&id).needs_you,
        "the terminal-wait clear dropped needs-you while a chat prompt is open"
    );
    assert_ne!(
        last_badge_needs_you(&e.sink, &id),
        Some(false),
        "a needs-you=false badge was emitted by the clear"
    );
    // The dialog going away on screen must not clear it either.
    std::fs::write(gate.path().join("release"), "").unwrap();
    wait_until("the stub to repaint", 10, || {
        e.m.screen_text(&id).unwrap().contains("? for shortcuts")
    });
    // It holds over a window of polls (a late writer would show here), without a threshold:
    // the loop ends after a fixed number of looks, not a timing bound.
    for _ in 0..25 {
        assert!(e.info(&id).needs_you, "needs-you dropped after the clear");
        std::thread::sleep(Duration::from_millis(20));
    }

    // 4. The prompt resolves: only now does needs-you clear.
    let pid = p["promptId"].as_str().unwrap().to_owned();
    e.m.prompt_answer(&id, &pid, patchroom_lib::manager::PromptAnswer::Allow)
        .unwrap();
    e.sink.wait_for("prompt:resolved", 0, 10);
    // claude moves on once the tool is allowed; its hooks end the presence wait too.
    assert!(
        read_hook_reply(&hook, 10).is_some(),
        "the hook was not answered"
    );
    send_plain_hook(&sock, &id, "PostToolUse");
    send_plain_hook(&sock, &id, "Stop");
    wait_until("needs-you to clear after the prompt resolved", 10, || {
        !e.info(&id).needs_you && last_badge_needs_you(&e.sink, &id) == Some(false)
    });
    drop(hook);
    e.m.shutdown();
}

/// Real Manager and bridge: when a prompt puts the DM into Waiting, the persisted needs-you
/// flag (announced by `session:badges`) lands before `session:status` says Waiting, so a
/// listener that reacts to the status and reads the store already sees it. Order is read
/// from the sink's event sequence, never from timings.
#[test]
fn needs_you_is_persisted_before_the_waiting_status_goes_out() {
    let e = env("printf '> \\r\\n  ? for shortcuts\\r\\n'\nsleep 60");
    let id = dm_in(&e);
    let sock = e._data.path().join("bridge.sock");
    let hook = open_permission_prompt(&sock, &id);
    e.sink.wait_for("prompt:pending", 0, 10);
    wait_until("the DM to report Waiting", 10, || {
        e.sink
            .first_at("session:status", |p| {
                p["id"] == id.as_str() && p["status"] == "waiting"
            })
            .is_some()
    });
    let order: Vec<(String, Value)> = e
        .sink
        .events
        .lock()
        .unwrap()
        .iter()
        .map(|(_, ev)| (ev.name().to_owned(), ev.payload()))
        .filter(|(_, p)| p["id"] == id.as_str())
        .collect();
    let waiting = order
        .iter()
        .position(|(n, p)| n == "session:status" && p["status"] == "waiting")
        .expect("a Waiting status");
    let badge = order
        .iter()
        .position(|(n, p)| n == "session:badges" && p["needsYou"] == true)
        .expect("a needs-you badge");
    assert!(
        badge < waiting,
        "session:status Waiting (#{waiting}) went out before needs-you was persisted (#{badge})"
    );
    assert!(e.info(&id).needs_you);
    drop(hook);
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
    // Warm, the direct call (cached binary path) is well inside its 3 s attempt bound, also
    // while the machine is busy (run this next to a build to measure that).
    let checker = patchroom_lib::agents::LoginShellAgents::checker(Duration::from_secs(3));
    let mut worst = Duration::ZERO;
    for _ in 0..5 {
        let t = Instant::now();
        checker.list().unwrap();
        worst = worst.max(t.elapsed());
    }
    println!("LIVE warm direct check, worst of 5: {worst:?}");
    assert!(worst < Duration::from_millis(2500), "worst {worst:?}");
    assert!(dm.mirror.is_none());
    assert!(m.pid_of(&dm.id).is_some());
    m.shutdown();
}

// ---- the hand-off: "Show in iTerm" and "End it there" ----

/// Records what the hand-off asks of the OS. Never focuses or signals anything real.
#[derive(Default)]
struct FakeOps {
    agents: Mutex<Option<Arc<Agents>>>,
    command: Mutex<String>,
    reveals: Mutex<Vec<(u32, String)>>,
    terms: Mutex<Vec<u32>>,
    /// The other copy ignores SIGTERM.
    stubborn: Mutex<bool>,
}

impl TerminalOps for FakeOps {
    fn reveal(&self, pid: u32, place: &str) -> Result<(), String> {
        self.reveals.lock().unwrap().push((pid, place.to_owned()));
        Ok(())
    }
    fn command_of(&self, _pid: u32) -> Option<String> {
        Some(self.command.lock().unwrap().clone())
    }
    fn terminate(&self, pid: u32) -> Result<(), String> {
        self.terms.lock().unwrap().push(pid);
        if !*self.stubborn.lock().unwrap() {
            if let Some(a) = self.agents.lock().unwrap().as_ref() {
                a.clear();
            }
        }
        Ok(())
    }
    fn alive(&self, _pid: u32) -> bool {
        self.agents
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| !a.entries.lock().unwrap().is_empty())
    }
}

fn fake_ops(e: &Env) -> Arc<FakeOps> {
    let ops = Arc::new(FakeOps::default());
    *ops.agents.lock().unwrap() = Some(Arc::clone(&e.agents));
    *ops.command.lock().unwrap() = "/Users/x/.local/bin/claude --resume".into();
    e.m.set_terminal_ops_override(Some(Arc::clone(&ops) as Arc<dyn TerminalOps>));
    ops
}

#[test]
fn reveal_asks_for_the_other_terminal_and_signals_nothing() {
    let e = env("sleep 60");
    e.transcript(SID);
    let sec = e.section();
    e.agents.run(SID, "busy");
    let ops = fake_ops(&e);
    let dm = e.m.folder_session_open(&sec, SID).unwrap();
    let place = dm.mirror.clone().unwrap().place;
    e.m.mirror_reveal(&dm.id).unwrap();
    assert_eq!(
        *ops.reveals.lock().unwrap(),
        vec![(std::process::id(), place)]
    );
    assert!(ops.terms.lock().unwrap().is_empty());
    assert!(e.m.mirror_reveal("nope").is_err());
    e.m.shutdown();
}

#[test]
fn ending_the_other_copy_refuses_unless_it_is_idle_claude() {
    let e = env("sleep 60");
    e.transcript(SID);
    let sec = e.section();
    e.agents.run(SID, "busy");
    let ops = fake_ops(&e);
    let dm = e.m.folder_session_open(&sec, SID).unwrap();

    // Busy: refused, nothing signaled, nothing armed.
    let err = e.m.mirror_end(&dm.id, None, None).unwrap_err().to_string();
    assert!(err.contains("not idle"), "{err}");
    // Waiting on the user counts as not idle too.
    e.agents.clear();
    e.agents.run(SID, "waiting");
    assert!(e.m.mirror_end(&dm.id, None, None).is_err());
    // Idle, but the pid is no longer claude: refused.
    e.agents.clear();
    e.agents.run(SID, "idle");
    *ops.command.lock().unwrap() = "/usr/bin/vim notes.txt".into();
    let err = e.m.mirror_end(&dm.id, None, None).unwrap_err().to_string();
    assert!(err.contains("no longer claude"), "{err}");
    // The check fails: refused.
    *ops.command.lock().unwrap() = "claude".into();
    *e.agents.fail.lock().unwrap() = true;
    let err = e.m.mirror_end(&dm.id, None, None).unwrap_err().to_string();
    assert!(err.starts_with("check_failed"), "{err}");

    assert!(
        ops.terms.lock().unwrap().is_empty(),
        "something was signaled"
    );
    assert!(!e.info(&dm.id).mirror.unwrap().takeover_when_closed);
    assert_eq!(e.starts(), 0);
    e.m.shutdown();
}

#[test]
fn ending_an_idle_copy_signals_it_once_and_resumes_here() {
    let e = env("sleep 60");
    e.transcript(SID);
    let sec = e.section();
    e.agents.run(SID, "idle");
    let ops = fake_ops(&e);
    let dm = e.m.folder_session_open(&sec, SID).unwrap();

    let info = e.m.mirror_end(&dm.id, None, None).unwrap();
    assert!(info.mirror.is_none());
    assert_eq!(*ops.terms.lock().unwrap(), vec![std::process::id()]);
    e.wait_starts(1);
    assert!(e.m.pid_of(&dm.id).is_some());
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(e.starts(), 1, "resumed more than once");
    e.m.shutdown();
}

#[test]
fn a_copy_that_ignores_the_signal_stays_armed_and_is_never_killed() {
    let e = env("sleep 60");
    e.transcript(SID);
    let sec = e.section();
    e.agents.run(SID, "idle");
    let ops = fake_ops(&e);
    *ops.stubborn.lock().unwrap() = true;
    let dm = e.m.folder_session_open(&sec, SID).unwrap();

    let err = e.m.mirror_end(&dm.id, None, None).unwrap_err().to_string();
    assert!(err.contains("still runs"), "{err}");
    assert_eq!(
        ops.terms.lock().unwrap().len(),
        1,
        "signaled more than once"
    );
    assert!(e.info(&dm.id).mirror.unwrap().takeover_when_closed);
    assert_eq!(e.starts(), 0);

    // It closes later: the armed take-over resumes it here.
    e.agents.clear();
    e.wait_starts(1);
    e.m.shutdown();
}
