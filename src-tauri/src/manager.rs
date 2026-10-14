//! The session manager: one owner for the PTY sessions, the hook bridge and
//! the store.
//!
//! Threading model (all plain OS threads, so it is safe to call from tokio
//! tasks as long as blocking calls go through `spawn_blocking`):
//!
//! - one **forwarder** thread per session drains the PTY crate's unbounded
//!   event channel, coalesces output into chunks of up to [`MAX_CHUNK`] bytes
//!   and hands them to the [`EventSink`]. The PTY drain thread inside
//!   `patchroom-pty` never waits on this thread, so a slow UI cannot stall the
//!   child (the channel buffers instead);
//! - one **writer** thread per session owns the ordered write queue, so
//!   keystrokes, pastes and `session_send_text` never reorder and never block
//!   the caller;
//! - one **bridge** thread turns hook status events into `session:status`.
//!
//! The store sits behind a `Mutex`; it is only held for short queries.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use patchroom_bridge::{
    Bridge, BridgeConfig, BridgeEvent, HookSettings, NeedsKind, Reconciler, Status as BridgeStatus,
};
use patchroom_pty::{Command, PtyEvent, Session as PtySession, SpawnConfig, TitleKind};
use patchroom_store::{Author, Conversation, ConversationKind, Id, NewConversation, Store};
use serde::{Deserialize, Serialize};

use crate::agents::LoginShellAgents;
use crate::events::{EventSink, Needs, PresenceStatus, UiEvent};

/// Background reconcile period while a session is busy or waiting.
const RECONCILE_INTERVAL: Duration = Duration::from_secs(15);

/// Reconcile kicks after Esc or Ctrl+C: claude needs a moment to redraw and
/// update `claude agents`, so check early and once more later.
const INTERRUPT_KICKS: [Duration; 2] = [Duration::from_millis(900), Duration::from_secs(3)];

/// Unix socket paths are limited to about 104 bytes on macOS.
const MAX_SOCKET_PATH: usize = 100;

/// Largest raw output chunk handed to the sink in one event.
pub const MAX_CHUNK: usize = 64 * 1024;

/// Default PTY size before the frontend reports its real one.
const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 40;

/// Name of the workspace and default section created on first run.
const WORKSPACE_NAME: &str = "Patchroom";
const DEFAULT_SECTION: &str = "Direct messages";

/// Errors returned by the manager. The `Display` text goes to the frontend.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// No session with that id.
    #[error("no such session: {0}")]
    NoSession(String),
    /// The request is not valid.
    #[error("{0}")]
    Invalid(String),
    /// The hook binary could not be found.
    #[error("patchroom-hook not found at {0}")]
    HookMissing(PathBuf),
    /// Store failure.
    #[error("store: {0}")]
    Store(#[from] patchroom_store::Error),
    /// PTY failure.
    #[error("pty: {0}")]
    Pty(#[from] patchroom_pty::Error),
    /// Bridge failure.
    #[error("bridge: {0}")]
    Bridge(#[from] patchroom_bridge::BridgeError),
    /// Other I/O failure.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Result alias for the manager.
pub type Result<T> = std::result::Result<T, Error>;

/// Manager configuration.
#[derive(Debug, Clone)]
pub struct ManagerConfig {
    /// App data dir. Holds `patchroom.db` and `bridge.sock`.
    pub data_dir: PathBuf,
    /// Absolute path of the `patchroom-hook` binary.
    pub hook_bin: PathBuf,
    /// Login shell override (tests). `None` uses `$SHELL`.
    pub shell: Option<PathBuf>,
    /// Program used when a DM runs `claude`. Tests point this at a stub.
    pub claude_program: String,
    /// SIGTERM-to-SIGKILL grace for a killed session.
    pub kill_grace: Duration,
    /// Run the `claude agents --json` reconciler through the login shell. The app
    /// turns this on; tests leave it off so they never spawn the real CLI.
    pub reconcile: bool,
}

impl ManagerConfig {
    /// Defaults for the given data dir and hook binary.
    pub fn new(data_dir: impl Into<PathBuf>, hook_bin: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            hook_bin: hook_bin.into(),
            shell: None,
            claude_program: "claude".into(),
            kill_grace: Duration::from_secs(2),
            reconcile: false,
        }
    }
}

/// Arguments of `session_create`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CreateRequest {
    /// Working directory. Must exist.
    pub cwd: String,
    /// Program to run. Default `claude`.
    pub command: Option<String>,
    /// Arguments for the program.
    pub args: Option<Vec<String>>,
    /// Display name. Default: the cwd's folder name.
    pub name: Option<String>,
    /// Initial columns.
    pub cols: Option<u16>,
    /// Initial rows.
    pub rows: Option<u16>,
}

/// One row of `session_list`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SessionInfo {
    /// Session id (the conversation ULID).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Working directory.
    pub cwd: String,
    /// Latest terminal title, empty when none yet.
    pub title: String,
    /// Presence status.
    pub status: PresenceStatus,
    /// Reason, only for `waiting`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs: Option<Needs>,
    /// Section the DM sits in.
    pub section_id: Option<String>,
    /// The claude session id used for `--resume`.
    pub claude_session_id: Option<String>,
}

