//! Integration tests against real PTYs and the real login shell.

mod common;

use std::time::{Duration, Instant};

use common::{run_to_exit, strip_ansi};
use nix::sys::signal::kill;
use nix::unistd::Pid;
use patchroom_pty::{
    Command, Key, ProgressState, PtyEvent, Session, SpawnConfig, TitleKind, DEFAULT_ENTER_DELAY,
};

const T: Duration = Duration::from_secs(20);

fn sh(script: &str) -> SpawnConfig {
    SpawnConfig::new(Command::program("sh", ["-c", script]), "test-session")
}

fn alive(pid: i32) -> bool {
    kill(Pid::from_raw(pid), None).is_ok()
}

#[test]
fn login_shell_resolves_node_gh_git() {
    let s = Session::spawn(sh("command -v node && command -v gh && command -v git")).unwrap();
    let run = run_to_exit(&s.events(), T);
    let text = run.text();
    assert!(run.exit.success(), "exit {:?}, output {text:?}", run.exit);
    for tool in ["node", "gh", "git"] {
        assert!(
            text.lines()
                .any(|l| l.trim_end().ends_with(&format!("/{tool}"))),
            "{tool} did not resolve: {text:?}"
        );
    }
}

#[test]
fn spawns_through_login_shell_dash_l() {
    // `shopt login_shell` is bash only, so force bash explicitly.
    let mut cfg = SpawnConfig::new(
        Command::Shell("shopt -q login_shell && echo LOGIN=yes || echo LOGIN=no".into()),
        "s",
    );
    cfg.shell = Some("/bin/bash".into());
    let s = Session::spawn(cfg).unwrap();
    let run = run_to_exit(&s.events(), T);
    assert!(run.text().contains("LOGIN=yes"), "{:?}", run.text());
}

#[test]
fn environment_is_scrubbed_and_set() {
    // Unique names so parallel tests are unaffected by the process-wide env.
    std::env::set_var("CLAUDE_PTY_TEST_LEAK", "1");
    std::env::set_var("CLAUDECODE", "1");
    let mut cfg = sh(
        "echo TERM=$TERM; echo COLORTERM=$COLORTERM; echo SESSION=$PATCHROOM_SESSION; \
         echo TTY=$PATCHROOM_TTY; echo ACTUAL=$(tty); env | grep -c '^CLAUDE' | sed 's/^/CLAUDECOUNT=/'; \
         echo EXPLICIT=$CLAUDE_CONFIG_DIR",
    );
    cfg.session_id = "sess-xyz".into();
    cfg.env
        .insert("CLAUDE_CONFIG_DIR".into(), "/explicit".into());
    let s = Session::spawn(cfg).unwrap();
    let run = run_to_exit(&s.events(), T);
    let text = run.text().replace('\r', "");
    assert!(text.contains("TERM=xterm-256color"), "{text}");
    assert!(text.contains("COLORTERM=truecolor"), "{text}");
    assert!(text.contains("SESSION=sess-xyz"), "{text}");
    // Only the explicit CLAUDE_CONFIG_DIR survives.
    assert!(text.contains("CLAUDECOUNT=1"), "{text}");
    assert!(text.contains("EXPLICIT=/explicit"), "{text}");
    let get = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(key))
            .unwrap_or_else(|| panic!("missing {key} in {text}"))
            .to_owned()
    };
    let tty = get("TTY=");
    assert!(tty.starts_with("/dev/"), "{tty}");
    assert_eq!(tty, get("ACTUAL="));
    assert_eq!(s.tty().unwrap().to_string_lossy(), tty);
}

#[test]
fn cwd_is_honoured() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = sh("pwd -P");
    cfg.cwd = Some(dir.path().to_path_buf());
    let s = Session::spawn(cfg).unwrap();
    let run = run_to_exit(&s.events(), T);
    let want = dir.path().canonicalize().unwrap();
    assert!(
        run.text().contains(want.to_str().unwrap()),
        "{:?}",
        run.text()
    );
}

