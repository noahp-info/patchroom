//! Runs the real `patchroom-statusline` binary against a real bridge.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use patchroom_bridge::{Bridge, BridgeConfig, BridgeEvent};
use serde_json::{json, Value};

const WRAPPER: &str = env!("CARGO_BIN_EXE_patchroom-statusline");
static N: AtomicU32 = AtomicU32::new(0);

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let d = std::env::temp_dir().join(format!(
            "prs-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&d).unwrap();
        Self(d)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run_wrapper(sock: &Path, home: &Path, cwd: &Path, stdin: &str) -> (Vec<u8>, bool) {
    let mut child = Command::new(WRAPPER)
        .args(["--socket", &sock.to_string_lossy(), "--session-key", "dm-1"])
        .env("HOME", home)
        .env_remove("CLAUDE_CONFIG_DIR")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (out.stdout, out.stderr.is_empty() && out.status.success())
}

fn next_statusline(
    rx: &std::sync::mpsc::Receiver<BridgeEvent>,
) -> patchroom_bridge::StatuslineRecord {
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        let left = end.saturating_duration_since(Instant::now());
        if let BridgeEvent::Statusline(r) = rx.recv_timeout(left).expect("no statusline event") {
            return r;
        }
    }
}

#[test]
fn runs_the_users_command_unchanged_and_tees_stdin_and_output() {
    let d = Dir::new();
    let home = d.0.join("home");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    // The user's statusLine echoes the model name from the JSON and some ANSI.
    let user_cmd = "python3 -c \"import sys,json; d=json.load(sys.stdin); sys.stdout.write('\\x1b[32m'+d['model']['display_name']+'\\x1b[0m')\"";
    let settings = json!({"statusLine": {"type": "command", "command": user_cmd}});
    std::fs::write(home.join(".claude/settings.json"), settings.to_string()).unwrap();
    let settings_before = std::fs::read(home.join(".claude/settings.json")).unwrap();

    let bridge = Bridge::start(BridgeConfig::new(d.0.join("b.sock"))).unwrap();
    let rx = bridge.subscribe();
    let stdin = json!({
        "session_id": "sid-9", "cwd": d.0.to_string_lossy(),
        "model": {"id": "claude-haiku", "display_name": "Haiku"},
        "workspace": {"current_dir": d.0.to_string_lossy(), "project_dir": d.0.to_string_lossy()}
    })
    .to_string();
    let (out, clean) = run_wrapper(bridge.socket_path(), &home, &d.0, &stdin);
    assert!(clean, "wrapper must exit 0 with an empty stderr");
    assert_eq!(out, b"\x1b[32mHaiku\x1b[0m");

    let rec = next_statusline(&rx);
    assert_eq!(rec.session.key.as_deref(), Some("dm-1"));
    assert_eq!(rec.payload["model"]["display_name"], "Haiku");
    assert_eq!(rec.output, "\u{1b}[32mHaiku\u{1b}[0m");
    // The settings file was only read.
    assert_eq!(
        std::fs::read(home.join(".claude/settings.json")).unwrap(),
        settings_before
    );
}

#[test]
fn project_settings_outrank_user_settings() {
    let d = Dir::new();
    let home = d.0.join("home");
    let proj = d.0.join("proj");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::create_dir_all(proj.join(".claude")).unwrap();
    std::fs::write(
        home.join(".claude/settings.json"),
        json!({"statusLine": {"type": "command", "command": "printf user"}}).to_string(),
    )
    .unwrap();
    std::fs::write(
        proj.join(".claude/settings.json"),
        json!({"statusLine": {"type": "command", "command": "printf project"}}).to_string(),
    )
    .unwrap();
    let bridge = Bridge::start(BridgeConfig::new(d.0.join("b.sock"))).unwrap();
    let stdin = json!({"cwd": proj.to_string_lossy()}).to_string();
    let (out, _) = run_wrapper(bridge.socket_path(), &home, &proj, &stdin);
    assert_eq!(out, b"project");
}

#[test]
fn no_user_statusline_prints_nothing_but_still_tees() {
    let d = Dir::new();
    let home = d.0.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let bridge = Bridge::start(BridgeConfig::new(d.0.join("b.sock"))).unwrap();
    let rx = bridge.subscribe();
    let stdin =
        json!({"session_id": "s", "cwd": d.0.to_string_lossy(), "cost": {"total_cost_usd": 0.5}})
            .to_string();
    let (out, clean) = run_wrapper(bridge.socket_path(), &home, &d.0, &stdin);
    assert!(clean);
    assert!(out.is_empty());
    let rec = next_statusline(&rx);
    assert_eq!(rec.output, "");
    assert_eq!(rec.payload["cost"]["total_cost_usd"], 0.5);
}

#[test]
fn absent_bridge_and_garbage_stdin_fail_open() {
    let d = Dir::new();
    let home = d.0.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let (out, clean) = run_wrapper(&d.0.join("nope.sock"), &home, &d.0, "not json");
    assert!(clean);
    assert!(out.is_empty());
    let _: Value = json!(null);
}