/// One section of the sidebar.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SectionInfo {
    /// Section id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Sort position.
    pub position: i64,
    /// Collapsed in the sidebar.
    pub collapsed: bool,
}

/// What `--open-dm` asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenDm {
    /// Working directory.
    pub cwd: String,
    /// Extra arguments for claude.
    pub args: Vec<String>,
}

/// State persisted in `conversation.adapter_state`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AdapterState {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    title: String,
}

impl AdapterState {
    fn parse(raw: &str) -> Self {
        serde_json::from_str(raw).unwrap_or_default()
    }

    fn is_claude(&self) -> bool {
        self.command.as_deref().is_none_or(|c| c == "claude")
    }
}

struct Presence {
    title: String,
    status: PresenceStatus,
    needs: Option<Needs>,
    claude_sid: Option<String>,
}

enum WriteJob {
    Bytes(Vec<u8>),
    Text(String),
}

struct Live {
    pty: Arc<PtySession>,
    tx: Mutex<Sender<WriteJob>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The shared handle used by Tauri state and by tests.
pub type SessionManager = Arc<Manager>;

/// Owner of sessions, bridge and store.
pub struct Manager {
    cfg: ManagerConfig,
    sink: Arc<dyn EventSink>,
    store: Mutex<Store>,
    bridge: Bridge,
    workspace: Id,
    default_section: Id,
    live: Mutex<HashMap<String, Arc<Live>>>,
    presence: Mutex<HashMap<String, Presence>>,
    open_dm: Mutex<Option<OpenDm>>,
    shutting_down: AtomicBool,
    /// True while any session is busy or waiting. Gates the reconciler.
    active: Arc<AtomicBool>,
    reconciler: Option<Arc<Reconciler>>,
}

impl Manager {
    /// Open the store, start the bridge and return the manager.
    ///
    /// # Errors
    /// Store or bridge start-up failures.
    pub fn new(cfg: ManagerConfig, sink: Arc<dyn EventSink>) -> Result<SessionManager> {
        std::fs::create_dir_all(&cfg.data_dir)?;
        let store = Store::open(&cfg.data_dir)?;
        let me = Author::me();
        let workspace = match store.list_workspaces()?.into_iter().next() {
            Some(w) => w.id,
            None => store.create_workspace(&me, WORKSPACE_NAME)?.id,
        };
        let default_section = match store.list_sections(workspace)?.into_iter().next() {
            Some(s) => s.id,
            None => store.create_section(&me, workspace, DEFAULT_SECTION)?.id,
        };
        let bridge = Bridge::start(BridgeConfig::new(socket_path_for(&cfg.data_dir)))?;
        let events = bridge.subscribe();
        let active = Arc::new(AtomicBool::new(false));
        let reconciler = cfg.reconcile.then(|| {
            Arc::new(bridge.spawn_reconciler(
                Arc::new(LoginShellAgents::new(Arc::clone(&active))),
                RECONCILE_INTERVAL,
            ))
        });
        let manager = Arc::new(Manager {
            cfg,
            sink,
            store: Mutex::new(store),
            bridge,
            workspace,
            default_section,
            live: Mutex::new(HashMap::new()),
            presence: Mutex::new(HashMap::new()),
            open_dm: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
            active,
            reconciler,
        });
        manager.spawn_bridge_thread(events)?;
        Ok(manager)
    }

    /// The bridge (tests flip `set_chat_attached`; the app never needs it).
    #[must_use]
    pub fn bridge(&self) -> &Bridge {
        &self.bridge
    }

    /// Queue the dev-only `--open-dm`: the DM is created on the first
    /// `session_list` call, so the frontend already knows to look for it.
    pub fn queue_open_dm(&self, req: OpenDm) {
        *lock(&self.open_dm) = Some(req);
    }

    // ---- commands ----

    /// `session_create`: add a DM row and start its process.
    ///
    /// # Errors
    /// Invalid cwd, missing hook binary, spawn or store failures.
    pub fn create(self: &Arc<Self>, req: &CreateRequest) -> Result<String> {
        let (id, spec, sid) = self.create_row(req)?;
        let launched = self.launch(
            &id,
            &req.cwd,
            &spec,
            sid.as_deref(),
            false,
            req.cols.unwrap_or(DEFAULT_COLS),
            req.rows.unwrap_or(DEFAULT_ROWS),
        );
        if let Err(e) = launched {
            // A DM that never started should not linger in the sidebar.
            let _ = self.delete(&id);
            return Err(e);
        }
        Ok(id)
    }

