//! Gated real-claude integration test. Run with:
//! `cargo test -p patchroom-hook --test real_claude -- --ignored --nocapture`
//!
//! Starts an interactive `claude --setting-sources local --model haiku` in a throwaway cwd
//! under the std temp dir, with the bridge's generated `--settings` JSON. Then:
//!
//! 1. answers one permission prompt from the bridge side (allow),
//! 2. answers one AskUserQuestion from the bridge side,
//! 3. answers a permission prompt in the TUI and checks the bridge cancels its hook.
//!
//! Each answer is checked in the session transcript. At the end no `patchroom-hook`
//! process may be left, and everything the test started is killed.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use patchroom_bridge::{
    Bridge, BridgeConfig, BridgeEvent, HookSettings, PermissionAnswer, QuestionAnswers, Resolution,
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

const HOOK: &str = env!("CARGO_BIN_EXE_patchroom-hook");
const STEP: Duration = Duration::from_secs(150);

struct Session {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    screen: Arc<Mutex<Vec<u8>>>,
    token: String,
    dir: PathBuf,
    cwd: PathBuf,
}

impl Session {
    fn send(&self, bytes: &[u8]) {
        let mut w = self.writer.lock().unwrap();
        w.write_all(bytes).unwrap();
        w.flush().unwrap();
    }

    fn submit(&self, text: &str) {
        self.send(text.as_bytes());
        std::thread::sleep(Duration::from_millis(400));
        self.send(b"\r");
    }

    fn screen_text(&self) -> String {
        let raw = self.screen.lock().unwrap().clone();
        strip_ansi(&String::from_utf8_lossy(&raw))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // The unique token appears in the claude command line (settings JSON) and in every
        // hook command line this test started, and nowhere else.
        let _ = Command::new("pkill")
            .args(["-KILL", "-f", &self.token])
            .status();
        let _ = std::fs::remove_dir_all(&self.dir);
        let _ = std::fs::remove_dir_all(&self.cwd);
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            if n == 'C' || n == 'G' {
                                out.push(' ');
                            }
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut b)
        .unwrap();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// Stable throwaway cwd under the std temp dir. claude records folder trust per path in its
/// own state, so a fixed path keeps that to a single entry across runs. Emptied every run.
fn throwaway_cwd() -> PathBuf {
    let cwd = std::env::temp_dir().join("patchroom-e2e-cwd");
    let _ = std::fs::remove_dir_all(&cwd);
    std::fs::create_dir_all(&cwd).unwrap();
    cwd.canonicalize().unwrap()
}

fn spawn_claude(
    dir: &Path,
    cwd: &Path,
    settings_json: &str,
    session_id: &str,
    token: String,
) -> Session {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut cmd = CommandBuilder::new("claude");
    cmd.args([
        "--setting-sources",
        "local",
        "--model",
        "haiku",
        "--permission-mode",
        "default",
        "--session-id",
        session_id,
        "--settings",
        settings_json,
    ]);
    cmd.cwd(cwd);
    for (k, _) in std::env::vars() {
        if k.starts_with("CLAUDE") || k.starts_with("ANTHROPIC_") {
            cmd.env_remove(&k);
        }
    }
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let writer: Arc<Mutex<Box<dyn Write + Send>>> =
        Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
    let screen = Arc::new(Mutex::new(Vec::new()));
    {
        let (writer, screen) = (Arc::clone(&writer), Arc::clone(&screen));
        // Keep draining, or claude blocks on write. Answer the startup terminal queries.
        std::thread::spawn(move || {
            let mut buf = [0u8; 65536];
            // Keep the master alive for as long as the reader runs.
            let _master = pair.master;
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let chunk = &buf[..n];
                screen.lock().unwrap().extend_from_slice(chunk);
                let has = |needle: &[u8]| chunk.windows(needle.len()).any(|w| w == needle);
                let mut w = writer.lock().unwrap();
                if has(b"\x1b[c") {
                    let _ = w.write_all(b"\x1b[?62;c");
                }
                if has(b"\x1b[>0q") {
                    let _ = w.write_all(b"\x1bP>|xterm.js(5.5.0)\x1b\\");
                }
                let _ = w.flush();
            }
        });
    }
    Session {
        child,
        writer,
        screen,
        token,
        dir: dir.to_owned(),
        cwd: cwd.to_owned(),
    }
}