#[test]
fn exit_code_is_reported() {
    let s = Session::spawn(sh("exit 7")).unwrap();
    let run = run_to_exit(&s.events(), T);
    assert_eq!(run.exit.code, 7);
    assert_eq!(s.exit_info().unwrap().code, 7);
}

#[test]
fn drains_a_large_burst_with_a_slow_consumer() {
    // 6 MB with no reader for the first second: a missing drain would block
    // the child on a full PTY buffer and the byte count would never arrive.
    let s = Session::spawn(sh("head -c 6000000 /dev/zero | tr '\\0' x")).unwrap();
    std::thread::sleep(Duration::from_secs(1));
    let run = run_to_exit(&s.events(), Duration::from_secs(60));
    let xs = run.output.iter().filter(|&&b| b == b'x').count();
    assert_eq!(xs, 6_000_000);
}

#[test]
fn resize_reaches_the_child() {
    let mut cfg = sh("trap 'stty size; exit 0' WINCH; echo ready; while :; do sleep 0.05; done");
    cfg.rows = 24;
    cfg.cols = 80;
    let s = Session::spawn(cfg).unwrap();
    let rx = s.events();
    let mut seen = Vec::new();
    let deadline = Instant::now() + T;
    while !strip_ansi(&seen).contains("ready") {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(PtyEvent::Output(b)) => seen.extend(b),
            Ok(_) => {}
            Err(e) => panic!("never ready: {e}"),
        }
    }
    s.resize(50, 132).unwrap();
    let run = run_to_exit(&rx, T);
    let text = strip_ansi(&seen) + &strip_ansi(&run.output);
    assert!(text.contains("50 132"), "{text:?}");
}

#[test]
fn kill_leaves_no_orphans() {
    // Child spawns a background grandchild that ignores SIGTERM and prints its pid.
    let s = Session::spawn(sh(
        "(trap '' TERM; exec sleep 300) & echo GRANDCHILD=$!; echo SELF=$$; wait",
    ))
    .unwrap();
    let rx = s.events();
    let mut seen = Vec::new();
    let deadline = Instant::now() + T;
    let (grandchild, selfpid) = loop {
        let text = strip_ansi(&seen);
        let find = |k: &str| {
            text.lines()
                .find_map(|l| l.trim().strip_prefix(k))
                .and_then(|v| v.trim().parse::<i32>().ok())
        };
        if let (Some(g), Some(p)) = (find("GRANDCHILD="), find("SELF=")) {
            break (g, p);
        }
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(PtyEvent::Output(b)) => seen.extend(b),
            Ok(_) => {}
            Err(e) => panic!("no pids: {e}"),
        }
    };
    assert_eq!(selfpid as u32, s.pid(), "login shell must exec the program");
    assert!(alive(grandchild));
    let started = Instant::now();
    s.kill().unwrap();
    assert!(s.exit_info().is_some());
    assert!(started.elapsed() < Duration::from_secs(10));
    // Orphans are reparented and reaped asynchronously; allow a moment.
    let gone = (0..50).any(|_| {
        std::thread::sleep(Duration::from_millis(100));
        !alive(grandchild)
    });
    assert!(gone, "grandchild {grandchild} still alive after kill");
    assert!(!alive(s.pid() as i32));
    // Second kill is a no-op.
    s.kill().unwrap();
}

#[test]
fn drop_kills_the_child() {
    let s = Session::spawn(sh("echo up; exec sleep 300")).unwrap();
    let rx = s.events();
    let mut seen = Vec::new();
    while !strip_ansi(&seen).contains("up") {
        if let Ok(PtyEvent::Output(b)) = rx.recv_timeout(T) {
            seen.extend(b);
        }
    }
    let pid = s.pid() as i32;
    drop(s);
    assert!((0..50).any(|_| {
        std::thread::sleep(Duration::from_millis(100));
        !alive(pid)
    }));
}