    /// `session_resume`: start an exited DM again, with `claude --resume <id>`
    /// for claude DMs.
    ///
    /// # Errors
    /// Unknown id, session still running, no stored claude session id.
    pub fn resume(self: &Arc<Self>, id: &str, cols: Option<u16>, rows: Option<u16>) -> Result<()> {
        let conv = self.conversation(id)?;
        if let Some(live) = lock(&self.live).get(id) {
            if live.pty.exit_info().is_none() {
                return Err(Error::Invalid("session is already running".into()));
            }
        }
        let spec = AdapterState::parse(&conv.adapter_state);
        let sid = if spec.is_claude() {
            Some(conv.session_id.clone().ok_or_else(|| {
                Error::Invalid("this DM has no claude session id to resume".into())
            })?)
        } else {
            None
        };
        self.launch(
            id,
            conv.cwd.as_deref().unwrap_or("."),
            &spec,
            sid.as_deref(),
            true,
            cols.unwrap_or(DEFAULT_COLS),
            rows.unwrap_or(DEFAULT_ROWS),
        )
    }

    /// `session_write`: raw bytes from the terminal, queued in order.
    ///
    /// # Errors
    /// Unknown id or exited session.
    pub fn write(&self, id: &str, bytes: Vec<u8>) -> Result<()> {
        let interrupt = is_interrupt(&bytes);
        self.enqueue(id, WriteJob::Bytes(bytes))?;
        if interrupt {
            self.kick_reconciler();
        }
        Ok(())
    }

    /// Esc or Ctrl+C can end a prompt or a turn without any hook firing, so
    /// re-read `claude agents` shortly after, once claude has redrawn.
    fn kick_reconciler(&self) {
        let Some(r) = &self.reconciler else { return };
        if !self.active.load(Ordering::SeqCst) {
            return;
        }
        let r = Arc::clone(r);
        let _ = thread::Builder::new()
            .name("patchroom-reconcile-kick".into())
            .spawn(move || {
                for delay in INTERRUPT_KICKS {
                    thread::sleep(delay);
                    r.reconcile_now();
                }
            });
    }

    /// `session_send_text`: bracketed paste, then Enter after the PTY crate's
    /// delay. Queued behind earlier writes.
    ///
    /// # Errors
    /// Unknown id or exited session.
    pub fn send_text(&self, id: &str, text: String) -> Result<()> {
        self.enqueue(id, WriteJob::Text(text))
    }

    /// `session_resize`.
    ///
    /// # Errors
    /// Unknown id or resize failure.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let live = self.live_of(id)?;
        live.pty.resize(rows, cols)?;
        Ok(())
    }

    /// `session_kill`: SIGTERM the process group, SIGKILL after the grace.
    /// Blocks up to the grace period. Idempotent.
    ///
    /// # Errors
    /// Unknown id or signal failure.
    pub fn kill(&self, id: &str) -> Result<()> {
        let live = self.live_of(id)?;
        live.pty.kill()?;
        Ok(())
    }

    /// `session_list`: every persisted DM with its live presence.
    ///
    /// # Errors
    /// Store failures.
    pub fn list(self: &Arc<Self>) -> Result<Vec<SessionInfo>> {
        self.start_queued_open_dm();
        let convs = lock(&self.store).list_conversations(self.workspace)?;
        let presence = lock(&self.presence);
        Ok(convs
            .into_iter()
            .filter(|c| c.kind == ConversationKind::Dm)
            .map(|c| {
                let id = c.id.to_string();
                let (title, status, needs) = match presence.get(&id) {
                    Some(p) => (p.title.clone(), p.status, p.needs),
                    None => (
                        AdapterState::parse(&c.adapter_state).title,
                        PresenceStatus::Exited,
                        None,
                    ),
                };
                SessionInfo {
                    id,
                    name: c.name,
                    cwd: c.cwd.unwrap_or_default(),
                    title,
                    status,
                    needs,
                    section_id: c.section_id.map(|s| s.to_string()),
                    claude_session_id: c.session_id,
                }
            })
            .collect())
    }

    /// `session_rename`.
    ///
    /// # Errors
    /// Unknown id or empty name.
    pub fn rename(&self, id: &str, name: &str) -> Result<()> {
        lock(&self.store).rename_conversation(parse_id(id)?, name)?;
        Ok(())
    }

