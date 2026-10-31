//! `patchroom-hook`: forwards one CLI hook invocation to the Patchroom bridge socket.
//!
//! Reads the hook JSON on stdin, sends it to the bridge, waits a bounded time for the
//! reply and prints the bridge's decision (if any) on stdout.
//!
//! Rules this binary keeps:
//!
//! * It always exits on its own: on a decision, on a bridge cancel, on bridge EOF, when
//!   the bridge is absent, or when its own wait deadline passes. A watchdog thread
//!   enforces the deadline even if a read hangs. It never relies on SIGTERM.
//! * It fails open. On any error it prints nothing and exits 0, so the CLI's TUI decides.
//! * It prints nothing on stderr, because the CLI may surface hook stderr to the user.
//!
//! Usage: `patchroom-hook --socket <path> [--wait-ms <n>] [--session-key <key>]`.
//! `PATCHROOM_BRIDGE_SOCKET` and `PATCHROOM_SESSION` are fallbacks for the first and last.
//!
//! Browser mode: `patchroom-hook <http(s) url>`. Patchroom sets `BROWSER` to this binary for
//! the sessions it launches, so a URL the CLI opens goes to Patchroom (viewer or browser, by
//! the user's Links preference). Without a bridge it opens the URL in the system browser.

use std::io::{BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::parent_id;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use patchroom_bridge::protocol::{self, ClientMessage, ServerMessage};
use serde_json::Value;

/// Default wait when `--wait-ms` is absent.
const DEFAULT_WAIT_MS: u64 = 2_000;
/// Longest accepted `--wait-ms`: 30 days. Questions are held for days (the bridge's
/// `ASK_HOLD`); anything longer is a typo, and clamping keeps the deadline math finite.
const MAX_WAIT_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// Longest the hook waits for the CLI to close stdin.
const STDIN_TIMEOUT: Duration = Duration::from_secs(3);
/// The watchdog fires this long after the wait deadline.
const WATCHDOG_GRACE: Duration = Duration::from_millis(1_500);

#[derive(Debug, PartialEq, Eq)]
struct Args {
    socket: Option<PathBuf>,
    wait_ms: u64,
    session_key: Option<String>,
}

fn parse_args<I: Iterator<Item = String>>(
    mut it: I,
    env_socket: Option<String>,
    env_session: Option<String>,
) -> Args {
    let mut args = Args {
        socket: env_socket.filter(|s| !s.is_empty()).map(PathBuf::from),
        wait_ms: DEFAULT_WAIT_MS,
        session_key: env_session.filter(|s| !s.is_empty()),
    };
    while let Some(a) = it.next() {
        match a.as_str() {
            "--socket" => args.socket = it.next().map(PathBuf::from),
            "--wait-ms" => {
                if let Some(n) = it.next().and_then(|v| v.parse::<u64>().ok()) {
                    args.wait_ms = n.min(MAX_WAIT_MS);
                }
            }
            "--session-key" => args.session_key = it.next().filter(|s| !s.is_empty()),
            _ => {}
        }
    }
    args
}

fn read_stdin_bounded() -> Option<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let r = std::io::stdin().read_to_string(&mut s);
        let _ = tx.send(r.ok().map(|_| s));
    });
    rx.recv_timeout(STDIN_TIMEOUT).ok().flatten()
}

/// Talk to the bridge. Returns the JSON to print, if any.
fn exchange(args: &Args, payload: Value, deadline: Instant) -> Option<Value> {
    let socket = args.socket.as_ref()?;
    let mut stream = UnixStream::connect(socket).ok()?;
    let remaining = |d: Instant| d.saturating_duration_since(Instant::now());
    // macOS returns EINVAL for socket timeouts once the peer closed. Never fail on that:
    // the reply may already be buffered.
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let msg = ClientMessage::Hook {
        session_key: args.session_key.clone(),
        hook_pid: std::process::id(),
        ppid: parent_id(),
        wait_ms: args.wait_ms,
        payload,
    };
    protocol::write_frame(&mut stream, &msg).ok()?;
    let timeout = remaining(deadline).max(Duration::from_millis(1));
    let _ = stream.set_read_timeout(Some(timeout));
    let mut reader = BufReader::new(&stream);
    let line = protocol::read_line(&mut reader).ok()??;
    match protocol::parse_server_line(&line).ok()? {
        ServerMessage::Decision { output, .. } => output,
        ServerMessage::Ack | ServerMessage::Cancel { .. } | ServerMessage::Error { .. } => None,
    }
}

