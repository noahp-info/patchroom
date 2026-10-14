//! Record a real claude byte stream, captured through the patchroom-pty crate, to a JSONL fixture.
//!
//! Runs `claude --model haiku` in a temp dir with a per-launch `--settings` file, sends one short
//! prompt at 120x40, then resizes to 80x30 and records the redraw. Each line is one JSON object:
//!
//! - `{"k":"size","cols":120,"rows":40}` initial size (first line)
//! - `{"k":"out","t":0.12,"d":"<base64>"}` bytes from `PtyEvent::Output`
//! - `{"k":"resize","cols":80,"rows":30}` the PTY was resized
//! - `{"k":"mark","name":"after-120x40"}` the stream is quiet here; compare screens
//!
//! Usage: `cargo run --release --manifest-path ui/tests/tools/record-fixture/Cargo.toml -- OUT.jsonl`
//! Kills the claude child before exiting.

use std::fmt::Write as _;
use std::time::{Duration, Instant};

use patchroom_pty::{Command, Key, PtyEvent, Session, SpawnConfig};

const PROMPT: &str = "Reply with exactly: ok \u{2705} done";
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Drop CSI, OSC and charset escapes and spaces so patterns match on the visible text.
fn visible(raw: &[u8]) -> String {
    let s = String::from_utf8_lossy(raw);
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\x1b' {
            if !c.is_whitespace() {
                out.push(c);
            }
            continue;
        }
        match it.next() {
            Some('[') => {
                for d in it.by_ref() {
                    if ('@'..='~').contains(&d) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(d) = it.next() {
                    if d == '\x07' {
                        break;
                    }
                    if d == '\x1b' {
                        it.next();
                        break;
                    }
                }
            }
            Some('(' | ')') => {
                it.next();
            }
            _ => {}
        }
    }
    out
}

struct Recorder {
    session: Session,
    events: Vec<String>,
    seen: Vec<u8>,
    start: Instant,
}

impl Recorder {
    /// Read events until `timeout` passes with no output. True when output arrived.
    fn pump(&mut self, timeout: Duration) -> bool {
        let rx = self.session.events();
        match rx.recv_timeout(timeout) {
            Ok(PtyEvent::Output(bytes)) => {
                let mut line = String::new();
                let _ = write!(
                    line,
                    "{{\"k\":\"out\",\"t\":{:.3},\"d\":\"{}\"}}",
                    self.start.elapsed().as_secs_f64(),
                    base64(&bytes)
                );
                self.events.push(line);
                self.seen.extend_from_slice(&bytes);
                true
            }
            Ok(_) => true,
            Err(_) => false,
        }
    }

    fn wait(&mut self, needles: &[&str], timeout: Duration) -> bool {
        let end = Instant::now() + timeout;
        while Instant::now() < end {
            self.pump(Duration::from_millis(100));
            let text = visible(&self.seen);
            if needles.iter().any(|n| text.contains(n)) {
                return true;
            }
        }
        false
    }

    fn quiet(&mut self, secs: f64) {
        let mut end = Instant::now() + Duration::from_secs_f64(secs);
        while Instant::now() < end {
            if self.pump(Duration::from_millis(100)) {
                end = Instant::now() + Duration::from_secs_f64(secs);
            }
        }
    }
}

fn run(out_path: &str) -> Result<(), String> {
    let work = std::env::temp_dir().join(format!("pr-record-{}", std::process::id()));
    let cwd = work.join("proj");
    std::fs::create_dir_all(&cwd).map_err(|e| e.to_string())?;
    let settings = work.join("settings.json");
    std::fs::write(&settings, "{}").map_err(|e| e.to_string())?;

    let args = [
        "--setting-sources".to_owned(),
        "local".to_owned(),
        "--model".to_owned(),
        "haiku".to_owned(),
        "--settings".to_owned(),
        settings.to_string_lossy().into_owned(),
    ];
    let mut cfg = SpawnConfig::new(Command::program("claude", args), "record-fixture");
    cfg.cwd = Some(cwd);
    cfg.cols = 120;
    cfg.rows = 40;
    // No emulator is attached while recording, so the host answers DA1 and XTVERSION like xterm.js.
    cfg.reply_to_terminal_queries = true;
    let session = Session::spawn(cfg).map_err(|e| e.to_string())?;
    let mut rec = Recorder {
        session,
        events: vec!["{\"k\":\"size\",\"cols\":120,\"rows\":40}".to_owned()],
        seen: Vec::new(),
        start: Instant::now(),
    };

    let result = drive(&mut rec);
    let _ = rec.session.kill();
    let _ = std::fs::remove_dir_all(&work);
    result?;

    let bytes = rec.seen.len();
    let mut body = rec.events.join("\n");
    body.push('\n');
    std::fs::write(out_path, body).map_err(|e| e.to_string())?;
    println!("wrote {out_path}: {} events, {bytes} bytes", rec.events.len());
    Ok(())
}

fn drive(rec: &mut Recorder) -> Result<(), String> {
    if rec.wait(&["Itrustthisfolder"], Duration::from_secs(8)) {
        rec.quiet(1.0);
        // "No, exit" is first: move to "Yes, I trust this folder".
        rec.session.send_keys(&[Key::Down]).map_err(|e| e.to_string())?;
        rec.quiet(0.4);
        rec.session.send_keys(&[Key::Enter]).map_err(|e| e.to_string())?;
    }
    if !rec.wait(&["forshortcuts", "Try\""], Duration::from_secs(25)) {
        let tail = visible(&rec.seen);
        let tail: String = tail.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("claude never showed its prompt:\n{tail}"));
    }
    rec.quiet(1.5);
    rec.session.send_text(PROMPT).map_err(|e| e.to_string())?; // bracketed paste, then Enter
    rec.wait(&["ok\u{2705}done", "ok\u{2705}\u{fe0f}done"], Duration::from_secs(60));
    rec.quiet(2.5);
    rec.events.push("{\"k\":\"mark\",\"name\":\"after-120x40\"}".to_owned());
    rec.session.resize(30, 80).map_err(|e| e.to_string())?;
    rec.events.push("{\"k\":\"resize\",\"cols\":80,\"rows\":30}".to_owned());
    rec.quiet(2.5);
    rec.events.push("{\"k\":\"mark\",\"name\":\"after-80x30\"}".to_owned());
    Ok(())
}

fn main() {
    let Some(out) = std::env::args().nth(1) else {
        eprintln!("usage: record-fixture OUT.jsonl");
        std::process::exit(64);
    };
    if let Err(e) = run(&out) {
        eprintln!("{e}");
        std::process::exit(2);
    }
}
