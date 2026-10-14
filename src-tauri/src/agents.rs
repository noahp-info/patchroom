//! `claude agents --json` through the user's login shell.
//!
//! The bridge's reconciler corrects presence when a hook never fires (for example
//! Esc on a permission prompt: claude sends no Stop hook). A GUI app does not
//! inherit the shell PATH, so `claude` is resolved the same way a DM resolves it:
//! `$SHELL -l -c`.

use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
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
        Self {
            shell: default_shell(),
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
    /// When set and cleared, the inner source answers "nothing" without asking claude, so
    /// that empty answer must not be recorded as a real one.
    pub gate: Option<Arc<AtomicBool>>,
}

impl<S: AgentsSource> AgentsSource for TappedAgents<S> {
    fn list(&self) -> io::Result<Vec<AgentEntry>> {
        let entries = self.inner.list()?;
        if self
            .gate
            .as_ref()
            .is_some_and(|g| !g.load(Ordering::SeqCst))
        {
            return Ok(entries);
        }
        *self
            .tap
            .latest
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some((Instant::now(), entries.clone()));
        Ok(entries)
    }
}

/// The login shell's environment and the `claude` binary found on its PATH, captured once
/// per process. Running the binary directly skips a login shell start (about 0.6 s, more
/// under load) on every check.
#[derive(Debug)]
pub struct LoginEnv {
    /// Absolute path of the `claude` binary.
    pub claude: PathBuf,
    /// The login shell's variables (without `CLAUDE*`).
    pub vars: Vec<(OsString, OsString)>,
}

static LOGIN_ENV: Mutex<Option<Arc<LoginEnv>>> = Mutex::new(None);

/// The cached [`LoginEnv`], captured on first use with one login shell run. A failure is
/// not cached, so the next call tries again.
#[must_use]
pub fn login_env(shell: &Path) -> Option<Arc<LoginEnv>> {
    if let Some(e) = LOGIN_ENV
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
    {
        return Some(e);
    }
    let mut cmd = Command::new(shell);
    cmd.args(["-l", "-c", "exec env -0"]);
    let raw = run_bounded(cmd, Duration::from_secs(10), None).ok()?;
    let found = parse_login_env(&raw)?;
    let found = Arc::new(found);
    *LOGIN_ENV.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(&found));
    Some(found)
}

/// Capture the login environment now, off the caller's thread, so the first check is fast.
pub fn warm_up() {
    let shell = default_shell();
    thread::spawn(move || {
        let _ = login_env(&shell);
    });
}

fn default_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .map_or_else(|| PathBuf::from("/bin/zsh"), PathBuf::from)
}

/// Parse `env -0` output and locate `claude` on its PATH.
fn parse_login_env(raw: &str) -> Option<LoginEnv> {
    let mut vars = Vec::new();
    for item in raw.split('\0') {
        if let Some((k, v)) = item.split_once('=') {
            if !k.is_empty() && !k.starts_with("CLAUDE") {
                vars.push((OsString::from(k), OsString::from(v)));
            }
        }
    }
    let path = vars.iter().find(|(k, _)| k == "PATH")?.1.clone();
    let claude = std::env::split_paths(&path)
        .map(|d| d.join("claude"))
        .find(|p| is_executable(p))?;
    Some(LoginEnv { claude, vars })
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Run `cmd`, return its stdout. Killed at `timeout`, or as soon as `gate` is cleared.
fn run_bounded(
    mut cmd: Command,
    timeout: Duration,
    gate: Option<&AtomicBool>,
) -> io::Result<String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("no stdout pipe"))?;
    let reader = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });
    let start = Instant::now();
    let status = loop {
        if let Some(st) = child.try_wait()? {
            break st;
        }
        // Gate dropped (app quitting, or nothing left to watch): stop now.
        if start.elapsed() > timeout || gate.is_some_and(|g| !g.load(Ordering::SeqCst)) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "claude agents timed out",
            ));
        }
        thread::sleep(Duration::from_millis(10));
    };
    let out = reader.join().unwrap_or_default();
    if !status.success() {
        return Err(io::Error::other(format!("exited with {status}")));
    }
    Ok(out)
}

