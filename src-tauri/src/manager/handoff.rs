//! Moving a mirrored session into Patchroom: "Show in <terminal>" and "End it there".
//!
//! - `session_mirror_reveal {id}` brings the other terminal's window and tab to the front, so
//!   the user can close the session there. iTerm and Terminal are matched by the process tty;
//!   other known terminals are only activated.
//! - `session_mirror_end {id}` stops the other process for the user, who confirmed it in the
//!   UI. It refuses unless a fresh `claude agents --json` says the session is idle, the pid is
//!   known and its command line is still claude. It arms "take over when it closes", sends
//!   SIGTERM once (never SIGKILL), and waits for the mirror monitor to resume the session
//!   here. The transcript is on disk, so the resume picks up where the other copy stopped.
//!
//! This is the only place Patchroom signals a process it did not start, and only on that
//! explicit request.

use std::sync::Arc;
use std::time::{Duration, Instant};

use patchroom_bridge::Status as BridgeStatus;

use super::mirror::LiveCheck;
use super::{lock, Error, Manager, Result, SessionInfo};

/// How long `session_mirror_end` waits for the other process to exit after SIGTERM.
const END_EXIT_WAIT: Duration = Duration::from_secs(5);
/// How long it then waits for the monitor to resume the session here.
const END_RESUME_WAIT: Duration = Duration::from_secs(8);

/// The OS side of a hand-off. Replaced in tests so nothing real is focused or signaled.
pub trait TerminalOps: Send + Sync {
    /// Bring the terminal that hosts `pid` to the front, on its tab when possible.
    ///
    /// # Errors
    /// The terminal could not be found or scripted.
    fn reveal(&self, pid: u32, place: &str) -> std::result::Result<(), String>;
    /// The full command line of `pid`, or `None` when it is not running.
    fn command_of(&self, pid: u32) -> Option<String>;
    /// Send SIGTERM to `pid`.
    ///
    /// # Errors
    /// The signal could not be sent.
    fn terminate(&self, pid: u32) -> std::result::Result<(), String>;
    /// Is `pid` still running?
    fn alive(&self, pid: u32) -> bool;
}

/// The real macOS implementation: `ps`, `kill` and `osascript`.
pub struct SystemTerminalOps;

impl TerminalOps for SystemTerminalOps {
    fn reveal(&self, pid: u32, place: &str) -> std::result::Result<(), String> {
        let tty = tty_of(pid);
        let script = match (place, tty.as_deref()) {
            ("iTerm", Some(t)) => iterm_script(t),
            ("Terminal", Some(t)) => terminal_script(t),
            _ => {
                let id = bundle_id(place)
                    .ok_or_else(|| format!("can't bring {place} to the front from here"))?;
                format!("tell application id \"{id}\" to activate")
            }
        };
        let out = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
        }
    }

    fn command_of(&self, pid: u32) -> Option<String> {
        let out = std::process::Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        (out.status.success() && !text.is_empty()).then_some(text)
    }

    fn terminate(&self, pid: u32) -> std::result::Result<(), String> {
        let st = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if st.success() {
            Ok(())
        } else {
            Err(format!("could not signal pid {pid}"))
        }
    }

    fn alive(&self, pid: u32) -> bool {
        self.command_of(pid).is_some()
    }
}

/// `ttys012` for `pid`, as `/dev/ttys012`. `None` without a terminal.
fn tty_of(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-o", "tty=", "-p", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let t = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (!t.is_empty() && !t.starts_with('?')).then(|| format!("/dev/{t}"))
}

/// Select the iTerm window, tab and split whose tty is `tty`, then activate iTerm.
fn iterm_script(tty: &str) -> String {
    format!(
        r#"tell application id "com.googlecode.iterm2"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "{tty}" then
          select w
          tell t to select
          tell s to select
          return
        end if
      end repeat
    end repeat
  end repeat
end tell"#
    )
}

/// Select the Terminal tab whose tty is `tty` and raise its window.
fn terminal_script(tty: &str) -> String {
    format!(
        r#"tell application id "com.apple.Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "{tty}" then
        set selected of t to true
        set index of w to 1
        return
      end if
    end repeat
  end repeat
end tell"#
    )
}

/// Bundle id of a terminal named by [`super::mirror::terminal_of`]. `None` for multiplexers
/// and unknown hosts, which have no window of their own.
fn bundle_id(place: &str) -> Option<&'static str> {
    Some(match place {
        "iTerm" => "com.googlecode.iterm2",
        "Terminal" => "com.apple.Terminal",
        "Ghostty" => "com.mitchellh.ghostty",
        "WezTerm" => "com.github.wez.wezterm",
        "Alacritty" => "org.alacritty",
        "kitty" => "net.kovidgoyal.kitty",
        "Warp" => "dev.warp.Warp-Stable",
        "Hyper" => "co.zeit.hyper",
        "VS Code" => "com.microsoft.VSCode",
        "Cursor" => "com.todesktop.230313mzl4w4u92",
        _ => return None,
    })
}