fn run() -> Option<Value> {
    let args = parse_args(
        std::env::args().skip(1),
        std::env::var("PATCHROOM_BRIDGE_SOCKET").ok(),
        std::env::var("PATCHROOM_SESSION").ok(),
    );
    let deadline = Instant::now() + Duration::from_millis(args.wait_ms) + STDIN_TIMEOUT;
    // Last line of defence: leave even if a syscall hangs.
    std::thread::spawn(move || {
        std::thread::sleep(deadline.saturating_duration_since(Instant::now()) + WATCHDOG_GRACE);
        std::process::exit(0);
    });
    let input = read_stdin_bounded()?;
    let payload: Value = serde_json::from_str(&input).ok()?;
    let wait_deadline = Instant::now() + Duration::from_millis(args.wait_ms);
    exchange(&args, payload, wait_deadline)
}

/// The URL when invoked as `$BROWSER <url>`.
fn browser_url<I: Iterator<Item = String>>(mut it: I) -> Option<String> {
    let first = it.next()?;
    (first.starts_with("https://") || first.starts_with("http://")).then_some(first)
}

/// Hand a URL to Patchroom; open it in the system browser when Patchroom does not take it.
fn open_url(url: &str) {
    let socket = std::env::var("PATCHROOM_BRIDGE_SOCKET")
        .ok()
        .filter(|s| !s.is_empty());
    let taken = socket.is_some_and(|path| {
        let Ok(mut stream) = UnixStream::connect(path) else {
            return false;
        };
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let msg = ClientMessage::OpenUrl {
            session_key: std::env::var("PATCHROOM_SESSION")
                .ok()
                .filter(|s| !s.is_empty()),
            url: url.to_owned(),
        };
        if protocol::write_frame(&mut stream, &msg).is_err() {
            return false;
        }
        let mut reader = BufReader::new(&stream);
        matches!(
            protocol::read_line(&mut reader)
                .ok()
                .flatten()
                .and_then(|l| protocol::parse_server_line(&l).ok()),
            Some(ServerMessage::Ack)
        )
    });
    if !taken {
        let _ = std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status();
    }
}

fn main() -> ExitCode {
    if let Some(url) = browser_url(std::env::args().skip(1)) {
        open_url(&url);
        return ExitCode::SUCCESS;
    }
    if let Some(output) = run() {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{output}");
        let _ = out.flush();
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> impl Iterator<Item = String> {
        v.iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn parses_flags() {
        let p = parse_args(
            a(&[
                "--socket",
                "/s",
                "--wait-ms",
                "500",
                "--session-key",
                "dm-1",
            ]),
            None,
            None,
        );
        assert_eq!(
            p,
            Args {
                socket: Some("/s".into()),
                wait_ms: 500,
                session_key: Some("dm-1".into())
            }
        );
    }

    #[test]
    fn env_is_the_fallback_and_flags_win() {
        let p = parse_args(
            a(&["--socket", "/flag"]),
            Some("/env".into()),
            Some("k".into()),
        );
        assert_eq!(p.socket, Some("/flag".into()));
        assert_eq!(p.session_key.as_deref(), Some("k"));
        assert_eq!(p.wait_ms, DEFAULT_WAIT_MS);
        let p = parse_args(a(&[]), Some("/env".into()), None);
        assert_eq!(p.socket, Some("/env".into()));
    }

    #[test]
    fn junk_flags_are_ignored() {
        let p = parse_args(a(&["--wait-ms", "abc", "--nope", "--socket"]), None, None);
        assert_eq!(p.wait_ms, DEFAULT_WAIT_MS);
        assert_eq!(p.socket, None);
    }

    #[test]
    fn overlong_waits_are_clamped() {
        let p = parse_args(a(&["--wait-ms", &u64::MAX.to_string()]), None, None);
        assert_eq!(p.wait_ms, MAX_WAIT_MS);
        // The bridge's question hold fits under the clamp.
        let hold = patchroom_bridge::ASK_HOLD.as_millis() as u64;
        assert!(hold < MAX_WAIT_MS);
    }

    #[test]
    fn browser_mode_takes_a_web_url_first_argument_only() {
        assert_eq!(
            browser_url(a(&["https://claude.ai/artifact/x"])),
            Some("https://claude.ai/artifact/x".into())
        );
        assert_eq!(browser_url(a(&["--socket", "/tmp/s"])), None);
        assert_eq!(browser_url(a(&["file:///etc/passwd"])), None);
        assert_eq!(browser_url(a(&[])), None);
    }
}