    /// `session_delete`: kill the process and drop the DM.
    ///
    /// # Errors
    /// Unknown id or store failure.
    pub fn delete(&self, id: &str) -> Result<()> {
        let conv_id = parse_id(id)?;
        let live = lock(&self.live).remove(id);
        if let Some(live) = live {
            let _ = live.pty.kill();
        }
        self.bridge.untrack_session(id);
        {
            let mut presence = lock(&self.presence);
            presence.remove(id);
            self.refresh_active(&presence);
        }
        lock(&self.store).delete_conversation(conv_id)?;
        Ok(())
    }

    /// `section_list`.
    ///
    /// # Errors
    /// Store failures.
    pub fn sections(&self) -> Result<Vec<SectionInfo>> {
        Ok(lock(&self.store)
            .list_sections(self.workspace)?
            .into_iter()
            .map(|s| SectionInfo {
                id: s.id.to_string(),
                name: s.name,
                position: s.position,
                collapsed: s.collapsed,
            })
            .collect())
    }

    /// `section_create`.
    ///
    /// # Errors
    /// Empty name or store failure.
    pub fn create_section(&self, name: &str) -> Result<String> {
        let s = lock(&self.store).create_section(&Author::me(), self.workspace, name)?;
        Ok(s.id.to_string())
    }

    /// `section_set_collapsed`.
    ///
    /// # Errors
    /// Unknown section.
    pub fn set_section_collapsed(&self, id: &str, collapsed: bool) -> Result<()> {
        lock(&self.store).set_section_collapsed(parse_id(id)?, collapsed)?;
        Ok(())
    }

    /// `session_set_section`: move a DM to the end of a section.
    ///
    /// # Errors
    /// Unknown DM or section.
    pub fn set_section(&self, id: &str, section_id: Option<&str>) -> Result<()> {
        let section = section_id.map(parse_id).transpose()?;
        lock(&self.store).move_conversation(parse_id(id)?, section, usize::MAX)?;
        Ok(())
    }

    /// True once the child of `id` has exited. Used by the backpressure test:
    /// the child must finish even while the sink is still busy.
    #[must_use]
    pub fn child_exited(&self, id: &str) -> bool {
        lock(&self.live)
            .get(id)
            .is_some_and(|l| l.pty.exit_info().is_some())
    }

    /// Pid of the session's child, if it is known.
    #[must_use]
    pub fn pid_of(&self, id: &str) -> Option<u32> {
        lock(&self.live).get(id).map(|l| l.pty.pid())
    }