fn wait_for<T>(
    rx: &Receiver<BridgeEvent>,
    session: &Session,
    what: &str,
    mut f: impl FnMut(&BridgeEvent) -> Option<T>,
) -> T {
    let end = Instant::now() + STEP;
    let mut last_trust_poke = Instant::now() - Duration::from_secs(10);
    loop {
        let left = end.saturating_duration_since(Instant::now());
        assert!(
            !left.is_zero(),
            "timed out waiting for {what}\n--- screen tail ---\n{}",
            tail(&session.screen_text())
        );
        match rx.recv_timeout(Duration::from_millis(500).min(left)) {
            Ok(ev) => {
                if let Some(t) = f(&ev) {
                    return t;
                }
            }
            Err(_) => {
                // A fresh throwaway cwd may raise the folder-trust dialog. Accept it.
                // Spaces are cursor moves in the stream, so compare without whitespace.
                let text: String = session.screen_text().split_whitespace().collect();
                if text.contains("Yes,Itrustthisfolder")
                    && text.contains("Entertoconfirm")
                    && last_trust_poke.elapsed() > Duration::from_secs(3)
                {
                    // The cursor starts on "No, exit": move down, then confirm.
                    session.send(b"\x1b[B");
                    std::thread::sleep(Duration::from_millis(300));
                    session.send(b"\r");
                    last_trust_poke = Instant::now();
                }
            }
        }
    }
}

fn tail(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    chars[chars.len().saturating_sub(1500)..].iter().collect()
}