/// A reader script that prints one hex line per received byte, so the test can
/// time each byte's arrival through the output stream.
const BYTE_ECHO: &str = "stty raw -echo; echo ready; \
    i=0; while [ $i -lt $N ]; do dd bs=1 count=1 2>/dev/null | od -An -tx1; i=$((i+1)); done";

fn byte_echo(n: usize) -> SpawnConfig {
    let mut cfg = sh(&BYTE_ECHO.replace("$N", &n.to_string()));
    cfg.enter_delay = Duration::from_millis(150);
    cfg
}

/// Collect `(hex byte, arrival time)` pairs until `n` bytes were reported.
fn collect_bytes(rx: &crossbeam_channel::Receiver<PtyEvent>, n: usize) -> Vec<(u8, Instant)> {
    let mut text = String::new();
    let mut got: Vec<(u8, Instant)> = Vec::new();
    let mut consumed = 0usize;
    let deadline = Instant::now() + T;
    while got.len() < n {
        let ev = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("timed out waiting for echoed bytes");
        if let PtyEvent::Output(b) = ev {
            let now = Instant::now();
            text.push_str(&strip_ansi(&b));
            let after_ready = text.find("ready").map_or(0, |i| i + 5);
            let tail = &text[after_ready.max(consumed)..];
            for tok in tail.split_whitespace() {
                if tok.len() == 2 {
                    if let Ok(v) = u8::from_str_radix(tok, 16) {
                        got.push((v, now));
                    }
                }
            }
            consumed = text.len();
        }
    }
    got
}

#[test]
fn send_text_pastes_then_enters_after_delay() {
    let s = Session::spawn(byte_echo(15)).unwrap();
    let rx = s.events();
    // wait for ready
    let mut seen = Vec::new();
    while !strip_ansi(&seen).contains("ready") {
        if let Ok(PtyEvent::Output(b)) = rx.recv_timeout(T) {
            seen.extend(b);
        }
    }
    // Bracketed paste = ESC [ 2 0 0 ~ (6 bytes) + "hi" + ESC [ 2 0 1 ~ (6 bytes) + CR.
    let rx = s.events();
    let sent = Instant::now();
    let h = std::thread::spawn({
        let rx = rx.clone();
        move || collect_bytes(&rx, 15)
    });
    s.send_text("hi").unwrap();
    assert!(
        sent.elapsed() >= Duration::from_millis(150),
        "Enter must be delayed"
    );
    let got = h.join().unwrap();
    let bytes: Vec<u8> = got.iter().map(|(b, _)| *b).collect();
    assert_eq!(bytes, b"\x1b[200~hi\x1b[201~\r".to_vec(), "wire bytes");
    let paste_end = got[13].1;
    let enter = got[14].1;
    assert!(
        enter.duration_since(paste_end) >= Duration::from_millis(100),
        "Enter followed the paste by only {:?}",
        enter.duration_since(paste_end)
    );
}

#[test]
fn default_enter_delay_is_400ms() {
    assert_eq!(DEFAULT_ENTER_DELAY, Duration::from_millis(400));
    assert_eq!(sh("true").enter_delay, Duration::from_millis(400));
}

#[test]
fn send_keys_writes_v3_byte_map() {
    let s = Session::spawn(byte_echo(10)).unwrap();
    let rx = s.events();
    let mut seen = Vec::new();
    while !strip_ansi(&seen).contains("ready") {
        if let Ok(PtyEvent::Output(b)) = rx.recv_timeout(T) {
            seen.extend(b);
        }
    }
    let rx = s.events();
    let h = std::thread::spawn(move || collect_bytes(&rx, 10));
    s.send_keys(&[
        Key::Down,
        Key::Up,
        Key::Enter,
        Key::Esc,
        Key::Tab,
        Key::Digit(4),
    ])
    .unwrap();
    let bytes: Vec<u8> = h.join().unwrap().into_iter().map(|(b, _)| b).collect();
    assert_eq!(bytes, b"\x1b[B\x1b[A\r\x1b\t4".to_vec());
    assert!(s.send_keys(&[Key::Digit(12)]).is_err());
}

