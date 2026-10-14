//! `claude agents --json` through the user's login shell.
//!
//! The bridge's reconciler corrects presence when a hook never fires (for example
//! Esc on a permission prompt: claude sends no Stop hook). A GUI app does not
//! inherit the shell PATH, so `claude` is resolved the same way a DM resolves it:
//! `$SHELL -l -c`.

use std::io::{self, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use patchroom_bridge::agents::parse_agents;
use patchroom_bridge::{AgentEntry, AgentsSource};

/// Agents source that runs `claude agents --json` in a login shell.
///
/// It only runs while `active` is set (some session is busy or waiting), so an
/// idle app never spawns the CLI.
pub struct LoginShellAgents {
    shell: PathBuf,
    timeout: Duration,
    active: Arc<AtomicBool>,
}

impl LoginShellAgents {
    /// Source using `$SHELL` (or `/bin/zsh`), gated on `active`.
    pub fn new(active: Arc<AtomicBool>) -> Self {
        let shell = std::env::var_os("SHELL")
            .filter(|s| !s.is_empty())
            .map_or_else(|| PathBuf::from("/bin/zsh"), PathBuf::from);
        Self {
            shell,
            timeout: Duration::from_secs(10),
            active,
        }
    }
}

impl LoginShellAgents {
    /// A source for one synchronous check right before a spawn: always active, and bounded
    /// by `timeout` (the caller waits at most that long).
    #[must_use]
    pub fn checker(timeout: Duration) -> Self {
        let mut s = Self::new(Arc::new(AtomicBool::new(true)));
        s.timeout = timeout;
        s
    }
}

/// The newest answer the reconciler's `claude agents --json` call produced. The manager reads
/// the `waitingFor` text from it, so a terminal-only wait can say what claude waits for
/// without a second call.
#[derive(Default)]
pub struct AgentsTap {
    latest: Mutex<Option<(Instant, Vec<AgentEntry>)>>,
}

impl AgentsTap {
    /// The entries of the last answer, if it is younger than `max_age`.
    #[must_use]
    pub fn recent(&self, max_age: Duration) -> Option<Vec<AgentEntry>> {
        let g = self.latest.lock().unwrap_or_else(PoisonError::into_inner);
        g.as_ref()
            .filter(|(at, _)| at.elapsed() <= max_age)
            .map(|(_, v)| v.clone())
    }
}

/// An [`AgentsSource`] that records each successful answer in an [`AgentsTap`].
pub struct TappedAgents<S> {
    /// The real source.
    pub inner: S,
    /// Where answers are recorded.
    pub tap: Arc<AgentsTap>,
}

impl<S: AgentsSource> AgentsSource for TappedAgents<S> {
    fn list(&self) -> io::Result<Vec<AgentEntry>> {
        let entries = self.inner.list()?;
        *self
            .tap
            .latest
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some((Instant::now(), entries.clone()));
        Ok(entries)
    }
}

impl AgentsSource for LoginShellAgents {
    fn list(&self) -> io::Result<Vec<AgentEntry>> {
        if !self.active.load(Ordering::SeqCst) {
            return Ok(Vec::new());
        }
        let mut cmd = Command::new(&self.shell);
        // `exec` so a timeout kill reaches claude itself, not just the shell.
        cmd.args(["-l", "-c", "exec claude agents --json"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (k, _) in std::env::vars_os() {
            if k.to_string_lossy().starts_with("CLAUDE") {
                cmd.env_remove(k);
            }
        }
        let mut child = cmd.spawn()?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("no stdout pipe"))?;
        let reader = thread::spawn(move || {
            let mut s = String::new();
            let _ = stdout.read_to_string(&mut s);
            s
        });
        let start = Instant::now();
        let status = loop {
            if let Some(st) = child.try_wait()? {
                break st;
            }
            // Gate dropped (app quitting, or nothing left to watch): stop now.
            if start.elapsed() > self.timeout || !self.active.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "claude agents timed out",
                ));
            }
            thread::sleep(Duration::from_millis(25));
        };
        let out = reader.join().unwrap_or_default();
        if !status.success() {
            return Err(io::Error::other(format!(
                "claude agents exited with {status}"
            )));
        }
        parse_agents(json_array(&out)).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
}

/// The JSON array in `out`. Login shell profiles may print text around it.
fn json_array(out: &str) -> &str {
    match (out.find('['), out.rfind(']')) {
        (Some(a), Some(b)) if a < b => &out[a..=b],
        _ => out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_array_skips_profile_noise() {
        assert_eq!(json_array("hello\n[{\"pid\":1}]\nbye"), "[{\"pid\":1}]");
        assert_eq!(json_array("[]"), "[]");
        assert_eq!(json_array("nothing"), "nothing");
    }

    struct Fixed(Vec<AgentEntry>);
    impl AgentsSource for Fixed {
        fn list(&self) -> io::Result<Vec<AgentEntry>> {
            Ok(self.0.clone())
        }
    }

    #[test]
    fn the_tap_keeps_the_newest_answer() {
        let entries = parse_agents(
            r#"[{"pid":9,"sessionId":"s","status":"waiting","waitingFor":"dialog open"}]"#,
        )
        .unwrap();
        let tap = Arc::new(AgentsTap::default());
        assert!(tap.recent(Duration::from_secs(60)).is_none());
        let src = TappedAgents {
            inner: Fixed(entries.clone()),
            tap: Arc::clone(&tap),
        };
        assert_eq!(src.list().unwrap(), entries);
        let seen = tap.recent(Duration::from_secs(60)).unwrap();
        assert_eq!(seen[0].waiting_for.as_deref(), Some("dialog open"));
    }

    #[test]
    fn inactive_source_never_spawns() {
        let src = LoginShellAgents {
            shell: PathBuf::from("/nonexistent/shell"),
            timeout: Duration::from_secs(1),
            active: Arc::new(AtomicBool::new(false)),
        };
        assert!(src.list().unwrap().is_empty());
    }
}