fn hook_processes(hook_bin: &str) -> Vec<String> {
    let out = Command::new("ps")
        .args(["-axo", "pid=,command="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.split_whitespace().nth(1) == Some(hook_bin))
        .map(str::to_owned)
        .collect()
}

fn wait_file_contains(path: &Path, needle: &str, what: &str) -> String {
    let end = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(t) = std::fs::read_to_string(path) {
            if t.contains(needle) {
                return t;
            }
        }
        assert!(
            Instant::now() < end,
            "transcript never showed {what} ({needle})"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
#[ignore = "drives the real claude CLI (haiku); run with --ignored"]
fn answers_permission_and_question_from_the_bridge_and_leaves_no_hooks() {
    let token = format!(
        "prx{}{}",
        std::process::id(),
        uuid_v4().replace('-', "")[..8].to_owned()
    );
    let dir = std::env::temp_dir().join(&token);
    std::fs::create_dir_all(&dir).unwrap();
    let sock = dir.join("b.sock");

    let mut cfg = BridgeConfig::new(&sock);
    cfg.permission_wait = Duration::from_secs(120);
    cfg.ask_wait = Duration::from_secs(120);
    let bridge = Bridge::start(cfg).unwrap();
    bridge.set_chat_attached(true);
    let rx = bridge.subscribe();

    let mut hs = HookSettings::new(HOOK, &sock).with_session_key("e2e");
    hs.permission_wait = Duration::from_secs(120);
    hs.ask_wait = Duration::from_secs(120);
    let session_id = uuid_v4();
    let cwd = throwaway_cwd();
    let session = spawn_claude(&dir, &cwd, &hs.to_json_string(), &session_id, token.clone());
    bridge.track_session("e2e", None, Some(session_id.clone()));

    // Boot: SessionStart arrives once claude is up (after any folder-trust dialog).
    let transcript = wait_for(&rx, &session, "SessionStart", |e| match e {
        BridgeEvent::Hook(h) if h.event == "SessionStart" => Some(h.transcript_path.clone()),
        _ => None,
    });
    std::thread::sleep(Duration::from_secs(2));

    // 1. Permission answered from the bridge.
    session.submit("Use the Bash tool to run exactly this command, then reply with only the word done: echo patchroom-perm-ok > perm.txt");
    let prompt = wait_for(&rx, &session, "PermissionRequest", |e| match e {
        BridgeEvent::Permission(p) => Some(p.clone()),
        _ => None,
    });
    assert_eq!(prompt.tool_name, "Bash");
    assert_eq!(prompt.session.key.as_deref(), Some("e2e"));
    bridge
        .answer_permission(prompt.id, PermissionAnswer::Allow)
        .unwrap();
    wait_for(&rx, &session, "Stop after permission turn", |e| match e {
        BridgeEvent::Hook(h) if h.event == "Stop" => Some(()),
        _ => None,
    });
    assert_eq!(
        std::fs::read_to_string(cwd.join("perm.txt"))
            .unwrap()
            .trim(),
        "patchroom-perm-ok"
    );
    let transcript = transcript.expect("SessionStart payload carries transcript_path");
    wait_file_contains(
        &transcript,
        "patchroom-perm-ok",
        "the permitted Bash command",
    );

    // 2. AskUserQuestion answered from the bridge.
    session.submit("Use the AskUserQuestion tool to ask me which color I prefer, with exactly the options Red and Blue. Then reply with only the color I chose.");
    let q = wait_for(&rx, &session, "AskUserQuestion", |e| match e {
        BridgeEvent::Question(q) => Some(q.clone()),
        _ => None,
    });
    assert!(
        q.questions[0].options.iter().any(|o| o.label == "Blue"),
        "{:?}",
        q.questions
    );
    let question_text = q.questions[0].question.clone();
    bridge
        .answer_question(
            q.id,
            QuestionAnswers::new().with(question_text.clone(), "Blue"),
        )
        .unwrap();
    wait_for(&rx, &session, "Stop after question turn", |e| match e {
        BridgeEvent::Hook(h) if h.event == "Stop" => Some(()),
        _ => None,
    });
    let t = wait_file_contains(
        &transcript,
        "Your questions have been answered",
        "the AskUserQuestion answer",
    );
    assert!(t.contains("Blue"), "answer text missing from transcript");

    // 3. The user answers in the TUI first: the bridge must cancel the pending hook.
    session.submit("Use the Bash tool to run exactly this command, then reply with only the word done: echo patchroom-tui-ok > tui.txt");
    let prompt = wait_for(&rx, &session, "second PermissionRequest", |e| match e {
        BridgeEvent::Permission(p) => Some(p.clone()),
        _ => None,
    });
    std::thread::sleep(Duration::from_millis(800));
    session.send(b"1"); // TUI option 1 (Yes)
    let resolution = wait_for(&rx, &session, "TUI answer detection", |e| match e {
        BridgeEvent::Resolved(r) if r.id == prompt.id => Some(r.resolution),
        _ => None,
    });
    assert_eq!(resolution, Resolution::Terminal);
    wait_for(&rx, &session, "Stop after TUI turn", |e| match e {
        BridgeEvent::Hook(h) if h.event == "Stop" => Some(()),
        _ => None,
    });
    assert_eq!(
        std::fs::read_to_string(cwd.join("tui.txt")).unwrap().trim(),
        "patchroom-tui-ok"
    );

    // No hook process may be left running.
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        let left = hook_processes(HOOK);
        // Other tests on this machine may run their own hooks; ours carry the token.
        let ours: Vec<_> = left.into_iter().filter(|l| l.contains(&token)).collect();
        if ours.is_empty() {
            break;
        }
        assert!(
            Instant::now() < end,
            "hook processes left running: {ours:?}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    assert!(bridge.pending().is_empty());
    drop(session);
    drop(bridge);
}