    /// Kill every child (and its hooks), persist titles, stop the bridge.
    /// Safe to call twice. This is the quit path.
    pub fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        // Stops the reconciler and kills any `claude agents` call in flight, so
        // quitting never waits on it.
        self.active.store(false, Ordering::SeqCst);
        let lives: Vec<(String, Arc<Live>)> = lock(&self.live)
            .iter()
            .map(|(k, v)| (k.clone(), Arc::clone(v)))
            .collect();
        // Kill in parallel so N sessions cost one grace period, not N.
        let killers: Vec<_> = lives
            .iter()
            .map(|(_, l)| {
                let pty = Arc::clone(&l.pty);
                thread::spawn(move || {
                    let _ = pty.kill();
                })
            })
            .collect();
        for k in killers {
            let _ = k.join();
        }
        for (id, _) in &lives {
            self.persist_title(id);
        }
        // Safety net for hook processes that left the process group: every
        // hook command line carries the socket path.
        sweep_by_cmdline(self.bridge.socket_path());
        self.bridge.shutdown();
    }

    // ---- internals ----

    fn create_row(&self, req: &CreateRequest) -> Result<(String, AdapterState, Option<String>)> {
        if !Path::new(&req.cwd).is_dir() {
            return Err(Error::Invalid(format!(
                "working directory does not exist: {}",
                req.cwd
            )));
        }
        let spec = AdapterState {
            command: req.command.clone().filter(|c| !c.is_empty()),
            args: req.args.clone().unwrap_or_default(),
            title: String::new(),
        };
        let claude_sid = spec.is_claude().then(|| uuid::Uuid::new_v4().to_string());
        let name = req
            .name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| folder_name(&req.cwd));
        let store = lock(&self.store);
        let conv = store.create_conversation(
            &Author::me(),
            &NewConversation {
                workspace_id: self.workspace,
                section_id: Some(self.default_section),
                kind: ConversationKind::Dm,
                name,
                provider: Some(spec.command.clone().unwrap_or_else(|| "claude".into())),
                cwd: Some(req.cwd.clone()),
                worktree: None,
                session_id: claude_sid.clone(),
                assign_mode: None,
            },
        )?;
        store.set_adapter_state(
            conv.id,
            &serde_json::to_string(&spec).unwrap_or_else(|_| "{}".into()),
        )?;
        Ok((conv.id.to_string(), spec, claude_sid))
    }

    fn conversation(&self, id: &str) -> Result<Conversation> {
        lock(&self.store)
            .conversation(parse_id(id)?)
            .map_err(|_| Error::NoSession(id.to_owned()))
    }

    fn live_of(&self, id: &str) -> Result<Arc<Live>> {
        lock(&self.live)
            .get(id)
            .cloned()
            .ok_or_else(|| Error::NoSession(id.to_owned()))
    }

    fn enqueue(&self, id: &str, job: WriteJob) -> Result<()> {
        let live = self.live_of(id)?;
        if live.pty.exit_info().is_some() {
            return Err(Error::Invalid("session has exited".into()));
        }
        let sent = lock(&live.tx).send(job);
        sent.map_err(|_| Error::Invalid("session has exited".into()))
    }

    #[allow(clippy::too_many_arguments)]
    fn launch(
        self: &Arc<Self>,
        id: &str,
        cwd: &str,
        spec: &AdapterState,
        claude_sid: Option<&str>,
        resume: bool,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(Error::Invalid("app is shutting down".into()));
        }
        let command = if spec.is_claude() {
            if !self.cfg.hook_bin.is_file() {
                return Err(Error::HookMissing(self.cfg.hook_bin.clone()));
            }
            let sid =
                claude_sid.ok_or_else(|| Error::Invalid("missing claude session id".into()))?;
            let mut args: Vec<String> = if resume {
                vec!["--resume".into(), sid.into()]
            } else {
                vec!["--session-id".into(), sid.into()]
            };
            args.extend(spec.args.iter().cloned());
            // Per-launch hooks only: user settings files are never touched.
            let settings = HookSettings::new(&self.cfg.hook_bin, self.bridge.socket_path())
                .with_session_key(id);
            args.extend(settings.cli_args());
            Command::program(self.cfg.claude_program.clone(), args)
        } else {
            Command::program(
                spec.command.clone().unwrap_or_default(),
                spec.args.iter().cloned(),
            )
        };

        let mut sc = SpawnConfig::new(command, id);
        sc.cwd = Some(PathBuf::from(cwd));
        sc.cols = cols;
        sc.rows = rows;
        sc.shell = self.cfg.shell.clone();
        sc.kill_grace = self.cfg.kill_grace;
        let pty = Arc::new(PtySession::spawn(sc)?);

        // Publish tracking, presence and the live entry under one `live` guard, so a
        // previous pty's forwarder (which checks `live` under the same guard) sees
        // either the old session or the new one, never a mix. Lock order: live, then
        // presence.
        let mut live_map = lock(&self.live);
        // Two overlapping resumes can both pass the early "already running" check;
        // only the first may publish. The loser kills its own pty.
        if live_map
            .get(id)
            .is_some_and(|l| l.pty.exit_info().is_none())
        {
            drop(live_map);
            let _ = pty.kill();
            return Err(Error::Invalid("session is already running".into()));
        }
        self.bridge
            .track_session(id, Some(pty.pid()), claude_sid.map(str::to_owned));

        let (tx, rx) = mpsc::channel::<WriteJob>();
        let live = Arc::new(Live {
            pty: Arc::clone(&pty),
            tx: Mutex::new(tx),
        });
        {
            let mut presence = lock(&self.presence);
            let title = presence
                .get(id)
                .map(|p| p.title.clone())
                .unwrap_or_else(|| spec.title.clone());
            presence.insert(
                id.to_owned(),
                Presence {
                    title,
                    status: PresenceStatus::Idle,
                    needs: None,
                    claude_sid: claude_sid.map(str::to_owned),
                },
            );
            self.sink.emit(UiEvent::Status {
                id: id.to_owned(),
                status: PresenceStatus::Idle,
                needs: None,
            });
            self.refresh_active(&presence);
        }
        live_map.insert(id.to_owned(), live);
        drop(live_map);

        let writer_pty = Arc::clone(&pty);
        thread::Builder::new()
            .name("patchroom-writer".into())
            .spawn(move || writer_loop(&writer_pty, &rx))?;
        let me = Arc::clone(self);
        let fwd_id = id.to_owned();
        thread::Builder::new()
            .name("patchroom-forwarder".into())
            .spawn(move || me.forward(&fwd_id, &pty))?;
        Ok(())
    }

    /// Drain the PTY event channel into UI events, in order.
    fn forward(&self, id: &str, pty: &PtySession) {
        let rx = pty.events();
        let mut pending: Vec<u8> = Vec::new();
        let mut exit_code: Option<i64> = None;
        'outer: while let Ok(first) = rx.recv() {
            let mut next = Some(first);
            while let Some(ev) = next.take() {
                match ev {
                    PtyEvent::Output(bytes) => {
                        pending.extend_from_slice(&bytes);
                        if pending.len() >= MAX_CHUNK {
                            self.flush(id, &mut pending);
                        }
                        next = rx.try_recv().ok();
                    }
                    PtyEvent::Title { kind, text } => {
                        self.flush(id, &mut pending);
                        if kind != TitleKind::Icon {
                            self.set_title(id, text);
                        }
                        next = rx.try_recv().ok();
                    }
                    PtyEvent::Exit(info) => {
                        self.flush(id, &mut pending);
                        exit_code = Some(i64::from(info.code));
                        break 'outer;
                    }
                    // xterm.js answers terminal queries; OSC 9 and progress are
                    // not part of the contract (hooks drive presence).
                    PtyEvent::Notification(_) | PtyEvent::Progress { .. } | PtyEvent::Query(_) => {
                        next = rx.try_recv().ok();
                    }
                }
            }
            self.flush(id, &mut pending);
        }
        self.flush(id, &mut pending);
        if !self.finish_exit(id, pty, exit_code.unwrap_or(1)) {
            return;
        }
        self.persist_title(id);
    }

    /// Mark `id` exited, unless a resume already replaced `pty`. The check and the
    /// updates run under the `live` guard that `launch` publishes under, so a stale
    /// forwarder can never mark a resumed session exited or untrack it.
    /// Returns false when the pty was replaced.
    fn finish_exit(&self, id: &str, pty: &PtySession, code: i64) -> bool {
        let live_map = lock(&self.live);
        let replaced = live_map
            .get(id)
            .is_some_and(|l| !std::ptr::eq(Arc::as_ptr(&l.pty), pty));
        if replaced {
            return false;
        }
        self.sink.emit(UiEvent::Exit {
            id: id.to_owned(),
            code,
        });
        self.bridge.untrack_session(id);
        self.set_status(id, PresenceStatus::Exited, None);
        drop(live_map);
        true
    }

    fn flush(&self, id: &str, pending: &mut Vec<u8>) {
        for chunk in pending.chunks(MAX_CHUNK) {
            self.sink.emit(UiEvent::Output {
                id: id.to_owned(),
                data: B64.encode(chunk),
            });
        }
        pending.clear();
    }

    fn set_title(&self, id: &str, title: String) {
        let mut presence = lock(&self.presence);
        if let Some(p) = presence.get_mut(id) {
            if p.title != title {
                p.title.clone_from(&title);
                self.sink.emit(UiEvent::Title {
                    id: id.to_owned(),
                    title,
                });
            }
        }
    }

    /// Update presence and emit on change. An exited session stays exited
    /// until it is launched again (late hooks must not revive it).
    fn set_status(&self, id: &str, status: PresenceStatus, needs: Option<Needs>) {
        let mut presence = lock(&self.presence);
        let Some(p) = presence.get_mut(id) else {
            return;
        };
        if p.status == PresenceStatus::Exited {
            return;
        }
        if p.status == status && p.needs == needs {
            return;
        }
        p.status = status;
        p.needs = needs;
        self.sink.emit(UiEvent::Status {
            id: id.to_owned(),
            status,
            needs,
        });
        self.refresh_active(&presence);
    }

    /// Gate the reconciler: on while any session is busy or waiting.
    fn refresh_active(&self, presence: &HashMap<String, Presence>) {
        if self.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let any = presence
            .values()
            .any(|p| matches!(p.status, PresenceStatus::Busy | PresenceStatus::Waiting));
        self.active.store(any, Ordering::SeqCst);
    }

    /// True while the reconciler is allowed to run `claude agents`. Tests only.
    #[cfg(test)]
    pub(crate) fn reconcile_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    fn persist_title(&self, id: &str) {
        let Some(title) = lock(&self.presence).get(id).map(|p| p.title.clone()) else {
            return;
        };
        let Ok(conv_id) = parse_id(id) else { return };
        let store = lock(&self.store);
        if let Ok(conv) = store.conversation(conv_id) {
            let mut spec = AdapterState::parse(&conv.adapter_state);
            if spec.title != title {
                spec.title = title;
                if let Ok(json) = serde_json::to_string(&spec) {
                    let _ = store.set_adapter_state(conv_id, &json);
                }
            }
        }
    }

    fn spawn_bridge_thread(self: &Arc<Self>, rx: Receiver<BridgeEvent>) -> Result<()> {
        let me = Arc::clone(self);
        thread::Builder::new()
            .name("patchroom-bridge-events".into())
            .spawn(move || loop {
                if me.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(ev) => me.on_bridge_event(&ev),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            })?;
        Ok(())
    }

    fn on_bridge_event(&self, ev: &BridgeEvent) {
        match ev {
            BridgeEvent::Status(se) => {
                let Some(key) = se.session.key.as_deref() else {
                    return;
                };
                if let Some(sid) = se.session.session_id.as_deref() {
                    self.note_claude_session(key, sid);
                }
                let (status, needs) = map_status(se.status);
                self.set_status(key, status, needs);
            }
            BridgeEvent::Hook(rec) => {
                if let (Some(key), Some(sid)) = (
                    rec.session.key.as_deref(),
                    rec.session.session_id.as_deref(),
                ) {
                    self.note_claude_session(key, sid);
                }
            }
            _ => {}
        }
    }

    /// Persist the claude session id when a hook reports a different one
    /// (a resumed session may get a new id).
    fn note_claude_session(&self, id: &str, sid: &str) {
        {
            let mut presence = lock(&self.presence);
            let Some(p) = presence.get_mut(id) else {
                return;
            };
            if p.claude_sid.as_deref() == Some(sid) {
                return;
            }
            p.claude_sid = Some(sid.to_owned());
        }
        if let Ok(conv_id) = parse_id(id) {
            let _ = lock(&self.store).set_conversation_session(conv_id, Some(sid));
        }
    }

    fn start_queued_open_dm(self: &Arc<Self>) {
        let Some(req) = lock(&self.open_dm).take() else {
            return;
        };
        let create = CreateRequest {
            cwd: req.cwd,
            args: Some(req.args),
            ..CreateRequest::default()
        };
        let (id, spec, sid) = match self.create_row(&create) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("patchroom: --open-dm failed: {e}");
                return;
            }
        };
        // The row exists now; the process starts shortly after so the
        // frontend's listeners are attached before the first output.
        let me = Arc::clone(self);
        let spawned = thread::Builder::new()
            .name("patchroom-open-dm".into())
            .spawn(move || {
                thread::sleep(Duration::from_millis(800));
                let r = me.launch(
                    &id,
                    &create.cwd,
                    &spec,
                    sid.as_deref(),
                    false,
                    DEFAULT_COLS,
                    DEFAULT_ROWS,
                );
                if let Err(e) = r {
                    eprintln!("patchroom: --open-dm launch failed: {e}");
                }
            });
        if let Err(e) = spawned {
            eprintln!("patchroom: --open-dm thread failed: {e}");
        }
    }
}

