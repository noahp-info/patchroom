//! `patchroom-statusline`: Patchroom's statusLine wrapper.
//!
//! Claude Code runs this in place of the user's own `statusLine` (Patchroom registers it
//! through the per-launch `--settings`). On every render it:
//!
//! 1. reads the statusLine JSON claude writes to stdin;
//! 2. looks up the user's own `statusLine` command the way claude resolves settings
//!    (project local, project, user; read only, see `patchroom_bridge::statusline`);
//! 3. runs that command unchanged through `sh -c` with the same stdin bytes;
//! 4. prints its stdout bytes unchanged, so the TUI shows exactly what it would have;
//! 5. tees the stdin JSON and the output to the bridge socket for the chat status strip.
//!
//! With no user statusLine it prints nothing and the TUI shows no status line. It never
//! writes any file, never prints on stderr, and always exits 0 on its own: the user
//! command is killed after [`USER_TIMEOUT`].
//!
//! Usage: `patchroom-statusline --socket <path> [--session-key <key>]`.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use patchroom_bridge::protocol::{self, ClientMessage};
use patchroom_bridge::statusline::{
    config_dir, project_dirs_from_payload, resolve_user_status_line,
};
use serde_json::Value;

/// Longest the wrapper waits for claude to finish writing stdin.
const STDIN_TIMEOUT: Duration = Duration::from_secs(3);
/// Longest the user's command may run before it is killed.
const USER_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq, Eq)]
struct Args {
    socket: Option<PathBuf>,
    session_key: Option<String>,
}

fn parse_args<I: Iterator<Item = String>>(
    mut it: I,
    env_socket: Option<String>,
    env_session: Option<String>,
) -> Args {
    let mut args = Args {
        socket: env_socket.filter(|s| !s.is_empty()).map(PathBuf::from),
        session_key: env_session.filter(|s| !s.is_empty()),
    };
    while let Some(a) = it.next() {
        match a.as_str() {
            "--socket" => args.socket = it.next().map(PathBuf::from),
            "--session-key" => args.session_key = it.next().filter(|s| !s.is_empty()),
            _ => {}
        }
    }
    args
}

fn read_stdin_bounded() -> Option<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let r = std::io::stdin().read_to_end(&mut buf);
        let _ = tx.send(r.ok().map(|_| buf));
    });
    rx.recv_timeout(STDIN_TIMEOUT).ok().flatten()
}

/// Run `command` through `sh -c` with `input` on stdin. Returns its stdout bytes.
/// The command gets the wrapper's own cwd and environment, like claude's call would.
fn run_user_command(command: &str, input: &[u8], timeout: Duration) -> Vec<u8> {
    let Ok(mut child) = Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
    else {
        return Vec::new();
    };
    let pid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        let data = input.to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
    }
    let (tx, rx) = mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    }
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) if Instant::now() >= deadline => {
                // Kill the whole group so no grandchild keeps the pipes open.
                let _ = Command::new("/bin/kill")
                    .args(["-KILL", &format!("-{pid}")])
                    .stderr(Stdio::null())
                    .status();
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    rx.recv_timeout(Duration::from_millis(500))
        .unwrap_or_default()
}

/// Best-effort tee to the bridge. Never waits for a reply.
fn tee(
    socket: &Path,
    session_key: Option<String>,
    payload: Value,
    output: &[u8],
    api_local: Option<bool>,
) {
    let Ok(mut stream) = UnixStream::connect(socket) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    let msg = ClientMessage::Statusline {
        session_key,
        payload,
        output: String::from_utf8_lossy(output).into_owned(),
        api_local,
    };
    let _ = protocol::write_frame(&mut stream, &msg);
}

fn run() -> Vec<u8> {
    let args = parse_args(
        std::env::args().skip(1),
        std::env::var("PATCHROOM_BRIDGE_SOCKET").ok(),
        std::env::var("PATCHROOM_SESSION").ok(),
    );
    // Last line of defence: leave even if a syscall hangs.
    std::thread::spawn(|| {
        std::thread::sleep(STDIN_TIMEOUT + USER_TIMEOUT + Duration::from_secs(2));
        std::process::exit(0);
    });
    let Some(input) = read_stdin_bounded() else {
        return Vec::new();
    };
    let payload: Value = serde_json::from_slice(&input).unwrap_or(Value::Null);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let cfg = config_dir(
        std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref(),
        home.as_deref(),
    );
    let spec = resolve_user_status_line(&project_dirs_from_payload(&payload), cfg.as_deref());
    let output = spec.map_or_else(Vec::new, |s| {
        run_user_command(&s.command, &input, USER_TIMEOUT)
    });
    if let Some(socket) = &args.socket {
        // Claude passes its effective env (settings `env` included) to this command, so the
        // base URL here is the one the CLI uses. Only "is it local" leaves the process.
        let api_local = Some(
            std::env::var("ANTHROPIC_BASE_URL")
                .ok()
                .is_some_and(|u| patchroom_bridge::statusline::is_local_base_url(&u)),
        );
        tee(socket, args.session_key, payload, &output, api_local);
    }
    output
}

fn main() -> ExitCode {
    let output = run();
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&output);
    let _ = out.flush();
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> impl Iterator<Item = String> {
        v.iter()
            .map(|s| (*s).to_owned())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn parses_flags_and_env_fallbacks() {
        let p = parse_args(a(&["--socket", "/s", "--session-key", "dm-1"]), None, None);
        assert_eq!(
            p,
            Args {
                socket: Some("/s".into()),
                session_key: Some("dm-1".into())
            }
        );
        let p = parse_args(a(&[]), Some("/env".into()), Some("k".into()));
        assert_eq!(p.socket, Some("/env".into()));
        assert_eq!(p.session_key.as_deref(), Some("k"));
    }

    #[test]
    fn user_command_gets_stdin_and_output_is_verbatim() {
        let out = run_user_command(
            "cat; printf '\\033[1mbold\\033[0m'",
            b"{\"a\":1}",
            Duration::from_secs(5),
        );
        assert_eq!(out, b"{\"a\":1}\x1b[1mbold\x1b[0m");
    }

    #[test]
    fn slow_user_command_is_killed() {
        let t0 = Instant::now();
        let out = run_user_command("sleep 30; echo late", b"", Duration::from_millis(200));
        assert!(t0.elapsed() < Duration::from_secs(3));
        assert!(out.is_empty());
    }
}
