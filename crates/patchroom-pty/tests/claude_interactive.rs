//! Gated real-claude test. Run with `cargo test -p patchroom-pty -- --ignored`.
//!
//! Starts an interactive haiku session in a temp cwd with local settings only,
//! sends one tiny prompt through `send_text`, expects the answer, and kills
//! the process.

mod common;

use std::time::{Duration, Instant};

use common::strip_ansi;
use patchroom_pty::{Command, Key, ProgressState, PtyEvent, Session, SpawnConfig};

#[test]
#[ignore = "drives the real claude CLI and spends a few haiku tokens"]
fn interactive_haiku_replies() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = SpawnConfig::new(
        Command::program("claude", ["--setting-sources", "local", "--model", "haiku"]),
        "claude-interactive",
    );
    cfg.cwd = Some(dir.path().to_path_buf());
    // Headless host: no emulator is attached, so answer DA1/XTVERSION here.
    cfg.reply_to_terminal_queries = true;
    let s = Session::spawn(cfg).unwrap();
    let rx = s.events();

    let mut screen = Vec::<u8>::new();
    let mut last_output = Instant::now();
    let mut trust_answered = false;
    let start = Instant::now();

    // Phase 1: wait for the TUI to go quiet at its prompt.
    loop {
        assert!(
            start.elapsed() < Duration::from_secs(90),
            "TUI never settled: {:?}",
            tail(&screen)
        );
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(PtyEvent::Output(b)) => {
                screen.extend(b);
                last_output = Instant::now();
            }
            Ok(PtyEvent::Exit(e)) => panic!("claude exited early: {e:?} {:?}", tail(&screen)),
            Ok(_) | Err(_) => {}
        }
        let text = strip_ansi(&screen);
        if !trust_answered
            && text.contains("Yes, I trust this folder")
            && last_output.elapsed() > Duration::from_millis(500)
        {
            // First-run folder trust dialog for the temp cwd. "No, exit" is
            // pre-selected, so move down to "Yes" and confirm.
            s.send_keys(&[Key::Down]).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            s.send_keys(&[Key::Enter]).unwrap();
            trust_answered = true;
            screen.clear();
            last_output = Instant::now();
            continue;
        }
        if text.contains("shift+tab") && last_output.elapsed() > Duration::from_millis(1500) {
            break;
        }
    }

    screen.clear();
    s.send_text("What is 7 times 6? Reply with only the number.")
        .unwrap();

    // Phase 2: wait for the answer, which the prompt echo does not contain.
    let mut busy_seen = false;
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut found = false;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(PtyEvent::Output(b)) => screen.extend(b),
            Ok(PtyEvent::Progress {
                state: ProgressState::Indeterminate,
                ..
            }) => busy_seen = true,
            Ok(PtyEvent::Exit(e)) => panic!("claude exited: {e:?}"),
            _ => {}
        }
        if strip_ansi(&screen).contains("42") {
            found = true;
            break;
        }
    }
    let result = (found, busy_seen, tail(&screen));
    s.kill().unwrap();
    assert!(result.0, "no reply seen: {:?}", result.2);
    assert!(s.exit_info().is_some());
}

fn tail(bytes: &[u8]) -> String {
    let t = strip_ansi(bytes);
    let n = t.len().saturating_sub(1200);
    t[t.char_indices()
        .map(|(i, _)| i)
        .find(|&i| i >= n)
        .unwrap_or(0)..]
        .to_owned()
}