fn writer_loop(pty: &PtySession, rx: &Receiver<WriteJob>) {
    while let Ok(job) = rx.recv() {
        let r = match job {
            WriteJob::Bytes(b) => pty.write(&b),
            WriteJob::Text(t) => pty.send_text(&t),
        };
        if r.is_err() && pty.exit_info().is_some() {
            break;
        }
    }
}

/// A lone Esc, a double Esc, or Ctrl+C.
fn is_interrupt(bytes: &[u8]) -> bool {
    matches!(bytes, [0x1b] | [0x1b, 0x1b] | [0x03])
}

/// `<data_dir>/bridge.sock`, or a short per-data-dir path under the per-user temp
/// dir when that would exceed the unix socket path limit. The bridge creates the
/// parent with mode `0700`.
fn socket_path_for(data_dir: &Path) -> PathBuf {
    let preferred = data_dir.join("bridge.sock");
    if preferred.as_os_str().len() <= MAX_SOCKET_PATH {
        return preferred;
    }
    // FNV-1a: stable across runs, so a relaunch finds the same socket.
    let hash = data_dir
        .as_os_str()
        .as_encoded_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
        });
    let short = std::env::temp_dir().join(format!("patchroom-{hash:016x}/bridge.sock"));
    if short.as_os_str().len() <= MAX_SOCKET_PATH {
        short
    } else {
        PathBuf::from(format!("/tmp/patchroom-{hash:016x}/bridge.sock"))
    }
}

