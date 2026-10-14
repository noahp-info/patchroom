//! Backend integration tests: real PTYs, a real bridge, a real SQLite file.
//! Nothing here touches `~/.claude` or the user's data dir.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command as Proc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use patchroom_lib::events::{EventSink, PresenceStatus, UiEvent};
use patchroom_lib::manager::{CreateRequest, Manager, ManagerConfig, SessionManager};

/// Collects events; optionally sleeps on each output event (slow consumer).
struct Sink {
    events: Mutex<Vec<UiEvent>>,
    cv: Condvar,
    output_delay: Duration,
}

impl Sink {
    fn new(output_delay: Duration) -> Arc<Self> {
        Arc::new(Sink {
            events: Mutex::new(Vec::new()),
            cv: Condvar::new(),
            output_delay,
        })
    }

    fn has_exit(&self) -> bool {
        self.events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, UiEvent::Exit { .. }))
    }

    /// Block until a `pty:exit` arrives; return its code.
    fn wait_exit(&self, timeout: Duration) -> i64 {
        let end = Instant::now() + timeout;
        let mut g = self.events.lock().unwrap();
        loop {
            if let Some(code) = g.iter().find_map(|e| match e {
                UiEvent::Exit { code, .. } => Some(*code),
                _ => None,
            }) {
                return code;
            }
            let left = end.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "no pty:exit within {timeout:?}");
            g = self.cv.wait_timeout(g, left).unwrap().0;
        }
    }

    /// All output bytes in arrival order, plus the index of the exit event.
    fn output(&self) -> Vec<u8> {
        let g = self.events.lock().unwrap();
        let mut out = Vec::new();
        for e in g.iter() {
            if let UiEvent::Output { data, .. } = e {
                out.extend(B64.decode(data).unwrap());
            }
        }
        out
    }

    fn exit_is_last_output_event(&self) -> bool {
        let g = self.events.lock().unwrap();
        let exit = g.iter().position(|e| matches!(e, UiEvent::Exit { .. }));
        let last_out = g.iter().rposition(|e| matches!(e, UiEvent::Output { .. }));
        matches!((exit, last_out), (Some(x), Some(o)) if o < x)
    }
}

impl EventSink for Sink {
    fn emit(&self, event: UiEvent) {
        if matches!(event, UiEvent::Output { .. }) && !self.output_delay.is_zero() {
            std::thread::sleep(self.output_delay);
        }
        self.events.lock().unwrap().push(event);
        self.cv.notify_all();
    }
}

