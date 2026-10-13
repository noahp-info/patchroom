//! Runs the real `patchroom-hook` binary against a real bridge on a real unix socket.

use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use patchroom_bridge::{
    Bridge, BridgeConfig, BridgeEvent, HookSettings, PermissionAnswer, QuestionAnswers,
};
use serde_json::{json, Value};

const HOOK: &str = env!("CARGO_BIN_EXE_patchroom-hook");
static N: AtomicU32 = AtomicU32::new(0);

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let d = std::env::temp_dir().join(format!(
            "prh-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&d).unwrap();
        Self(d)
    }
    fn sock(&self) -> PathBuf {
        self.0.join("b.sock")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Run {
    child: Child,
}
impl Drop for Run {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Run {
    fn spawn(sock: &Path, wait_ms: u64, payload: &str) -> Self {
        let mut child = Command::new(HOOK)
            .args([
                "--socket",
                &sock.to_string_lossy(),
                "--wait-ms",
                &wait_ms.to_string(),
            ])
            .args(["--session-key", "dm-1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(payload.as_bytes()).unwrap();
        drop(stdin);
        Self { child }
    }

    /// Wait for the process to exit on its own. Returns (stdout, stderr, elapsed).
    fn finish(mut self, within: Duration) -> (String, String, Duration) {
        let start = Instant::now();
        loop {
            if let Some(st) = self.child.try_wait().unwrap() {
                assert!(st.success(), "hook must always exit 0, got {st}");
                let (mut o, mut e) = (String::new(), String::new());
                self.child
                    .stdout
                    .take()
                    .unwrap()
                    .read_to_string(&mut o)
                    .unwrap();
                self.child
                    .stderr
                    .take()
                    .unwrap()
                    .read_to_string(&mut e)
                    .unwrap();
                return (o, e, start.elapsed());
            }
            assert!(
                start.elapsed() < within,
                "hook did not exit by itself within {within:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn perm(session: &str) -> String {
    json!({"hook_event_name":"PermissionRequest","session_id":session,"tool_name":"Bash",
           "tool_input":{"command":"echo hi"}})
    .to_string()
}

fn bridge(dir: &Dir) -> Bridge {
    let b = Bridge::start(BridgeConfig::new(dir.sock())).unwrap();
    b.set_chat_attached(true);
    b
}

fn wait_event<T>(
    rx: &std::sync::mpsc::Receiver<BridgeEvent>,
    mut f: impl FnMut(&BridgeEvent) -> Option<T>,
) -> T {
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let ev = rx
            .recv_timeout(end.saturating_duration_since(Instant::now()))
            .expect("event");
        if let Some(t) = f(&ev) {
            return t;
        }
    }
}

#[test]
fn bridge_absent_fails_open_fast_and_silent() {
    let d = Dir::new();
    // Socket path does not exist at all.
    let (out, err, took) = Run::spawn(&d.sock(), 60_000, &perm("s")).finish(Duration::from_secs(3));
    assert_eq!((out.as_str(), err.as_str()), ("", ""));
    assert!(took < Duration::from_secs(1), "took {took:?}");
    // A dead socket file (nobody listening).
    drop(UnixListener::bind(d.sock()).unwrap());
    let (out, _, took) = Run::spawn(&d.sock(), 60_000, &perm("s")).finish(Duration::from_secs(3));
    assert_eq!(out, "");
    assert!(took < Duration::from_secs(1));
}

#[test]
fn non_blocking_event_exits_quietly() {
    let d = Dir::new();
    let b = bridge(&d);
    let rx = b.subscribe();
    let p = json!({"hook_event_name":"Stop","session_id":"s"}).to_string();
    let (out, err, _) = Run::spawn(&d.sock(), 2_000, &p).finish(Duration::from_secs(3));
    assert_eq!((out.as_str(), err.as_str()), ("", ""));
    let key = wait_event(&rx, |e| match e {
        BridgeEvent::Hook(h) => Some(h.session.key.clone()),
        _ => None,
    });
    assert_eq!(
        key.as_deref(),
        Some("dm-1"),
        "--session-key reaches the bridge"
    );
}

#[test]
fn permission_decision_is_printed_for_the_cli() {
    let d = Dir::new();
    let b = bridge(&d);
    let rx = b.subscribe();
    let run = Run::spawn(&d.sock(), 20_000, &perm("s"));
    let id = wait_event(&rx, |e| match e {
        BridgeEvent::Permission(p) => Some(p.id),
        _ => None,
    });
    b.answer_permission(id, PermissionAnswer::Allow).unwrap();
    let (out, err, _) = run.finish(Duration::from_secs(3));
    assert_eq!(err, "");
    let v: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(
        v,
        json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}})
    );
}

#[test]
fn question_answer_is_printed_as_updated_input() {
    let d = Dir::new();
    let b = bridge(&d);
    let rx = b.subscribe();
    let payload = json!({"hook_event_name":"PreToolUse","session_id":"s","tool_name":"AskUserQuestion",
        "tool_use_id":"t1","tool_input":{"questions":[{"question":"Pick?","header":"H","multiSelect":false,
        "options":[{"label":"A","description":""},{"label":"B","description":""}]}]}})
    .to_string();
    let run = Run::spawn(&d.sock(), 20_000, &payload);
    let id = wait_event(&rx, |e| match e {
        BridgeEvent::Question(q) => Some(q.id),
        _ => None,
    });
    b.answer_question(id, QuestionAnswers::new().with("Pick?", "B"))
        .unwrap();
    let (out, _, _) = run.finish(Duration::from_secs(3));
    let v: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "allow");
    assert_eq!(
        v["hookSpecificOutput"]["updatedInput"]["answers"]["Pick?"],
        "B"
    );
}

#[test]
fn tui_answer_makes_the_hook_exit_without_output() {
    let d = Dir::new();
    let b = bridge(&d);
    let rx = b.subscribe();
    let run = Run::spawn(&d.sock(), 60_000, &perm("s"));
    wait_event(&rx, |e| {
        matches!(e, BridgeEvent::Permission(_)).then_some(())
    });
    let post = json!({"hook_event_name":"PostToolUse","session_id":"s","tool_name":"Bash",
        "tool_use_id":"t","tool_input":{"command":"echo hi"}})
    .to_string();
    Run::spawn(&d.sock(), 2_000, &post).finish(Duration::from_secs(3));
    let (out, _, took) = run.finish(Duration::from_secs(3));
    assert_eq!(out, "");
    assert!(took < Duration::from_secs(3));
}

#[test]
fn bridge_timeout_releases_the_hook_with_no_output() {
    let d = Dir::new();
    let mut cfg = BridgeConfig::new(d.sock());
    cfg.permission_wait = Duration::from_millis(400);
    let b = Bridge::start(cfg).unwrap();
    b.set_chat_attached(true);
    let (out, _, took) = Run::spawn(&d.sock(), 60_000, &perm("s")).finish(Duration::from_secs(5));
    assert_eq!(out, "");
    assert!(
        took >= Duration::from_millis(300) && took < Duration::from_secs(3),
        "{took:?}"
    );
}

#[test]
fn hung_bridge_cannot_hold_the_hook_past_its_own_deadline() {
    let d = Dir::new();
    // A listener that accepts and never answers.
    let l = UnixListener::bind(d.sock()).unwrap();
    let t = std::thread::spawn(move || {
        let (s, _) = l.accept().unwrap();
        std::thread::sleep(Duration::from_secs(6));
        drop(s);
    });
    let (out, _, took) = Run::spawn(&d.sock(), 600, &perm("s")).finish(Duration::from_secs(4));
    assert_eq!(out, "");
    assert!(took < Duration::from_secs(3), "{took:?}");
    t.join().unwrap();
}

#[test]
fn bridge_closing_the_connection_ends_the_hook() {
    let d = Dir::new();
    let l = UnixListener::bind(d.sock()).unwrap();
    let t = std::thread::spawn(move || {
        let (s, _) = l.accept().unwrap();
        drop(s);
    });
    let (out, _, took) = Run::spawn(&d.sock(), 60_000, &perm("s")).finish(Duration::from_secs(3));
    assert_eq!(out, "");
    assert!(took < Duration::from_secs(2));
    t.join().unwrap();
}

#[test]
fn garbage_stdin_fails_open() {
    let d = Dir::new();
    let _b = bridge(&d);
    let (out, err, _) =
        Run::spawn(&d.sock(), 2_000, "this is not json").finish(Duration::from_secs(3));
    assert_eq!((out.as_str(), err.as_str()), ("", ""));
    let (out, _, _) = Run::spawn(&d.sock(), 2_000, "").finish(Duration::from_secs(3));
    assert_eq!(out, "");
}

#[test]
fn stdin_that_never_closes_cannot_hang_the_hook() {
    let d = Dir::new();
    let _b = bridge(&d);
    let mut child = Command::new(HOOK)
        .args(["--socket", &d.sock().to_string_lossy(), "--wait-ms", "1000"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let _keep_open = child.stdin.take().unwrap();
    let start = Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if start.elapsed() > Duration::from_secs(6) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("hook hung on an open stdin");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn generated_settings_command_runs_through_a_shell_with_awkward_paths() {
    let root = Dir::new();
    let spaced = root.0.join("it's a dir");
    std::fs::create_dir_all(&spaced).unwrap();
    let sock = spaced.join("b.sock");
    let bin = spaced.join("patchroom-hook");
    std::fs::copy(HOOK, &bin).unwrap();
    let b = Bridge::start(BridgeConfig::new(&sock)).unwrap();
    b.set_chat_attached(true);
    let rx = b.subscribe();
    let settings = HookSettings::new(&bin, &sock)
        .with_session_key("dm-9")
        .to_value();
    let command = settings["hooks"]["PermissionRequest"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut child = Command::new("sh")
        .args(["-c", &command])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(perm("s").as_bytes())
        .unwrap();
    let run = Run { child };
    let (id, key) = wait_event(&rx, |e| match e {
        BridgeEvent::Permission(p) => Some((p.id, p.session.key.clone())),
        _ => None,
    });
    assert_eq!(key.as_deref(), Some("dm-9"));
    b.answer_permission(
        id,
        PermissionAnswer::Deny {
            message: "no".into(),
        },
    )
    .unwrap();
    let (out, _, _) = run.finish(Duration::from_secs(3));
    assert!(out.contains("\"behavior\":\"deny\""), "{out}");
}
