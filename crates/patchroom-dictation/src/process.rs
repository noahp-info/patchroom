//! The helper process: spawned only while dictating, stopped by the person, by silence, or
//! killed when the app quits.
//!
//! Data handling: the helper's stderr goes to `/dev/null` and nothing here writes a line, a
//! transcript or audio anywhere. Events reach the caller's sink in memory only.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::protocol::{parse_line, HelperEvent, MAX_LINE, STOP};

/// How a dictation run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    /// The person stopped it (button, Esc, window blur).
    Stopped,
    /// No new words for the silence timeout.
    Silence,
    /// The helper reported an error.
    Error,
    /// The app killed it (quit, or a new run replaced it).
    Killed,
    /// The helper exited on its own.
    Exited,
}

/// What the sink receives, in order. `Ended` comes exactly once and last.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Output {
    /// A parsed helper line.
    Event(HelperEvent),
    /// The process is gone.
    Ended(EndReason),
}

/// How to run the helper and how long to wait.
#[derive(Debug, Clone)]
pub struct Options {
    /// The helper executable.
    pub program: PathBuf,
    /// Its arguments (see [`crate::protocol::dictate_args`]).
    pub args: Vec<String>,
    /// Stop after this long with no new words. `None`: never.
    pub silence: Option<Duration>,
    /// After `stop`, how long the helper gets to send its final text before it is killed.
    pub grace: Duration,
}

#[derive(Debug)]
struct State {
    /// Set once: the first reason wins.
    reason: Option<EndReason>,
    /// Last time the transcript changed (or the run became ready).
    last_change: Instant,
    /// The helper said `ready`.
    ready: bool,
    /// Last text seen, to tell a change from a repeat.
    text: String,
    /// The reader saw end of output and reaped the child.
    done: bool,
}

#[derive(Debug)]
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    /// Record why the run ends, unless a reason is already set.
    fn set_reason(&self, r: EndReason) -> bool {
        let mut s = lock(&self.state);
        if s.reason.is_some() {
            return false;
        }
        s.reason = Some(r);
        self.wake.notify_all();
        true
    }

    fn kill_now(&self) {
        let _ = lock(&self.child).kill();
        // Dropping stdin also tells a helper that ignores signals to leave.
        lock(&self.stdin).take();
    }

    /// Ask the helper to finish, and kill it if it has not left after `grace`.
    fn request_stop(self: &Arc<Self>, reason: EndReason, grace: Duration) {
        if !self.set_reason(reason) {
            return;
        }
        let sent = lock(&self.stdin).as_mut().is_some_and(|w| {
            w.write_all(STOP.as_bytes())
                .and_then(|()| w.flush())
                .is_ok()
        });
        if !sent {
            self.kill_now();
            return;
        }
        let me = Arc::clone(self);
        thread::spawn(move || {
            let deadline = Instant::now() + grace;
            let mut s = lock(&me.state);
            while !s.done {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    drop(s);
                    me.kill_now();
                    return;
                }
                s = me
                    .wake
                    .wait_timeout(s, left)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0;
            }
        });
    }
}

/// One running helper. Dropping it kills the process.
#[derive(Debug)]
pub struct Session {
    shared: Arc<Shared>,
    grace: Duration,
    pid: u32,
}