impl Manager {
    /// Replace the OS side of the hand-off (tests). `None` goes back to the real one.
    pub fn set_terminal_ops_override(&self, ops: Option<Arc<dyn TerminalOps>>) {
        *lock(&self.terminal_ops) = ops;
    }

    fn ops(&self) -> Arc<dyn TerminalOps> {
        lock(&self.terminal_ops)
            .clone()
            .unwrap_or_else(|| Arc::new(SystemTerminalOps))
    }

    /// `session_mirror_reveal {id}`: bring the other terminal to the front.
    ///
    /// # Errors
    /// Not a mirror, the pid is unknown, or the terminal could not be scripted.
    pub fn mirror_reveal(&self, id: &str) -> Result<()> {
        let info = self
            .mirror_of(id)
            .ok_or_else(|| Error::Invalid("this DM is not a read-only mirror".into()))?;
        if info.pid == 0 {
            return Err(Error::Invalid(format!(
                "can't tell which window runs it; switch to {} yourself",
                info.place
            )));
        }
        self.ops()
            .reveal(info.pid, &info.place)
            .map_err(|e| Error::Invalid(format!("couldn't open {}: {e}", info.place)))
    }

    /// `session_mirror_end {id, cols?, rows?} -> SessionInfo`: stop the other copy and resume
    /// the session here. Only while that copy is idle. See the module docs.
    ///
    /// # Errors
    /// Not a mirror, the check failed, the other copy is busy or unidentifiable, the signal
    /// failed, or it did not exit in time (it then still opens here once it does).
    pub fn mirror_end(
        self: &Arc<Self>,
        id: &str,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<SessionInfo> {
        let place = self
            .mirror_of(id)
            .ok_or_else(|| Error::Invalid("this DM is not a read-only mirror".into()))?
            .place;
        let sid = self
            .conversation(id)?
            .session_id
            .ok_or_else(|| Error::Invalid("this DM has no claude session id".into()))?;
        let pid = match self.live_check(&sid) {
            // Already gone: an ordinary take-over.
            LiveCheck::Free => return self.takeover(id, cols, rows),
            LiveCheck::Unknown(why) => return Err(Error::CheckFailed(why)),
            LiveCheck::Live { pid, status, .. } => {
                if pid == 0 {
                    return Err(Error::Invalid(format!(
                        "can't tell which process runs it; close it in {place} yourself"
                    )));
                }
                if status != Some(BridgeStatus::Idle) {
                    return Err(Error::Invalid(format!(
                        "it's not idle in {place}; wait until it finishes, or close it there"
                    )));
                }
                pid
            }
        };
        let ops = self.ops();
        // The pid may have been reused since the CLI listed it: only ever signal claude.
        let is_claude = ops
            .command_of(pid)
            .is_some_and(|c| c.to_lowercase().contains("claude"));
        if !is_claude {
            return Err(Error::Invalid(format!(
                "pid {pid} is no longer claude; not stopping it"
            )));
        }
        // The monitor resumes it here once the process is gone, also if that takes longer
        // than this call waits.
        self.set_mirror_takeover(id, true)?;
        ops.terminate(pid).map_err(Error::Invalid)?;

        let end = Instant::now() + END_EXIT_WAIT;
        while ops.alive(pid) {
            if Instant::now() >= end {
                return Err(Error::Invalid(format!(
                    "asked it to close, but it still runs in {place}; it opens here as soon as it closes"
                )));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let end = Instant::now() + END_RESUME_WAIT;
        while self.mirror_of(id).is_some() {
            if Instant::now() >= end {
                return Err(Error::Invalid(format!(
                    "it closed in {place}; opening it here shortly"
                )));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        self.list()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| Error::NoSession(id.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_match_the_tab_by_tty() {
        let s = iterm_script("/dev/ttys012");
        assert!(s.contains("com.googlecode.iterm2"));
        assert!(s.contains(r#"if tty of s is "/dev/ttys012""#));
        let t = terminal_script("/dev/ttys003");
        assert!(t.contains("com.apple.Terminal"));
        assert!(t.contains(r#"if tty of t is "/dev/ttys003""#));
    }

    #[test]
    fn multiplexers_have_no_window_to_raise() {
        assert_eq!(bundle_id("iTerm"), Some("com.googlecode.iterm2"));
        assert_eq!(bundle_id("tmux"), None);
        assert_eq!(bundle_id("another terminal"), None);
    }
}