fn map_status(s: BridgeStatus) -> (PresenceStatus, Option<Needs>) {
    match s {
        BridgeStatus::Busy => (PresenceStatus::Busy, None),
        BridgeStatus::Idle => (PresenceStatus::Idle, None),
        BridgeStatus::NeedsYou(k) => (
            PresenceStatus::Waiting,
            Some(match k {
                NeedsKind::Permission => Needs::Permission,
                NeedsKind::Question => Needs::Question,
                NeedsKind::Other => Needs::Other,
            }),
        ),
    }
}

fn parse_id(id: &str) -> Result<Id> {
    id.parse::<Id>()
        .map_err(|_| Error::NoSession(id.to_owned()))
}

fn folder_name(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .map_or_else(|| cwd.to_owned(), |n| n.to_string_lossy().into_owned())
}

/// `pkill -KILL -f <path>`: kill any process whose command line holds `path`.
fn sweep_by_cmdline(path: &Path) {
    let pattern = path.to_string_lossy().into_owned();
    let _ = std::process::Command::new("pkill")
        .args(["-KILL", "-f"])
        .arg(pattern)
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NullSink;
    impl EventSink for NullSink {
        fn emit(&self, _event: UiEvent) {}
    }

    #[test]
    fn stale_forwarder_cannot_exit_a_replaced_session() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = ManagerConfig::new(dir.path(), dir.path().join("no-hook"));
        cfg.shell = Some("/bin/sh".into());
        cfg.kill_grace = Duration::from_millis(300);
        let m = Manager::new(cfg, Arc::new(NullSink)).unwrap();
        let mk = || {
            m.create(&CreateRequest {
                cwd: dir.path().to_string_lossy().into_owned(),
                command: Some("sh".into()),
                args: Some(vec!["-c".into(), "sleep 30".into()]),
                ..CreateRequest::default()
            })
            .unwrap()
        };
        let a = mk();
        let b = mk();
        let pty_a = Arc::clone(&lock(&m.live)[&a].pty);
        let pty_b = Arc::clone(&lock(&m.live)[&b].pty);
        m.set_status(&a, PresenceStatus::Busy, None);

        // A forwarder whose pty is no longer the live one for `a` changes nothing.
        assert!(!m.finish_exit(&a, &pty_b, 1));
        assert_eq!(lock(&m.presence)[&a].status, PresenceStatus::Busy);

        // The current pty's forwarder marks it exited.
        assert!(m.finish_exit(&a, &pty_a, 0));
        assert_eq!(lock(&m.presence)[&a].status, PresenceStatus::Exited);
        m.shutdown();
    }

    #[test]
    fn reconcile_gate_follows_presence_through_delete_and_quit() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = ManagerConfig::new(dir.path(), dir.path().join("no-hook"));
        cfg.shell = Some("/bin/sh".into());
        cfg.kill_grace = Duration::from_millis(300);
        let m = Manager::new(cfg, Arc::new(NullSink)).unwrap();
        let mk = || {
            m.create(&CreateRequest {
                cwd: dir.path().to_string_lossy().into_owned(),
                command: Some("sh".into()),
                args: Some(vec!["-c".into(), "sleep 30".into()]),
                ..CreateRequest::default()
            })
            .unwrap()
        };

        // Deleting a busy DM turns the gate off: no `claude agents` while idle.
        let a = mk();
        m.set_status(&a, PresenceStatus::Busy, None);
        assert!(m.reconcile_active());
        m.delete(&a).unwrap();
        assert!(!m.reconcile_active());

        // Quit turns it off even with a session still waiting.
        let b = mk();
        m.set_status(&b, PresenceStatus::Waiting, Some(Needs::Permission));
        assert!(m.reconcile_active());
        m.shutdown();
        assert!(!m.reconcile_active());
    }

    #[test]
    fn interrupt_bytes() {
        assert!(is_interrupt(&[0x1b]));
        assert!(is_interrupt(&[0x1b, 0x1b]));
        assert!(is_interrupt(&[0x03]));
        assert!(!is_interrupt(b"\x1b[A"));
        assert!(!is_interrupt(b"a"));
    }

    #[test]
    fn long_data_dir_gets_a_short_stable_socket() {
        let short = Path::new("/tmp/pr");
        assert_eq!(socket_path_for(short), short.join("bridge.sock"));
        let long = PathBuf::from(format!("/tmp/{}", "d".repeat(120)));
        let a = socket_path_for(&long);
        assert!(a.as_os_str().len() <= MAX_SOCKET_PATH, "{}", a.display());
        assert_eq!(a, socket_path_for(&long));
        assert_ne!(a, socket_path_for(&long.join("other")));
    }

    #[test]
    fn status_mapping() {
        assert_eq!(map_status(BridgeStatus::Busy), (PresenceStatus::Busy, None));
        assert_eq!(
            map_status(BridgeStatus::NeedsYou(NeedsKind::Question)),
            (PresenceStatus::Waiting, Some(Needs::Question))
        );
    }

    #[test]
    fn adapter_state_defaults_to_claude() {
        let s = AdapterState::parse("{}");
        assert!(s.is_claude());
        let s = AdapterState::parse(r#"{"command":"sh"}"#);
        assert!(!s.is_claude());
    }

    #[test]
    fn folder_name_falls_back_to_the_path() {
        assert_eq!(folder_name("/a/b/proj"), "proj");
    }
}