impl Session {
    /// Start the helper. `sink` gets every event, then `Ended` once, from a reader thread.
    ///
    /// # Errors
    /// The helper could not be spawned (missing, not executable).
    pub fn spawn<F>(opts: Options, sink: F) -> std::io::Result<Self>
    where
        F: Fn(Output) + Send + Sync + 'static,
    {
        let mut child = Command::new(&opts.program)
            .args(&opts.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Never kept or logged: the helper's diagnostics could name what was said.
            .stderr(Stdio::null())
            .spawn()?;
        let pid = child.id();
        let stdout = child.stdout.take().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "helper has no stdout")
        })?;
        let stdin = child.stdin.take();
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                reason: None,
                last_change: Instant::now(),
                ready: false,
                text: String::new(),
                done: false,
            }),
            wake: Condvar::new(),
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
        });
        let sink = Arc::new(sink);

        // Reader: parse lines, track activity, reap the child, report the end.
        {
            let shared = Arc::clone(&shared);
            let sink = Arc::clone(&sink);
            let grace = opts.grace;
            thread::spawn(move || {
                read_lines(stdout, |ev| {
                    {
                        let mut s = lock(&shared.state);
                        match &ev {
                            HelperEvent::Ready { .. } => {
                                s.ready = true;
                                s.last_change = Instant::now();
                            }
                            HelperEvent::Partial { text } | HelperEvent::Final { text }
                                if *text != s.text =>
                            {
                                s.text.clone_from(text);
                                s.last_change = Instant::now();
                            }
                            _ => {}
                        }
                    }
                    let is_error = matches!(ev, HelperEvent::Error { .. });
                    sink(Output::Event(ev));
                    if is_error {
                        // An error ends the run; give the helper a moment to say `end`.
                        shared.request_stop(EndReason::Error, grace);
                    }
                });
                // Output closed: the helper is leaving. Reap it, killing it if it lingers.
                let deadline = Instant::now() + grace;
                loop {
                    let mut c = lock(&shared.child);
                    match c.try_wait() {
                        Ok(Some(_)) | Err(_) => break,
                        Ok(None) if Instant::now() >= deadline => {
                            let _ = c.kill();
                            let _ = c.wait();
                            break;
                        }
                        Ok(None) => {}
                    }
                    drop(c);
                    thread::sleep(Duration::from_millis(10));
                }
                lock(&shared.stdin).take();
                let reason = {
                    let mut s = lock(&shared.state);
                    s.done = true;
                    shared.wake.notify_all();
                    *s.reason.get_or_insert(EndReason::Exited)
                };
                sink(Output::Ended(reason));
            });
        }

        // Watchdog: stop after the silence timeout with no new words.
        if let Some(silence) = opts.silence {
            let shared = Arc::clone(&shared);
            let grace = opts.grace;
            thread::spawn(move || {
                let mut s = lock(&shared.state);
                loop {
                    if s.done || s.reason.is_some() {
                        return;
                    }
                    let quiet = s.last_change.elapsed();
                    if s.ready && quiet >= silence {
                        drop(s);
                        shared.request_stop(EndReason::Silence, grace);
                        return;
                    }
                    let wait = silence.saturating_sub(quiet).max(Duration::from_millis(20));
                    s = shared
                        .wake
                        .wait_timeout(s, wait)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0;
                }
            });
        }

        Ok(Self {
            shared,
            grace: opts.grace,
            pid,
        })
    }

    /// Ask for the final text and end the run (the person stopped it).
    pub fn stop(&self) {
        self.shared.request_stop(EndReason::Stopped, self.grace);
    }

    /// End the run at once, with no final text.
    pub fn kill(&self) {
        self.shared.set_reason(EndReason::Killed);
        self.shared.kill_now();
    }

    /// The process has not been reaped yet.
    #[must_use]
    pub fn is_running(&self) -> bool {
        !lock(&self.shared.state).done
    }

    /// The helper's process id.
    #[must_use]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Wait until the process is reaped, at most `timeout`. Returns whether it was.
    pub fn wait(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut s = lock(&self.shared.state);
        while !s.done {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            s = self
                .shared
                .wake
                .wait_timeout(s, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.is_running() {
            self.kill();
        }
    }
}

/// Feed each parsed line of `r` to `f`. Bad and overlong lines are skipped, never echoed.
fn read_lines<R: Read>(r: R, mut f: impl FnMut(HelperEvent)) {
    let mut r = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        // Read at most MAX_LINE + 1 bytes of one line, so a runaway line cannot grow memory.
        let limit = u64::try_from(MAX_LINE + 1).unwrap_or(u64::MAX);
        match (&mut r).take(limit).read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if buf.last() != Some(&b'\n') && buf.len() > MAX_LINE {
            // Drain the rest of the overlong line.
            let mut sink = Vec::new();
            loop {
                sink.clear();
                match (&mut r).take(limit).read_until(b'\n', &mut sink) {
                    Ok(0) | Err(_) => return,
                    Ok(_) if sink.last() == Some(&b'\n') => break,
                    Ok(_) => {}
                }
            }
            continue;
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            continue;
        };
        if let Ok(Some(ev)) = parse_line(line) {
            f(ev);
        }
    }
}

