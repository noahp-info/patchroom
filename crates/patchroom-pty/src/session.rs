//! The live PTY session.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{unbounded, Receiver, Sender};
use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use crate::config::{build_env, SpawnConfig};
use crate::error::{Error, Result};
use crate::event::{ExitInfo, PtyEvent, TerminalQuery};
use crate::keys::{bracketed_paste, Key};
use crate::parser::{Scanned, Scanner};

/// DA1 reply: VT220-class terminal with ANSI color (matches the spike).
const DA1_REPLY: &[u8] = b"\x1b[?62;c";
/// XTVERSION reply (matches the spike; the TUI accepted it).
const XTVERSION_REPLY: &[u8] = b"\x1bP>|xterm.js(5.5.0)\x1b\\";

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

fn lock<T: ?Sized>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Default)]
struct ExitState {
    info: Mutex<Option<ExitInfo>>,
    cv: Condvar,
}

impl ExitState {
    fn set(&self, info: ExitInfo) {
        *lock(&self.info) = Some(info);
        self.cv.notify_all();
    }

    fn get(&self) -> Option<ExitInfo> {
        lock(&self.info).clone()
    }

    fn wait(&self, timeout: Duration) -> Option<ExitInfo> {
        let deadline = Instant::now() + timeout;
        let mut guard = lock(&self.info);
        while guard.is_none() {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            guard = self
                .cv
                .wait_timeout(guard, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        guard.clone()
    }
}

/// A running PTY child plus its drain threads.
///
/// All methods take `&self`, so a session can be shared behind an `Arc`.
/// Dropping the session kills the child (see [`Session::kill`]).
pub struct Session {
    session_id: String,
    pid: u32,
    tty: Option<PathBuf>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: SharedWriter,
    events: Receiver<PtyEvent>,
    exit: Arc<ExitState>,
    enter_delay: Duration,
    kill_grace: Duration,
}

impl Session {
    /// Open a PTY and start `cfg.command` through `$SHELL -l -c`.
    ///
    /// # Errors
    /// [`Error::Spawn`] if the PTY cannot be opened or the shell cannot start.
    pub fn spawn(cfg: SpawnConfig) -> Result<Self> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: cfg.rows,
                cols: cfg.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(spawn_err)?;
        let tty = pair.master.tty_name();
        let tty_str = tty.as_ref().map(|p| p.to_string_lossy().into_owned());

        let mut cmd = CommandBuilder::new(cfg.resolve_shell());
        cmd.args(["-l", "-c", &cfg.command.script()]);
        cmd.env_clear();
        for (k, v) in build_env(std::env::vars(), &cfg, tty_str.as_deref()) {
            cmd.env(k, v);
        }
        let cwd = match &cfg.cwd {
            Some(c) => Some(c.clone()),
            None => std::env::current_dir().ok(),
        };
        if let Some(c) = cwd {
            cmd.cwd(c);
        }

        let mut child = pair.slave.spawn_command(cmd).map_err(spawn_err)?;
        // The parent must not hold the slave open, or the reader never sees EOF.
        drop(pair.slave);
        let pid = child
            .process_id()
            .ok_or_else(|| Error::Spawn("child has no pid".into()))?;

        let reader = pair.master.try_clone_reader().map_err(spawn_err)?;
        let writer: SharedWriter =
            Arc::new(Mutex::new(pair.master.take_writer().map_err(spawn_err)?));

        let (tx, rx) = unbounded::<PtyEvent>();
        let (done_tx, done_rx) = crossbeam_channel::bounded::<()>(1);
        let exit = Arc::new(ExitState::default());

        {
            let tx = tx.clone();
            let writer = Arc::clone(&writer);
            let reply = cfg.reply_to_terminal_queries;
            thread::Builder::new()
                .name("patchroom-pty-reader".into())
                .spawn(move || {
                    drain(reader, &tx, &writer, reply);
                    let _ = done_tx.send(());
                })
                .map_err(|e| Error::Spawn(e.to_string()))?;
        }
        {
            let exit = Arc::clone(&exit);
            thread::Builder::new()
                .name("patchroom-pty-waiter".into())
                .spawn(move || {
                    let info = match child.wait() {
                        Ok(st) => ExitInfo {
                            code: st.exit_code(),
                            signal: st.signal().map(str::to_owned),
                        },
                        Err(_) => ExitInfo {
                            code: 1,
                            signal: None,
                        },
                    };
                    // Let the reader flush what the child wrote before it
                    // died. A grandchild holding the tty can keep the reader
                    // open, so the wait is bounded.
                    let _ = done_rx.recv_timeout(Duration::from_millis(500));
                    exit.set(info.clone());
                    let _ = tx.send(PtyEvent::Exit(info));
                })
                .map_err(|e| Error::Spawn(e.to_string()))?;
        }

        Ok(Self {
            session_id: cfg.session_id,
            pid,
            tty,
            master: Mutex::new(pair.master),
            writer,
            events: rx,
            exit,
            enter_delay: cfg.enter_delay,
            kill_grace: cfg.kill_grace,
        })
    }

    /// The `PATCHROOM_SESSION` id.
    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Pid of the PTY child. With [`crate::Command::Program`] this is the
    /// program itself, because the login shell `exec`s it.
    #[must_use]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Path of the slave tty (also exported as `PATCHROOM_TTY`).
    #[must_use]
    pub fn tty(&self) -> Option<&std::path::Path> {
        self.tty.as_deref()
    }

    /// A receiver for the event stream. Receivers are cloneable, but each
    /// event is delivered to exactly one of them. The channel is unbounded:
    /// the drain thread never waits on the consumer.
    #[must_use]
    pub fn events(&self) -> Receiver<PtyEvent> {
        self.events.clone()
    }

    /// Exit status once the child has ended.
    #[must_use]
    pub fn exit_info(&self) -> Option<ExitInfo> {
        self.exit.get()
    }

    /// Block up to `timeout` for the child to exit.
    #[must_use]
    pub fn wait_exit(&self, timeout: Duration) -> Option<ExitInfo> {
        self.exit.wait(timeout)
    }

    /// Write raw bytes to the child's stdin (keystrokes from the terminal UI).
    ///
    /// # Errors
    /// [`Error::Write`] if the child has exited or the PTY is closed. After
    /// exit this fails on every OS (Linux does not reliably return `EIO`).
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        if self.exit.get().is_some() {
            return Err(Error::Write(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "child has exited",
            )));
        }
        let mut w = lock(&self.writer);
        w.write_all(bytes)
            .and_then(|()| w.flush())
            .map_err(Error::Write)
    }

    /// Inject `text` as a bracketed paste, wait the configured delay (400ms by
    /// default), then send Enter in a separate write. Blocks for the delay.
    ///
    /// # Errors
    /// [`Error::Write`] if the PTY is closed.
    pub fn send_text(&self, text: &str) -> Result<()> {
        self.send_text_with_delay(text, self.enter_delay)
    }

    /// Like [`Session::send_text`] with an explicit delay before Enter.
    ///
    /// # Errors
    /// [`Error::Write`] if the PTY is closed.
    pub fn send_text_with_delay(&self, text: &str, delay: Duration) -> Result<()> {
        self.write(&bracketed_paste(text))?;
        thread::sleep(delay);
        self.write(&Key::Enter.bytes()?)
    }

    /// Send keys in order as one write. Use for dialog answers: `1`..`4`,
    /// arrows, Enter, Esc, Tab.
    ///
    /// # Errors
    /// [`Error::InvalidDigit`] for a bad digit (nothing is written);
    /// [`Error::Write`] if the PTY is closed.
    pub fn send_keys(&self, keys: &[Key]) -> Result<()> {
        let mut buf = Vec::new();
        for k in keys {
            buf.extend(k.bytes()?);
        }
        self.write(&buf)
    }

    /// Resize the PTY. The kernel delivers SIGWINCH to the foreground group.
    ///
    /// # Errors
    /// [`Error::Resize`] on failure.
    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        lock(&self.master)
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::Resize(e.to_string()))
    }

    /// Kill the child and everything in its process group, then wait for the
    /// exit. Sends SIGTERM, waits `kill_grace`, then SIGKILL. Idempotent.
    /// Descendants that ignore SIGTERM are SIGKILLed once the child is gone.
    ///
    /// # Errors
    /// [`Error::Signal`] if a signal could not be delivered to a live group.
    pub fn kill(&self) -> Result<()> {
        if self.exit.get().is_some() {
            return Ok(());
        }
        // The child is a session leader (setsid), so its pgid is its pid.
        let pgid =
            Pid::from_raw(i32::try_from(self.pid).map_err(|e| Error::Signal(e.to_string()))?);
        match killpg(pgid, Signal::SIGTERM) {
            Ok(()) | Err(nix::errno::Errno::ESRCH) => {}
            Err(e) => return Err(Error::Signal(e.to_string())),
        }
        if self.exit.wait(self.kill_grace).is_none() {
            let _ = killpg(pgid, Signal::SIGKILL);
            self.exit.wait(Duration::from_secs(5));
        }
        // Sweep survivors that ignored SIGTERM. The group id stays reserved
        // until its last member dies, so this cannot hit an unrelated group
        // this soon after the leader was reaped.
        let _ = killpg(pgid, Signal::SIGKILL);
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

/// Read until EOF or error, forwarding bytes and parsed events.
fn drain(
    mut reader: Box<dyn Read + Send>,
    tx: &Sender<PtyEvent>,
    writer: &SharedWriter,
    reply: bool,
) {
    let mut scanner = Scanner::new();
    let mut buf = vec![0u8; 32 * 1024];
    let mut scanned = Vec::new();
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let chunk = &buf[..n];
        scanned.clear();
        scanner.feed(chunk, &mut scanned);
        if tx.send(PtyEvent::Output(chunk.to_vec())).is_err() {
            // Consumer is gone; keep draining so the child never blocks.
            continue;
        }
        for item in scanned.drain(..) {
            let ev = match item {
                Scanned::Title { kind, text } => PtyEvent::Title { kind, text },
                Scanned::Notification(m) => PtyEvent::Notification(m),
                Scanned::Notify { title, body } => PtyEvent::Notify { title, body },
                Scanned::Bell => PtyEvent::Bell,
                Scanned::Progress { state, value } => PtyEvent::Progress { state, value },
                Scanned::Query(q) => {
                    if reply {
                        let bytes = match q {
                            TerminalQuery::PrimaryDeviceAttributes => DA1_REPLY,
                            TerminalQuery::XtVersion => XTVERSION_REPLY,
                        };
                        let mut w = lock(writer);
                        let _ = w.write_all(bytes).and_then(|()| w.flush());
                    }
                    PtyEvent::Query(q)
                }
            };
            let _ = tx.send(ev);
        }
    }
}

/// portable-pty returns `anyhow::Error`; any `Display` works here.
fn spawn_err<E: std::fmt::Display>(e: E) -> Error {
    Error::Spawn(e.to_string())
}