#[test]
fn osc_events_parsed_without_altering_bytes() {
    let raw: &[u8] = b"A\x1b]0;\xe2\x9c\xb3 Claude Code\x07B\x1b]2;win\x1b\\C\x1b]1;ico\x07D\
\x1b]9;Claude needs your permission\x07E\x1b]9;4;3\x07F\x1b]9;4;1;42\x07G\x1b]9;4;0\x07H";
    let s = Session::spawn(sh(
        "printf 'A\\033]0;\\342\\234\\263 Claude Code\\007B\\033]2;win\\033\\\\C\\033]1;ico\\007D\
\\033]9;Claude needs your permission\\007E\\033]9;4;3\\007F\\033]9;4;1;42\\007G\\033]9;4;0\\007H'",
    ))
    .unwrap();
    let run = run_to_exit(&s.events(), T);
    // The pty may add nothing here (no newlines were printed), so bytes match.
    assert_eq!(run.output, raw, "bytes forwarded unchanged");
    let parsed: Vec<&PtyEvent> = run
        .events
        .iter()
        .filter(|e| !matches!(e, PtyEvent::Output(_) | PtyEvent::Exit(_)))
        .collect();
    assert_eq!(
        parsed,
        vec![
            &PtyEvent::Title {
                kind: TitleKind::IconAndWindow,
                text: "\u{2733} Claude Code".into()
            },
            &PtyEvent::Title {
                kind: TitleKind::Window,
                text: "win".into()
            },
            &PtyEvent::Title {
                kind: TitleKind::Icon,
                text: "ico".into()
            },
            &PtyEvent::Notification("Claude needs your permission".into()),
            &PtyEvent::Progress {
                state: ProgressState::Indeterminate,
                value: None
            },
            &PtyEvent::Progress {
                state: ProgressState::Normal,
                value: Some(42)
            },
            &PtyEvent::Progress {
                state: ProgressState::Hidden,
                value: None
            },
        ]
    );
    assert!(matches!(run.events.last(), Some(PtyEvent::Exit(_))));
}

#[test]
fn headless_host_answers_terminal_queries() {
    // The child sends DA1 and XTVERSION, then reads both replies.
    let mut cfg = sh("stty raw -echo; printf '\\033[c\\033[>0q'; \
         dd bs=1 count=7 2>/dev/null | od -An -c; \
         dd bs=1 count=20 2>/dev/null | od -An -c");
    cfg.reply_to_terminal_queries = true;
    let s = Session::spawn(cfg).unwrap();
    let run = run_to_exit(&s.events(), T);
    let text = strip_ansi(&run.output);
    assert!(
        text.contains("xterm.js(5.5.0)") || text.contains("x   t   e   r   m"),
        "{text:?}"
    );
    assert!(run
        .events
        .iter()
        .any(|e| matches!(e, PtyEvent::Query(patchroom_pty::TerminalQuery::XtVersion))));
}

#[test]
fn write_after_exit_errors() {
    let s = Session::spawn(sh("true")).unwrap();
    s.wait_exit(T).expect("exit");
    // Writes to a dead pty may succeed once into the kernel buffer; keep
    // trying until the error surfaces.
    let failed = (0..100).any(|_| {
        std::thread::sleep(Duration::from_millis(20));
        s.write(&[0u8; 4096]).is_err()
    });
    assert!(failed);
}

#[test]
fn real_claude_version() {
    let s = Session::spawn(SpawnConfig::new(
        Command::program("claude", ["--version"]),
        "claude-version",
    ))
    .unwrap();
    let run = run_to_exit(&s.events(), Duration::from_secs(60));
    let text = run.text();
    assert!(run.exit.success(), "exit {:?}: {text:?}", run.exit);
    assert!(
        text.contains("Claude Code") && text.chars().any(|c| c.is_ascii_digit()),
        "{text:?}"
    );
}