/// Run the helper once and return its first event (`--list-locales`). Kills it after `timeout`.
///
/// # Errors
/// The helper could not be spawned, or said nothing before the timeout.
pub fn query(
    program: PathBuf,
    args: Vec<String>,
    timeout: Duration,
) -> std::io::Result<HelperEvent> {
    let (tx, rx) = std::sync::mpsc::channel();
    let tx = Mutex::new(tx);
    let session = Session::spawn(
        Options {
            program,
            args,
            silence: None,
            grace: Duration::from_millis(200),
        },
        move |o| {
            if let Output::Event(e) = o {
                let _ = lock(&tx).send(e);
            }
        },
    )?;
    let got = rx.recv_timeout(timeout);
    session.kill();
    got.map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "helper said nothing"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::mpsc;

    /// A fake helper: a shell script standing in for the Swift binary.
    fn fake(dir: &tempfile::TempDir, name: &str, body: &str) -> PathBuf {
        let p = dir.path().join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn opts(program: PathBuf, silence: Option<u64>) -> Options {
        Options {
            program,
            args: vec!["--dictate".into()],
            silence: silence.map(Duration::from_millis),
            grace: Duration::from_millis(400),
        }
    }

    fn run(o: Options) -> (Session, mpsc::Receiver<Output>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let s = Session::spawn(o, move |out| {
            let _ = lock(&tx).send(out);
        })
        .unwrap();
        (s, rx)
    }

    fn next(rx: &mpsc::Receiver<Output>) -> Output {
        rx.recv_timeout(Duration::from_secs(5))
            .expect("an event within 5s")
    }

    fn alive(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    const TALKER: &str = r#"
echo '{"type":"ready","locale":"en-US"}'
echo '{"type":"partial","text":"hello"}'
echo 'not json, skipped'
echo '{"type":"partial","text":"hello world"}'
read cmd
if [ "$cmd" = stop ]; then
  echo '{"type":"final","text":"Hello world."}'
fi
echo '{"type":"end"}'
"#;

    #[test]
    fn start_partials_stop_final_end() {
        let dir = tempfile::tempdir().unwrap();
        let (s, rx) = run(opts(fake(&dir, "h", TALKER), None));
        assert_eq!(
            next(&rx),
            Output::Event(HelperEvent::Ready {
                locale: "en-US".into()
            })
        );
        assert_eq!(
            next(&rx),
            Output::Event(HelperEvent::Partial {
                text: "hello".into()
            })
        );
        assert_eq!(
            next(&rx),
            Output::Event(HelperEvent::Partial {
                text: "hello world".into()
            })
        );
        assert!(s.is_running());
        s.stop();
        assert_eq!(
            next(&rx),
            Output::Event(HelperEvent::Final {
                text: "Hello world.".into()
            })
        );
        assert_eq!(next(&rx), Output::Event(HelperEvent::End));
        assert_eq!(next(&rx), Output::Ended(EndReason::Stopped));
        assert!(s.wait(Duration::from_secs(2)));
        assert!(!s.is_running());
        // Exactly one end.
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn silence_stops_the_run_and_asks_for_the_final_text() {
        let dir = tempfile::tempdir().unwrap();
        let (s, rx) = run(opts(fake(&dir, "h", TALKER), Some(300)));
        let started = Instant::now();
        let mut got = Vec::new();
        loop {
            match next(&rx) {
                Output::Ended(r) => {
                    assert_eq!(r, EndReason::Silence);
                    break;
                }
                Output::Event(e) => got.push(e),
            }
        }
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(got.contains(&HelperEvent::Final {
            text: "Hello world.".into()
        }));
        assert!(!s.is_running());
    }

    #[test]
    fn new_words_push_the_silence_timeout_back() {
        let dir = tempfile::tempdir().unwrap();
        let body = r#"
echo '{"type":"ready"}'
sleep 0.2; echo '{"type":"partial","text":"a"}'
sleep 0.2; echo '{"type":"partial","text":"a b"}'
sleep 0.2; echo '{"type":"partial","text":"a b c"}'
read cmd
echo '{"type":"end"}'
"#;
        let (_s, rx) = run(opts(fake(&dir, "h", body), Some(350)));
        let started = Instant::now();
        loop {
            if let Output::Ended(r) = next(&rx) {
                assert_eq!(r, EndReason::Silence);
                break;
            }
        }
        // Three partials 200ms apart keep it alive past 600ms, then 350ms of quiet.
        assert!(
            started.elapsed() >= Duration::from_millis(900),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn silence_does_not_count_before_ready() {
        let dir = tempfile::tempdir().unwrap();
        // Permission prompts can take a while: the clock starts at `ready`.
        let body = r#"
sleep 0.5
echo '{"type":"ready"}'
read cmd
echo '{"type":"end"}'
"#;
        let (_s, rx) = run(opts(fake(&dir, "h", body), Some(200)));
        let started = Instant::now();
        loop {
            if let Output::Ended(r) = next(&rx) {
                assert_eq!(r, EndReason::Silence);
                break;
            }
        }
        assert!(started.elapsed() >= Duration::from_millis(700));
    }

    #[test]
    fn a_helper_that_ignores_stop_is_killed_after_the_grace() {
        let dir = tempfile::tempdir().unwrap();
        // It never reads stdin, so `stop` goes unanswered. `exec`: no shell left holding stdout.
        let body = r#"
echo '{"type":"ready"}'
exec sleep 30
"#;
        let (s, rx) = run(opts(fake(&dir, "h", body), None));
        assert!(matches!(
            next(&rx),
            Output::Event(HelperEvent::Ready { .. })
        ));
        let pid = s.pid();
        let t = Instant::now();
        s.stop();
        assert_eq!(next(&rx), Output::Ended(EndReason::Stopped));
        assert!(t.elapsed() < Duration::from_secs(3));
        assert!(!alive(pid), "helper {pid} still running");
    }

    #[test]
    fn dropping_the_session_kills_the_helper() {
        let dir = tempfile::tempdir().unwrap();
        let body = r#"
echo '{"type":"ready"}'
exec sleep 30
"#;
        let (s, rx) = run(opts(fake(&dir, "h", body), None));
        assert!(matches!(
            next(&rx),
            Output::Event(HelperEvent::Ready { .. })
        ));
        let pid = s.pid();
        drop(s);
        assert_eq!(next(&rx), Output::Ended(EndReason::Killed));
        assert!(!alive(pid), "helper {pid} still running");
    }

    #[test]
    fn closing_stdin_is_how_the_helper_learns_the_app_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        // Like the Swift helper: end of input means leave now.
        let body = r#"
echo '{"type":"ready"}'
while read line; do :; done
echo '{"type":"end"}'
"#;
        let (s, rx) = run(opts(fake(&dir, "h", body), None));
        assert!(matches!(
            next(&rx),
            Output::Event(HelperEvent::Ready { .. })
        ));
        lock(&s.shared.stdin).take();
        assert_eq!(next(&rx), Output::Event(HelperEvent::End));
        assert_eq!(next(&rx), Output::Ended(EndReason::Exited));
    }

    #[test]
    fn an_error_ends_the_run() {
        let dir = tempfile::tempdir().unwrap();
        let body = r#"
echo '{"type":"error","code":"speech_denied","message":"Speech recognition is off for Patchroom."}'
read cmd
echo '{"type":"end"}'
"#;
        let (_s, rx) = run(opts(fake(&dir, "h", body), Some(10_000)));
        assert!(matches!(
            next(&rx),
            Output::Event(HelperEvent::Error {
                code: crate::protocol::ErrorCode::SpeechDenied,
                ..
            })
        ));
        assert_eq!(next(&rx), Output::Event(HelperEvent::End));
        assert_eq!(next(&rx), Output::Ended(EndReason::Error));
    }

    #[test]
    fn a_helper_that_exits_on_its_own_reports_exited() {
        let dir = tempfile::tempdir().unwrap();
        let (_s, rx) = run(opts(fake(&dir, "h", "exit 3"), None));
        assert_eq!(next(&rx), Output::Ended(EndReason::Exited));
    }

    #[test]
    fn an_overlong_line_is_skipped_and_reading_goes_on() {
        let dir = tempfile::tempdir().unwrap();
        let body = format!(
            r#"
head -c {} /dev/zero | tr '\0' a
echo
echo '{{"type":"partial","text":"after"}}'
"#,
            MAX_LINE + 10
        );
        let (_s, rx) = run(opts(fake(&dir, "h", &body), None));
        assert_eq!(
            next(&rx),
            Output::Event(HelperEvent::Partial {
                text: "after".into()
            })
        );
        assert_eq!(next(&rx), Output::Ended(EndReason::Exited));
    }

    #[test]
    fn a_missing_helper_fails_to_spawn() {
        let r = Session::spawn(
            opts(PathBuf::from("/nonexistent/patchroom-dictation"), None),
            |_| {},
        );
        assert!(r.is_err());
    }

    #[test]
    fn query_returns_the_first_event_and_kills_the_helper() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(
            &dir,
            "h",
            r#"echo '{"type":"locales","current":"en-US","locales":[{"id":"en-US","onDevice":true}]}'
exec sleep 30"#,
        );
        let e = query(p, vec!["--list-locales".into()], Duration::from_secs(5)).unwrap();
        assert!(matches!(e, HelperEvent::Locales { .. }));
        let p = fake(&dir, "quiet", "exec sleep 30");
        let t = Instant::now();
        assert!(query(p, vec![], Duration::from_millis(200)).is_err());
        assert!(t.elapsed() < Duration::from_secs(3));
    }
}