impl AgentsSource for LoginShellAgents {
    fn list(&self) -> io::Result<Vec<AgentEntry>> {
        if !self.active.load(Ordering::SeqCst) {
            return Ok(Vec::new());
        }
        let cached = login_env(&self.shell);
        let mut cmd;
        if let Some(env) = cached.as_deref() {
            cmd = Command::new(&env.claude);
            cmd.args(["agents", "--json"]);
            for (k, v) in &env.vars {
                cmd.env(k, v);
            }
        } else {
            cmd = Command::new(&self.shell);
            // `exec` so a timeout kill reaches claude itself, not just the shell.
            cmd.args(["-l", "-c", "exec claude agents --json"]);
        }
        for (k, _) in std::env::vars_os() {
            if k.to_string_lossy().starts_with("CLAUDE") {
                cmd.env_remove(k);
            }
        }
        let out = run_bounded(cmd, self.timeout, Some(&self.active)).map_err(|e| {
            if cached.is_some() && e.kind() == io::ErrorKind::NotFound {
                // The binary moved (an update): capture the environment again next time.
                *LOGIN_ENV.lock().unwrap_or_else(PoisonError::into_inner) = None;
            }
            if e.kind() == io::ErrorKind::TimedOut {
                e
            } else {
                io::Error::other(format!("claude agents {e}"))
            }
        })?;
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

/// The source for the synchronous pre-spawn check. It reuses an answer younger than
/// [`CheckSource::FRESH`] from the same tap, and retries once when the call fails.
pub struct CheckSource<S> {
    /// The real source.
    pub inner: S,
    /// Shared with the reconciler's source.
    pub tap: Arc<AgentsTap>,
}

impl<S> CheckSource<S> {
    /// Answers younger than this are reused.
    pub const FRESH: Duration = Duration::from_secs(2);
}

impl<S: AgentsSource> AgentsSource for CheckSource<S> {
    fn list(&self) -> io::Result<Vec<AgentEntry>> {
        if let Some(v) = self.tap.recent(Self::FRESH) {
            return Ok(v);
        }
        let run = || {
            let v = self.inner.list()?;
            *self
                .tap
                .latest
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some((Instant::now(), v.clone()));
            Ok(v)
        };
        run().or_else(|_| run())
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
            gate: None,
        };
        assert_eq!(src.list().unwrap(), entries);
        let seen = tap.recent(Duration::from_secs(60)).unwrap();
        assert_eq!(seen[0].waiting_for.as_deref(), Some("dialog open"));
    }

    #[test]
    fn an_idle_gate_records_nothing() {
        let tap = Arc::new(AgentsTap::default());
        let gate = Arc::new(AtomicBool::new(false));
        let src = TappedAgents {
            inner: Fixed(Vec::new()),
            tap: Arc::clone(&tap),
            gate: Some(Arc::clone(&gate)),
        };
        src.list().unwrap();
        assert!(tap.recent(Duration::from_secs(60)).is_none());
        gate.store(true, Ordering::SeqCst);
        src.list().unwrap();
        assert!(tap.recent(Duration::from_secs(60)).is_some());
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

    #[test]
    fn login_env_finds_claude_on_the_captured_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("claude");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let raw = format!(
            "HOME=/h\0PATH=/nonexistent:{}\0CLAUDECODE=1\0",
            dir.path().display()
        );
        let env = parse_login_env(&raw).unwrap();
        assert_eq!(env.claude, bin);
        assert!(env.vars.iter().all(|(k, _)| k != "CLAUDECODE"));
        assert!(parse_login_env("PATH=/nonexistent\0").is_none());
    }

    struct Counting {
        calls: Mutex<usize>,
        fail_first: usize,
    }
    impl AgentsSource for Counting {
        fn list(&self) -> io::Result<Vec<AgentEntry>> {
            let mut c = self.calls.lock().unwrap();
            *c += 1;
            if *c <= self.fail_first {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "claude agents timed out",
                ));
            }
            Ok(Vec::new())
        }
    }

    #[test]
    fn the_check_reuses_a_fresh_answer_and_retries_once() {
        let tap = Arc::new(AgentsTap::default());
        let src = CheckSource {
            inner: Counting {
                calls: Mutex::new(0),
                fail_first: 1,
            },
            tap: Arc::clone(&tap),
        };
        // First attempt fails, the retry answers: two calls, one good answer.
        assert!(src.list().is_ok());
        assert_eq!(*src.inner.calls.lock().unwrap(), 2);
        // A second check right after reuses the answer: no new call.
        assert!(src.list().is_ok());
        assert_eq!(*src.inner.calls.lock().unwrap(), 2);
        // Two failures in a row surface the error.
        let bad = CheckSource {
            inner: Counting {
                calls: Mutex::new(0),
                fail_first: 2,
            },
            tap: Arc::new(AgentsTap::default()),
        };
        assert!(bad.list().is_err());
        assert_eq!(*bad.inner.calls.lock().unwrap(), 2);
    }
}