/// The sidecar that `build.rs` stages, copied to a temp dir under its
/// runtime name `patchroom-hook` (so `pgrep -x patchroom-hook` finds it, as
/// it would in the app bundle).
fn hook_bin() -> PathBuf {
    static COPY: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    COPY.get_or_init(|| {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let staged = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
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

fn manager(dir: &Path, sink: Arc<Sink>) -> SessionManager {
    let mut cfg = ManagerConfig::new(dir, hook_bin());
    cfg.shell = Some("/bin/sh".into());
    cfg.kill_grace = Duration::from_millis(500);
    Manager::new(cfg, sink).unwrap()
}

fn sh_dm(m: &SessionManager, script: &str) -> String {
    m.create(&CreateRequest {
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        command: Some("sh".into()),
        args: Some(vec!["-c".into(), script.into()]),
        ..CreateRequest::default()
    })
    .unwrap()
}

fn expected_burst(n: u32) -> Vec<u8> {
    let mut v = Vec::new();
    for i in 1..=n {
        v.extend_from_slice(format!("{i} ").as_bytes());
    }
    v
}

/// Short data dir: the unix socket path limit is about 100 bytes.
fn data_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("pr")
        .tempdir_in("/tmp")
        .unwrap()
}

fn pgrep(args: &[&str]) -> Vec<String> {
    let out = Proc::new("pgrep").args(args).output().unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_owned)
        .collect()
}

fn wait_for(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + timeout;
    while !f() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn burst_of_5mb_arrives_complete_and_in_order() {
    let dir = data_dir();
    let sink = Sink::new(Duration::ZERO);
    let m = manager(dir.path(), sink.clone());
    // Raw mode so the tty does not rewrite bytes. 800000 numbers is ~5.3 MB.
    sh_dm(&m, "stty raw -echo; seq 1 800000 | tr '\\n' ' '");
    let code = sink.wait_exit(Duration::from_secs(60));
    assert_eq!(code, 0);
    let got = sink.output();
    let want = expected_burst(800_000);
    assert!(
        want.len() > 5 * 1024 * 1024,
        "burst is {} bytes",
        want.len()
    );
    assert_eq!(got.len(), want.len(), "byte count");
    assert!(got == want, "bytes differ or are reordered");
    assert!(
        sink.exit_is_last_output_event(),
        "exit must follow all output"
    );
    m.shutdown();
}

#[test]
fn slow_consumer_never_blocks_the_pty_drain() {
    let dir = data_dir();
    // 100 ms per output event: forwarding the burst takes seconds.
    let sink = Sink::new(Duration::from_millis(100));
    let m = manager(dir.path(), sink.clone());
    let id = sh_dm(&m, "stty raw -echo; seq 1 300000 | tr '\\n' ' '");
    wait_for("child exit", Duration::from_secs(20), || {
        m.child_exited(&id)
    });
    assert!(
        !sink.has_exit(),
        "the child finished while the UI was still catching up"
    );
    assert_eq!(sink.wait_exit(Duration::from_secs(60)), 0);
    assert!(sink.output() == expected_burst(300_000));
    m.shutdown();
}

#[test]
fn quit_leaves_no_child_or_hook_processes() {
    let dir = data_dir();
    let sink = Sink::new(Duration::ZERO);
    let m = manager(dir.path(), sink.clone());
    // The bridge holds permission hooks open only while a chat client is attached.
    m.bridge().set_chat_attached(true);
    let sock = m.bridge().socket_path().to_string_lossy().into_owned();
    let hook = hook_bin().to_string_lossy().into_owned();
    let payload = r#"{"hook_event_name":"PermissionRequest","session_id":"s1","tool_name":"Bash","tool_input":{"command":"echo hi"}}"#;
    let script = format!(
        "sleep 41357 & sleep 41358 & printf '%s' '{payload}' | '{hook}' --socket '{sock}' --wait-ms 60000 --session-key k1 & wait"
    );
    sh_dm(&m, &script);
    wait_for("sleepers and a held hook", Duration::from_secs(15), || {
        !pgrep(&["-f", "sleep 41357"]).is_empty()
            && !pgrep(&["-x", "patchroom-hook"]).is_empty()
            && !m.bridge().pending().is_empty()
    });

    m.shutdown();

    wait_for("all processes gone", Duration::from_secs(10), || {
        pgrep(&["-f", "sleep 4135[78]"]).is_empty() && pgrep(&["-x", "patchroom-hook"]).is_empty()
    });
    assert!(
        !Path::new(&sock).exists(),
        "bridge socket is removed on quit"
    );
}

fn stub_claude(dir: &Path) -> PathBuf {
    let p = dir.join("claude-stub");
    std::fs::write(
        &p,
        "#!/bin/sh\nfor a in \"$@\"; do printf 'ARG[%s]\\n' \"$a\"; done\n",
    )
    .unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

#[test]
fn dms_persist_and_resume_with_claude_resume() {
    let dir = data_dir();
    let stub_dir = tempfile::tempdir().unwrap();
    let cwd = tempfile::tempdir().unwrap();
    let cwd_s = cwd.path().to_string_lossy().into_owned();
    let mk = |sink: Arc<Sink>| {
        let mut cfg = ManagerConfig::new(dir.path(), hook_bin());
        cfg.shell = Some("/bin/sh".into());
        cfg.claude_program = stub_claude(stub_dir.path()).to_string_lossy().into_owned();
        Manager::new(cfg, sink).unwrap()
    };

    // Run 1: create a claude DM (stub) and a section.
    let sink1 = Sink::new(Duration::ZERO);
    let m1 = mk(sink1.clone());
    let id = m1
        .create(&CreateRequest {
            cwd: cwd_s.clone(),
            args: Some(vec!["--model".into(), "haiku".into()]),
            name: Some("alpha".into()),
            ..CreateRequest::default()
        })
        .unwrap();
    sink1.wait_exit(Duration::from_secs(20));
    let text = String::from_utf8_lossy(&sink1.output()).into_owned();
    assert!(text.contains("ARG[--session-id]"), "{text}");
    assert!(
        text.contains("ARG[--model]") && text.contains("ARG[haiku]"),
        "{text}"
    );
    assert!(text.contains("ARG[--settings]"), "{text}");
    assert!(
        text.contains(
            &dir.path()
                .join("bridge.sock")
                .to_string_lossy()
                .into_owned()
        ),
        "settings point the hook at the app-data bridge socket: {text}"
    );
    assert!(
        !text.contains("--setting-sources"),
        "user settings stay in force"
    );
    let listed = m1.list().unwrap();
    assert_eq!(listed.len(), 1);
    let sid = listed[0]
        .claude_session_id
        .clone()
        .expect("session id stored");
    assert!(text.contains(&format!("ARG[{sid}]")));
    let section = m1.create_section("Work").unwrap();
    m1.set_section(&id, Some(&section)).unwrap();
    m1.shutdown();

    // Run 2: a fresh manager over the same data dir.
    let sink2 = Sink::new(Duration::ZERO);
    let m2 = mk(sink2.clone());
    let listed = m2.list().unwrap();
    assert_eq!(listed.len(), 1, "DM list survives a restart");
    assert_eq!(listed[0].id, id);
    assert_eq!(listed[0].name, "alpha");
    assert_eq!(listed[0].cwd, cwd_s);
    assert_eq!(listed[0].status, PresenceStatus::Exited);
    assert_eq!(listed[0].claude_session_id.as_deref(), Some(sid.as_str()));
    assert_eq!(listed[0].section_id.as_deref(), Some(section.as_str()));
    let names: Vec<_> = m2.sections().unwrap().into_iter().map(|s| s.name).collect();
    assert!(
        names.contains(&"Work".to_owned()),
        "sections persist: {names:?}"
    );

    m2.resume(&id, None, None).unwrap();
    sink2.wait_exit(Duration::from_secs(20));
    let text = String::from_utf8_lossy(&sink2.output()).into_owned();
    assert!(text.contains("ARG[--resume]"), "{text}");
    assert!(text.contains(&format!("ARG[{sid}]")), "{text}");
    assert!(
        text.contains("ARG[haiku]"),
        "original args are kept on resume: {text}"
    );
    m2.shutdown();
}

#[test]
fn write_resize_and_kill_roundtrip() {
    let dir = data_dir();
    let sink = Sink::new(Duration::ZERO);
    let m = manager(dir.path(), sink.clone());
    let id = sh_dm(&m, "stty raw -echo; cat");
    std::thread::sleep(Duration::from_millis(400));
    m.write(&id, b"hello".to_vec()).unwrap();
    wait_for("echo", Duration::from_secs(10), || {
        sink.output().ends_with(b"hello")
    });
    m.resize(&id, 100, 30).unwrap();
    m.kill(&id).unwrap();
    sink.wait_exit(Duration::from_secs(10));
    assert!(
        m.write(&id, b"x".to_vec()).is_err(),
        "writes fail after exit"
    );
    assert!(m.write("nope", b"x".to_vec()).is_err());
    m.shutdown();
}

#[test]
fn bad_cwd_is_rejected_and_leaves_no_row() {
    let dir = data_dir();
    let m = manager(dir.path(), Sink::new(Duration::ZERO));
    let err = m
        .create(&CreateRequest {
            cwd: "/definitely/not/here".into(),
            ..CreateRequest::default()
        })
        .unwrap_err();
    assert!(err.to_string().contains("does not exist"));
    assert!(m.list().unwrap().is_empty());
    m.shutdown();
}
