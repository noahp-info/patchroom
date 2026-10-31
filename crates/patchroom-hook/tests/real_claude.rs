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
    spawn_claude_in(dir, cwd, settings_json, session_id, token, "default")
}

fn spawn_claude_in(
    dir: &Path,
    cwd: &Path,
    settings_json: &str,
    session_id: &str,
    token: String,
    mode: &str,
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
        mode,
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

/// One live claude session with the bridge, for the question tests below.
struct Live {
    bridge: Bridge,
    rx: Receiver<BridgeEvent>,
    session: Session,
    transcript: PathBuf,
    token: String,
}

fn start_live(ask_wait: Duration) -> Live {
    start_live_in(ask_wait, "default")
}

fn start_live_in(ask_wait: Duration, mode: &str) -> Live {
    let token = format!(
        "prx{}{}",
        std::process::id(),
        uuid_v4().replace('-', "")[..8].to_owned()
    );
    let dir = std::env::temp_dir().join(&token);
    std::fs::create_dir_all(&dir).unwrap();
    let sock = dir.join("b.sock");
    let mut cfg = BridgeConfig::new(&sock);
    cfg.ask_wait = ask_wait;
    let bridge = Bridge::start(cfg).unwrap();
    bridge.set_chat_attached(true);
    let rx = bridge.subscribe();
    // The real launch settings: the hook timeouts are the long defaults.
    let hs = HookSettings::new(HOOK, &sock).with_session_key("e2e");
    let mut settings = hs.to_value();
    // Plan mode writes plan files; keep them in the throwaway cwd (the path is project-relative).
    settings["plansDirectory"] = serde_json::json!(".plans");
    let session_id = uuid_v4();
    let cwd = throwaway_cwd();
    let session = spawn_claude_in(
        &dir,
        &cwd,
        &settings.to_string(),
        &session_id,
        token.clone(),
        mode,
    );
    bridge.track_session("e2e", None, Some(session_id.clone()));
    let transcript = wait_for(&rx, &session, "SessionStart", |e| match e {
        BridgeEvent::Hook(h) if h.event == "SessionStart" => Some(h.transcript_path.clone()),
        _ => None,
    })
    .expect("SessionStart payload carries transcript_path");
    std::thread::sleep(Duration::from_secs(2));
    Live {
        bridge,
        rx,
        session,
        transcript,
        token,
    }
}

fn assert_no_hooks_left(token: &str) {
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        let ours: Vec<_> = hook_processes(HOOK)
            .into_iter()
            .filter(|l| l.contains(token))
            .collect();
        if ours.is_empty() {
            return;
        }
        assert!(
            Instant::now() < end,
            "hook processes left running: {ours:?}"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

const ASK_COLOR: &str = "Use the AskUserQuestion tool to ask me which color I prefer, with exactly the options Red and Blue. Then reply with only the color I chose.";

#[test]
#[ignore = "drives the real claude CLI (haiku); run with --ignored"]
fn question_is_held_with_the_real_long_hook_timeout() {
    let live = start_live(patchroom_bridge::ASK_HOLD);
    live.session.submit(ASK_COLOR);
    let q = wait_for(&live.rx, &live.session, "AskUserQuestion", |e| match e {
        BridgeEvent::Question(q) => Some(q.clone()),
        _ => None,
    });
    assert!(!q.tui_shown);
    // Longer than a broken (overflowed) hook timeout would allow: still held.
    std::thread::sleep(Duration::from_secs(8));
    assert_eq!(
        live.bridge.pending().len(),
        1,
        "the question must still be held"
    );
    live.bridge
        .answer_question(
            q.id,
            QuestionAnswers::new().with(q.questions[0].question.clone(), "Blue"),
        )
        .unwrap();
    wait_for(&live.rx, &live.session, "Stop", |e| match e {
        BridgeEvent::Hook(h) if h.event == "Stop" => Some(()),
        _ => None,
    });
    // The tool_result carries the chosen label (escaped quotes inside the JSON line).
    wait_file_contains(
        &live.transcript,
        r#"=\"Blue\""#,
        "the AskUserQuestion answer",
    );
    assert_no_hooks_left(&live.token);
}

#[test]
#[ignore = "drives the real claude CLI (haiku); run with --ignored"]
fn question_on_the_permission_path_is_answered_from_chat() {
    // A short bridge hold makes the PreToolUse hold time out, so claude takes the
    // permission path and draws its own picker.
    let live = start_live(Duration::from_secs(2));
    live.session.submit(ASK_COLOR);
    let first = wait_for(
        &live.rx,
        &live.session,
        "PreToolUse question",
        |e| match e {
            BridgeEvent::Question(q) if !q.tui_shown => Some(q.clone()),
            _ => None,
        },
    );
    let q = wait_for(
        &live.rx,
        &live.session,
        "PermissionRequest question",
        |e| match e {
            BridgeEvent::Question(q) if q.tui_shown => Some(q.clone()),
            BridgeEvent::Permission(p) => panic!("raw permission prompt for {}", p.tool_name),
            _ => None,
        },
    );
    assert_ne!(first.id, q.id);
    assert_eq!(q.questions[0].question, first.questions[0].question);
    live.bridge
        .answer_question(
            q.id,
            QuestionAnswers::new().with(q.questions[0].question.clone(), "Blue"),
        )
        .unwrap();
    wait_for(&live.rx, &live.session, "Stop", |e| match e {
        BridgeEvent::Hook(h) if h.event == "Stop" => Some(()),
        _ => None,
    });
    // A PermissionRequest allow with `updatedInput.answers` closes the picker and delivers
    // the answer: no keys are typed into the TUI.
    wait_file_contains(
        &live.transcript,
        r#"=\"Blue\""#,
        "the AskUserQuestion answer",
    );
    assert_no_hooks_left(&live.token);
}

/// Wait for the `tool_result` of `tool_use_id` in the transcript and return its line.
fn wait_tool_result(path: &Path, tool_use_id: &str, session: &Session) -> String {
    let end = Instant::now() + Duration::from_secs(60);
    loop {
        if let Ok(t) = std::fs::read_to_string(path) {
            if let Some(l) = t.lines().find(|l| {
                l.contains("\"tool_result\"")
                    && l.contains(tool_use_id)
                    && !l.contains("api-request-blob")
            }) {
                return l.to_owned();
            }
        }
        assert!(
            Instant::now() < end,
            "no tool_result for {tool_use_id}\n--- screen ---\n{}",
            tail(&session.screen_text())
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// The number of the numbered option whose text contains `needle` (lowercase).
fn option_digit(screen: &str, needle: &str) -> Option<char> {
    screen.lines().rev().find_map(|l| {
        let t = l.trim_start_matches(|c: char| !c.is_ascii_digit());
        let (n, rest) = t.split_once('.')?;
        let d = n.trim().chars().next().filter(char::is_ascii_digit)?;
        (n.trim().len() == 1 && rest.to_lowercase().contains(needle)).then_some(d)
    })
}

#[test]
#[ignore = "drives the real claude CLI (haiku); run with --ignored"]
fn plan_answered_through_the_dialog_gets_no_second_card() {
    let live = start_live_in(patchroom_bridge::ASK_HOLD, "plan");
    live.session.submit("Make a one-step plan to create a file named plan-ok.txt containing the word ok, then call ExitPlanMode with it right away. Do not ask questions.");
    let p = wait_for(&live.rx, &live.session, "PreToolUse plan", |e| match e {
        BridgeEvent::Plan(p) if !p.tui_shown => Some(p.clone()),
        _ => None,
    });
    // The chat answer path: release the hold, then press the dialog's own key.
    assert!(live.bridge.release(p.id, Resolution::Chat));
    let end = Instant::now() + Duration::from_secs(20);
    let digit = loop {
        let text = live.session.screen_text();
        if text.to_lowercase().contains("tell claude") {
            if let Some(d) = option_digit(&text, "manually approve") {
                break d;
            }
        }
        assert!(Instant::now() < end, "no plan dialog:\n{}", tail(&text));
        std::thread::sleep(Duration::from_millis(100));
    };
    // The PermissionRequest that followed must not have become a second plan card.
    assert!(
        live.bridge.pending().is_empty(),
        "the dialog's PermissionRequest was held: {:?}",
        live.bridge.pending()
    );
    std::thread::sleep(Duration::from_millis(300));
    live.session.send(digit.to_string().as_bytes());
    let tu = p
        .tool_use_id
        .clone()
        .expect("PreToolUse carries the tool use id");
    let line = wait_tool_result(&live.transcript, &tu, &live.session);
    assert!(line.to_lowercase().contains("approved"), "{line}");
    while let Ok(ev) = live.rx.try_recv() {
        if let BridgeEvent::Plan(pp) = ev {
            panic!("second plan card: tui_shown={}", pp.tui_shown);
        }
    }
    assert_no_hooks_left(&live.token);
}

#[test]
#[ignore = "drives the real claude CLI (haiku); run with --ignored"]
fn plan_on_the_permission_path_is_a_plan_card() {
    // A short hold times the PreToolUse plan out, so claude draws its own dialog and asks
    // through PermissionRequest.
    let live = start_live_in(Duration::from_secs(2), "plan");
    live.session.submit("Make a one-step plan to create a file named plan-ok.txt containing the word ok, then call ExitPlanMode with it right away. Do not ask questions.");
    let first = wait_for(&live.rx, &live.session, "PreToolUse plan", |e| match e {
        BridgeEvent::Plan(p) if !p.tui_shown => Some(p.clone()),
        _ => None,
    });
    let p = wait_for(
        &live.rx,
        &live.session,
        "PermissionRequest plan",
        |e| match e {
            BridgeEvent::Plan(p) if p.tui_shown => Some(p.clone()),
            BridgeEvent::Permission(p) => panic!("raw permission prompt for {}", p.tool_name),
            _ => None,
        },
    );
    assert_eq!(p.plan, first.plan);
    // Answer as the chat does: release, then the dialog's key.
    assert!(live.bridge.release(p.id, Resolution::Chat));
    let end = Instant::now() + Duration::from_secs(20);
    let digit = loop {
        let text = live.session.screen_text();
        if let Some(d) = option_digit(&text, "manually approve") {
            break d;
        }
        assert!(Instant::now() < end, "no plan dialog:\n{}", tail(&text));
        std::thread::sleep(Duration::from_millis(100));
    };
    // The dialog is drawn when PermissionRequest fires; a key that lands in the same
    // instant is dropped, so settle first (the manager waits too).
    std::thread::sleep(Duration::from_millis(500));
    live.session.send(digit.to_string().as_bytes());
    let tu = first
        .tool_use_id
        .clone()
        .expect("PreToolUse carries the tool use id");
    let line = wait_tool_result(&live.transcript, &tu, &live.session);
    assert!(line.to_lowercase().contains("approved"), "{line}");
    assert_no_hooks_left(&live.token);
}

#[test]
#[ignore = "drives the real claude CLI (haiku); run with --ignored"]
fn a_bracketed_paste_lands_as_one_unsent_input() {
    // Patchroom carries a multi-line chat draft to the terminal as one bracketed paste.
    let live = start_live(patchroom_bridge::ASK_HOLD);
    assert!(
        String::from_utf8_lossy(&live.session.screen.lock().unwrap()).contains("\x1b[?2004h"),
        "claude turns bracketed paste on"
    );
    live.session
        .send(b"\x1b[200~Reply with only the word ok.\nThis second line is part of it.\x1b[201~");
    // Nothing is submitted by the paste itself, newline included.
    std::thread::sleep(Duration::from_secs(3));
    while let Ok(ev) = live.rx.try_recv() {
        if let BridgeEvent::Hook(h) = ev {
            assert_ne!(
                h.event, "UserPromptSubmit",
                "the paste submitted the prompt"
            );
        }
    }
    live.session.send(b"\r");
    wait_for(&live.rx, &live.session, "UserPromptSubmit", |e| match e {
        BridgeEvent::Hook(h) if h.event == "UserPromptSubmit" => Some(()),
        _ => None,
    });
    // One prompt, both lines.
    wait_file_contains(
        &live.transcript,
        r"Reply with only the word ok.\nThis second line is part of it.",
        "the pasted prompt as one message",
    );
    assert_no_hooks_left(&live.token);
}
