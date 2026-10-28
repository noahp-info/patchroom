//! Socket server, per-prompt arbiter, status derivation and reconciler.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, BufReader, Read};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::agents::AgentsSource;
use crate::events::{
    BridgeEvent, HookRecord, NeedsKind, OpenUrlRecord, PermissionPrompt, PlanPrompt, PromptId,
    PromptResolved, Question, QuestionPrompt, Resolution, SessionRef, Status, StatusEvent,
    StatusSource, StatuslineRecord,
};
use crate::hookinfo::HookInfo;
use crate::protocol::{self, ClientMessage, ServerMessage};
use crate::transcript;

/// `sun_path` limit on macOS is 104 bytes including the NUL; Linux is 108.
const MAX_SOCKET_PATH: usize = 100;

/// How long a question or plan is held for a chat answer: in practice, forever.
///
/// A question or plan stays answerable in chat until it is answered (chat or terminal), the
/// person interrupts, or the session or hook goes away. Claude Code still needs a number for
/// the hook's `timeout`, and the bridge always speaks before that deadline, so this is the
/// bound both sides use. It stays well under Node's timer ceiling (2^31 - 1 ms, about 24.8
/// days): a larger hook timeout overflows there and fires at once.
pub const ASK_HOLD: Duration = Duration::from_secs(14 * 24 * 60 * 60);

/// How long a question or plan handed to the TUI is remembered, so the `PermissionRequest`
/// that follows for the same call is not shown in chat a second time.
const HANDED_TTL: Duration = Duration::from_secs(10 * 60);

/// Bridge settings.
#[derive(Debug, Clone)]
pub struct BridgeConfig {
    /// Where to create the unix socket.
    pub socket_path: PathBuf,
    /// How long a PermissionRequest hook is held for a chat answer before it releases to the TUI.
    pub permission_wait: Duration,
    /// How long an AskUserQuestion or ExitPlanMode hook is held for a chat answer. Defaults
    /// to [`ASK_HOLD`], which means no timeout in practice.
    pub ask_wait: Duration,
    /// How often pending permission prompts are checked against their transcript.
    pub transcript_poll: Duration,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            socket_path: PathBuf::new(),
            permission_wait: Duration::from_secs(300),
            ask_wait: ASK_HOLD,
            transcript_poll: Duration::from_millis(200),
        }
    }
}

impl BridgeConfig {
    /// Defaults with the given socket path.
    pub fn new(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
            ..Self::default()
        }
    }
}

/// Failure to start the bridge.
#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    /// Filesystem or socket error.
    #[error("bridge io error: {0}")]
    Io(#[from] io::Error),
    /// Another live bridge owns the socket.
    #[error("another bridge is already listening on {0}")]
    AddrInUse(PathBuf),
    /// The path is not a socket, so the bridge refuses to delete it.
    #[error("{0} exists and is not a socket")]
    NotASocket(PathBuf),
    /// The path exceeds the unix socket path limit.
    #[error("socket path is too long ({0} bytes, max {MAX_SOCKET_PATH}): {1}")]
    PathTooLong(usize, PathBuf),
}

/// Failure to answer a prompt.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AnswerError {
    /// The prompt was already resolved (another answerer won) or never existed.
    #[error("{0} is not pending")]
    NotPending(PromptId),
    /// A permission answer was given for a question, or the reverse.
    #[error("{0} is a different kind of prompt")]
    WrongKind(PromptId),
    /// An answer key matches none of the prompt's questions.
    #[error("unknown question: {0}")]
    UnknownQuestion(String),
    /// A question has no answer.
    #[error("missing answer for question: {0}")]
    MissingAnswer(String),
    /// "Always allow" was asked for a prompt the CLI offered no `permission_suggestions` for.
    #[error("{0} has no permission suggestions to apply")]
    NoSuggestions(PromptId),
}

/// A chat decision for a permission prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionAnswer {
    /// Allow this call.
    Allow,
    /// Allow this call and apply the CLI's own `permission_suggestions`, as option 2 in the
    /// TUI does ("Yes, and always allow ...").
    AllowAlways,
    /// Deny this call with a message shown to the model.
    Deny {
        /// Reason handed to the model.
        message: String,
    },
}

/// Answers to an AskUserQuestion prompt: question text to chosen option label.
///
/// For multi-select questions join labels with a comma (see [`QuestionAnswers::join_multi`]).
/// A free-text answer is the typed text itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuestionAnswers(pub BTreeMap<String, String>);

impl QuestionAnswers {
    /// Empty answer set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Answer one question.
    pub fn with(mut self, question: impl Into<String>, answer: impl Into<String>) -> Self {
        self.0.insert(question.into(), answer.into());
        self
    }

    /// Comma-join several labels for a multi-select question.
    ///
    /// The multi-select format is not yet verified against the real CLI.
    pub fn join_multi<I, S>(labels: I) -> String
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        labels
            .into_iter()
            .map(|s| s.as_ref().to_owned())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Kind of a pending prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingKind {
    /// PermissionRequest.
    Permission,
    /// AskUserQuestion.
    Question,
    /// ExitPlanMode plan approval.
    Plan,
}

/// Snapshot of one pending prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPrompt {
    /// Prompt id.
    pub id: PromptId,
    /// Kind.
    pub kind: PendingKind,
    /// Session.
    pub session: SessionRef,
}

enum Outcome {
    Answer(Value),
    Release,
    Cancel,
}

struct Pending {
    session: SessionRef,
    kind: PendingKind,
    tool_name: String,
    tool_input: Value,
    tool_use_id: Option<String>,
    transcript_path: Option<PathBuf>,
    questions: Vec<Question>,
    suggestions: Value,
    /// Held through `PermissionRequest`: the TUI picker or dialog is already on screen.
    tui_shown: bool,
    /// The event announcing this prompt, kept so a consumer that missed it can be given it again.
    event: BridgeEvent,
    tx: Sender<(Outcome, Resolution)>,
}

/// A question or plan whose PreToolUse hold ended with the TUI taking over.
struct Handed {
    session_id: Option<String>,
    tool_name: String,
    call: Value,
    at: Instant,
}

#[derive(Default)]
struct Tracked {
    pid: Option<u32>,
    session_id: Option<String>,
}

#[derive(Default)]
struct Sessions {
    tracked: HashMap<String, Tracked>,
    statuses: HashMap<String, Status>,
}

struct Inner {
    config: BridgeConfig,
    shutdown: AtomicBool,
    chat_attached: AtomicBool,
    next_id: AtomicU64,
    subscribers: Mutex<Vec<Sender<BridgeEvent>>>,
    pending: Mutex<HashMap<PromptId, Pending>>,
    handed: Mutex<Vec<Handed>>,
    sessions: Mutex<Sessions>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The running bridge. Dropping it shuts it down and removes the socket.
pub struct Bridge {
    inner: Arc<Inner>,
    threads: Mutex<Vec<JoinHandle<()>>>,
}

/// Handle to a background `claude agents --json` reconciler. Dropping it stops the thread.
pub struct Reconciler {
    kick: Sender<()>,
}

impl Reconciler {
    /// Ask the reconciler to run now, for example after a missed hook.
    pub fn reconcile_now(&self) {
        let _ = self.kick.send(());
    }
}

impl Bridge {
    /// Bind the socket (mode `0600`) and start serving.
    ///
    /// A missing parent directory is created with mode `0700`. A stale socket file left by
    /// a dead bridge is replaced. A live one yields [`BridgeError::AddrInUse`].
    pub fn start(config: BridgeConfig) -> Result<Self, BridgeError> {
        let listener = bind_private_socket(&config.socket_path)?;
        listener.set_nonblocking(true)?;
        let inner = Arc::new(Inner {
            config,
            shutdown: AtomicBool::new(false),
            chat_attached: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            subscribers: Mutex::new(Vec::new()),
            pending: Mutex::new(HashMap::new()),
            handed: Mutex::new(Vec::new()),
            sessions: Mutex::new(Sessions::default()),
        });
        let mut threads = Vec::new();
        {
            let inner = Arc::clone(&inner);
            threads.push(
                thread::Builder::new()
                    .name("patchroom-bridge-accept".into())
                    .spawn(move || accept_loop(inner, listener))?,
            );
        }
        {
            let inner = Arc::clone(&inner);
            threads.push(
                thread::Builder::new()
                    .name("patchroom-bridge-transcript".into())
                    .spawn(move || transcript_watcher(inner))?,
            );
        }
        Ok(Self {
            inner,
            threads: Mutex::new(threads),
        })
    }

    /// The socket path.
    pub fn socket_path(&self) -> &Path {
        &self.inner.config.socket_path
    }

    /// The configuration in force.
    pub fn config(&self) -> &BridgeConfig {
        &self.inner.config
    }

    /// Tell the bridge whether a chat client is attached.
    ///
    /// With no chat client (the default), blocking hooks are released at once with no
    /// decision so the TUI is never delayed.
    pub fn set_chat_attached(&self, attached: bool) {
        self.inner.chat_attached.store(attached, Ordering::SeqCst);
    }

    /// Subscribe to all events from now on. Dropping the receiver unsubscribes.
    pub fn subscribe(&self) -> Receiver<BridgeEvent> {
        let (tx, rx) = mpsc::channel();
        lock(&self.inner.subscribers).push(tx);
        rx
    }

    /// Answer a pending permission prompt. First answer wins.
    ///
    /// [`PermissionAnswer::AllowAlways`] returns `updatedPermissions` equal to the
    /// `permission_suggestions` the CLI sent with the request, so the CLI applies its own
    /// rule exactly as if option 2 had been picked in the TUI.
    pub fn answer_permission(
        &self,
        id: PromptId,
        answer: PermissionAnswer,
    ) -> Result<(), AnswerError> {
        self.inner.answer(id, PendingKind::Permission, |p| {
            let decision = match &answer {
                PermissionAnswer::Allow => json!({"behavior": "allow"}),
                PermissionAnswer::AllowAlways => {
                    let usable = match &p.suggestions {
                        Value::Array(a) => !a.is_empty(),
                        Value::Null => false,
                        _ => true,
                    };
                    if !usable {
                        return Err(AnswerError::NoSuggestions(id));
                    }
                    json!({"behavior": "allow", "updatedPermissions": p.suggestions})
                }
                PermissionAnswer::Deny { message } => {
                    json!({"behavior": "deny", "message": message})
                }
            };
            Ok(json!({"hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": decision,
            }}))
        })
    }

    /// Hand a pending prompt to the terminal now: the hook returns no decision and exits,
    /// and the TUI (picker or dialog) decides. Resolves as [`Resolution::Terminal`].
    /// Returns false when the prompt is already gone.
    pub fn release_to_terminal(&self, id: PromptId) -> bool {
        self.release(id, Resolution::Terminal)
    }

    /// Release a pending prompt's hook with no decision and report `resolution`.
    ///
    /// A chat client uses this when it will answer through the TUI itself (keystrokes), for
    /// example a plan approval, which no hook decision can close. Returns false when the
    /// prompt is already gone.
    pub fn release(&self, id: PromptId, resolution: Resolution) -> bool {
        self.inner.resolve(id, Outcome::Release, resolution)
    }

    /// Answer a pending AskUserQuestion prompt. First answer wins.
    ///
    /// Every question needs an answer, keyed by the question text. A question held through
    /// `PreToolUse` gets `updatedInput` with `answers`. One held through `PermissionRequest`
    /// (the TUI picker is already up) gets an allow decision with the same `updatedInput`.
    pub fn answer_question(
        &self,
        id: PromptId,
        answers: QuestionAnswers,
    ) -> Result<(), AnswerError> {
        self.inner.answer(id, PendingKind::Question, |p| {
            for q in &p.questions {
                if !answers.0.contains_key(&q.question) {
                    return Err(AnswerError::MissingAnswer(q.question.clone()));
                }
            }
            for key in answers.0.keys() {
                if !p.questions.iter().any(|q| &q.question == key) {
                    return Err(AnswerError::UnknownQuestion(key.clone()));
                }
            }
            let mut input = p.tool_input.clone();
            if !input.is_object() {
                input = json!({});
            }
            input["answers"] = json!(answers.0);
            if p.tui_shown {
                // The picker is the TUI's permission dialog: allow it with the answers.
                return Ok(json!({"hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {"behavior": "allow", "updatedInput": input},
                }}));
            }
            Ok(json!({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "updatedInput": input,
            }}))
        })
    }

    /// Prompts currently held open.
    pub fn pending(&self) -> Vec<PendingPrompt> {
        let mut v: Vec<_> = lock(&self.inner.pending)
            .iter()
            .map(|(id, p)| PendingPrompt {
                id: *id,
                kind: p.kind,
                session: p.session.clone(),
            })
            .collect();
        v.sort_by_key(|p| p.id);
        v
    }

    /// The event that announced a held prompt, for a consumer that missed it.
    /// `None` once the prompt is gone.
    pub fn pending_event(&self, id: PromptId) -> Option<BridgeEvent> {
        lock(&self.inner.pending).get(&id).map(|p| p.event.clone())
    }

    /// Register a Patchroom session for reconciliation and key lookup.
    ///
    /// `pid` is the PTY child pid. `session_id` may be set when known (for example when
    /// launching with `--session-id`); otherwise the first hook binds it.
    pub fn track_session(
        &self,
        key: impl Into<String>,
        pid: Option<u32>,
        session_id: Option<String>,
    ) {
        let mut s = lock(&self.inner.sessions);
        let t = s.tracked.entry(key.into()).or_default();
        if pid.is_some() {
            t.pid = pid;
        }
        if session_id.is_some() {
            t.session_id = session_id;
        }
    }

    /// Forget a session.
    pub fn untrack_session(&self, key: &str) {
        let mut s = lock(&self.inner.sessions);
        s.tracked.remove(key);
        s.statuses.remove(key);
    }

    /// Last known status of a session by key or CLI session id.
    pub fn status_of(&self, id: &str) -> Option<Status> {
        lock(&self.inner.sessions).statuses.get(id).copied()
    }

    /// Run one reconcile pass synchronously. Returns how many statuses changed.
    pub fn reconcile_once(&self, source: &dyn AgentsSource) -> io::Result<usize> {
        self.inner.reconcile(source)
    }

    /// Start a background reconciler that polls `source` every `interval`.
    pub fn spawn_reconciler(
        &self,
        source: Arc<dyn AgentsSource>,
        interval: Duration,
    ) -> Reconciler {
        let (kick, rx) = mpsc::channel::<()>();
        let inner = Arc::clone(&self.inner);
        let spawned = thread::Builder::new()
            .name("patchroom-bridge-reconcile".into())
            .spawn(move || {
                let tick = Duration::from_millis(100).min(interval);
                let mut last = Instant::now();
                loop {
                    let mut run = false;
                    match rx.recv_timeout(tick) {
                        Ok(()) => run = true,
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                    if inner.shutdown.load(Ordering::SeqCst) {
                        break;
                    }
                    if run || last.elapsed() >= interval {
                        last = Instant::now();
                        let _ = inner.reconcile(&*source);
                    }
                }
            });
        if let Ok(h) = spawned {
            lock(&self.threads).push(h);
        }
        Reconciler { kick }
    }

    /// Stop serving, release every pending hook with no decision, remove the socket.
    pub fn shutdown(&self) {
        if self.inner.shutdown.swap(true, Ordering::SeqCst) {
            return;
        }
        let ids: Vec<PromptId> = lock(&self.inner.pending).keys().copied().collect();
        for id in ids {
            self.inner
                .resolve(id, Outcome::Release, Resolution::Shutdown);
        }
        let handles: Vec<_> = lock(&self.threads).drain(..).collect();
        for h in handles {
            let _ = h.join();
        }
        let _ = fs::remove_file(&self.inner.config.socket_path);
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn bind_private_socket(path: &Path) -> Result<UnixListener, BridgeError> {
    let len = path.as_os_str().len();
    if len > MAX_SOCKET_PATH {
        return Err(BridgeError::PathTooLong(len, path.to_owned()));
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        if !parent.exists() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
        }
    }
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_socket() => {
            if UnixStream::connect(path).is_ok() {
                return Err(BridgeError::AddrInUse(path.to_owned()));
            }
            fs::remove_file(path)?;
        }
        Ok(_) => return Err(BridgeError::NotASocket(path.to_owned())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let listener = UnixListener::bind(path)?;
    if let Err(e) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
        let _ = fs::remove_file(path);
        return Err(e.into());
    }
    Ok(listener)
}

fn accept_loop(inner: Arc<Inner>, listener: UnixListener) {
    while !inner.shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let inner = Arc::clone(&inner);
                let _ = thread::Builder::new()
                    .name("patchroom-bridge-conn".into())
                    .spawn(move || serve_connection(&inner, stream));
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn serve_connection(inner: &Arc<Inner>, stream: UnixStream) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let line = {
        let mut reader = BufReader::new(&stream);
        match protocol::read_line(&mut reader) {
            Ok(Some(l)) => l,
            _ => return,
        }
    };
    let mut out = &stream;
    let reply = match protocol::parse_client_line(&line) {
        Err(message) => ServerMessage::Error { message },
        Ok(ClientMessage::Hook {
            session_key,
            hook_pid: _,
            ppid,
            wait_ms,
            payload,
        }) => inner.handle_hook(&stream, session_key, ppid, wait_ms, payload),
        Ok(ClientMessage::Statusline {
            session_key,
            payload,
            output,
            api_local,
        }) => inner.handle_statusline(session_key, payload, output, api_local),
        Ok(ClientMessage::OpenUrl { session_key, url }) => inner.handle_open_url(session_key, url),
    };
    let _ = protocol::write_frame(&mut out, &reply);
}

impl Inner {
    fn emit(&self, ev: BridgeEvent) {
        lock(&self.subscribers).retain(|tx| tx.send(ev.clone()).is_ok());
    }

    fn resolve_session(&self, key: Option<String>, ppid: u32, info: &HookInfo) -> SessionRef {
        let mut s = lock(&self.sessions);
        let mut key = key.filter(|k| !k.is_empty());
        if key.is_none() {
            if let Some(sid) = &info.session_id {
                key = s
                    .tracked
                    .iter()
                    .find(|(_, t)| t.session_id.as_ref() == Some(sid))
                    .map(|(k, _)| k.clone());
            }
        }
        if key.is_none() && ppid != 0 {
            key = s
                .tracked
                .iter()
                .find(|(_, t)| t.pid == Some(ppid))
                .map(|(k, _)| k.clone());
        }
        if let (Some(k), Some(sid)) = (&key, &info.session_id) {
            s.tracked.entry(k.clone()).or_default().session_id = Some(sid.clone());
        }
        SessionRef {
            key,
            session_id: info.session_id.clone(),
        }
    }

    fn set_status(&self, session: &SessionRef, status: Status, source: StatusSource) -> bool {
        let id = session.id();
        if id.is_empty() {
            return false;
        }
        {
            let mut s = lock(&self.sessions);
            if s.statuses.get(&id) == Some(&status) {
                return false;
            }
            s.statuses.insert(id, status);
        }
        self.emit(BridgeEvent::Status(StatusEvent {
            session: session.clone(),
            status,
            source,
        }));
        true
    }

    fn handle_statusline(
        &self,
        session_key: Option<String>,
        payload: Value,
        output: String,
        api_local: Option<bool>,
    ) -> ServerMessage {
        let info = HookInfo {
            event: "Statusline".to_owned(),
            session_id: payload
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            tool_name: None,
            tool_use_id: None,
            tool_input: Value::Null,
            transcript_path: payload
                .get("transcript_path")
                .and_then(Value::as_str)
                .map(PathBuf::from),
            prompt_id: None,
            cwd: payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_owned),
            permission_mode: None,
            notification_type: None,
            permission_suggestions: Value::Null,
        };
        let session = self.resolve_session(session_key, 0, &info);
        self.emit(BridgeEvent::Statusline(StatuslineRecord {
            session,
            payload,
            output,
            api_local,
        }));
        ServerMessage::Ack
    }

    fn handle_open_url(&self, session_key: Option<String>, url: String) -> ServerMessage {
        let url = url.trim().to_owned();
        let web = url.starts_with("https://") || url.starts_with("http://");
        if !web || url.len() > 8192 {
            return ServerMessage::Error {
                message: "only http and https URLs open".into(),
            };
        }
        self.emit(BridgeEvent::OpenUrl(OpenUrlRecord {
            session_key: session_key.filter(|k| !k.is_empty()),
            url,
        }));
        ServerMessage::Ack
    }

    fn handle_hook(
        self: &Arc<Self>,
        stream: &UnixStream,
        session_key: Option<String>,
        ppid: u32,
        wait_ms: u64,
        payload: Value,
    ) -> ServerMessage {
        let Some(info) = HookInfo::from_payload(&payload) else {
            return ServerMessage::Error {
                message: "payload has no hook_event_name".into(),
            };
        };
        let session = self.resolve_session(session_key, ppid, &info);
        self.emit(BridgeEvent::Hook(HookRecord {
            session: session.clone(),
            event: info.event.clone(),
            payload: payload.clone(),
            transcript_path: info.transcript_path.clone(),
        }));
        self.observe_for_arbiter(&info);
        if let Some(status) = status_for(&info) {
            self.set_status(&session, status, StatusSource::Hook);
        }
        let (kind, tui_shown) = match info.event.as_str() {
            // A question or plan that reaches the permission path (its PreToolUse hold ended,
            // or never ran) is still a question or plan card. The TUI shows the picker or
            // dialog meanwhile. When the TUI just took the call over from a PreToolUse hold,
            // it is the user's already: no second card.
            "PermissionRequest" if info.is_ask_user_question() || info.is_exit_plan_mode() => {
                if self.take_handed(&info) {
                    return ServerMessage::Decision {
                        output: None,
                        resolution: Resolution::Terminal,
                    };
                }
                if info.is_ask_user_question() {
                    (PendingKind::Question, true)
                } else {
                    (PendingKind::Plan, true)
                }
            }
            "PermissionRequest" => (PendingKind::Permission, false),
            "PreToolUse" if info.is_ask_user_question() => (PendingKind::Question, false),
            "PreToolUse" if info.is_exit_plan_mode() => (PendingKind::Plan, false),
            _ => return ServerMessage::Ack,
        };
        if !self.chat_attached.load(Ordering::SeqCst) {
            return ServerMessage::Decision {
                output: None,
                resolution: Resolution::NoChat,
            };
        }
        self.hold_for_answer(stream, session, info, kind, tui_shown, wait_ms)
    }

    fn hold_for_answer(
        self: &Arc<Self>,
        stream: &UnixStream,
        session: SessionRef,
        info: HookInfo,
        kind: PendingKind,
        tui_shown: bool,
        wait_ms: u64,
    ) -> ServerMessage {
        let configured = match kind {
            PendingKind::Permission => self.config.permission_wait,
            PendingKind::Question | PendingKind::Plan => self.config.ask_wait,
        };
        // Always answer before the hook's own deadline.
        let hook_bound = Duration::from_millis(wait_ms).saturating_sub(Duration::from_millis(250));
        let wait = if wait_ms == 0 {
            configured
        } else {
            configured.min(hook_bound)
        };
        let id = PromptId(self.next_id.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = mpsc::channel();
        let questions: Vec<Question> = if kind == PendingKind::Question {
            info.tool_input
                .get("questions")
                .and_then(|q| serde_json::from_value(q.clone()).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let event = match kind {
            PendingKind::Permission => BridgeEvent::Permission(PermissionPrompt {
                id,
                session: session.clone(),
                tool_name: info.tool_name.clone().unwrap_or_default(),
                tool_input: info.tool_input.clone(),
                suggestions: info.permission_suggestions.clone(),
                cwd: info.cwd.clone(),
                permission_mode: info.permission_mode.clone(),
                prompt_id: info.prompt_id.clone(),
            }),
            PendingKind::Plan => BridgeEvent::Plan(PlanPrompt {
                id,
                session: session.clone(),
                tool_use_id: info.tool_use_id.clone(),
                plan: info
                    .tool_input
                    .get("plan")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                tool_input: info.tool_input.clone(),
                wait,
                tui_shown,
            }),
            PendingKind::Question => BridgeEvent::Question(QuestionPrompt {
                id,
                session: session.clone(),
                tool_use_id: info.tool_use_id.clone(),
                questions: questions.clone(),
                tool_input: info.tool_input.clone(),
                wait,
                tui_shown,
            }),
        };
        lock(&self.pending).insert(
            id,
            Pending {
                session: session.clone(),
                kind,
                tool_name: info.tool_name.clone().unwrap_or_default(),
                tool_input: info.tool_input.clone(),
                tool_use_id: info.tool_use_id.clone(),
                transcript_path: info.transcript_path.clone(),
                questions,
                suggestions: info.permission_suggestions.clone(),
                tui_shown,
                event: event.clone(),
                tx,
            },
        );
        self.emit(event);

        // `None`: the wait outlasts any clock this process will see.
        let deadline = Instant::now().checked_add(wait);
        let (outcome, resolution) = loop {
            match rx.recv_timeout(Duration::from_millis(40)) {
                Ok(done) => break done,
                Err(RecvTimeoutError::Disconnected) => {
                    break (Outcome::Release, Resolution::Shutdown)
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
            let reason = if peer_gone(stream) {
                Some(Resolution::HookGone)
            } else if self.shutdown.load(Ordering::SeqCst) {
                Some(Resolution::Shutdown)
            } else if deadline.is_some_and(|d| Instant::now() >= d) {
                Some(Resolution::Timeout)
            } else {
                None
            };
            if let Some(r) = reason {
                // If another resolver won the race, its outcome is already in `rx`.
                if self.resolve(id, Outcome::Release, r) {
                    break (Outcome::Release, r);
                }
                if let Ok(done) = rx.recv_timeout(Duration::from_secs(1)) {
                    break done;
                }
                break (Outcome::Release, r);
            }
        };
        match outcome {
            Outcome::Answer(v) => ServerMessage::Decision {
                output: Some(v),
                resolution,
            },
            Outcome::Release => ServerMessage::Decision {
                output: None,
                resolution,
            },
            Outcome::Cancel => ServerMessage::Cancel { reason: resolution },
        }
    }

    /// Remove the prompt and deliver the outcome. Returns false when it was already gone.
    fn resolve(&self, id: PromptId, outcome: Outcome, resolution: Resolution) -> bool {
        let Some(p) = lock(&self.pending).remove(&id) else {
            return false;
        };
        let to_tui = matches!(outcome, Outcome::Release)
            && matches!(
                resolution,
                Resolution::Chat | Resolution::Terminal | Resolution::TurnEnded
            );
        if to_tui && p.kind != PendingKind::Permission && !p.tui_shown {
            // The TUI takes this call over now. Its PermissionRequest is the user's.
            let mut handed = lock(&self.handed);
            handed.retain(|h| h.at.elapsed() < HANDED_TTL);
            handed.push(Handed {
                session_id: p.session.session_id.clone(),
                tool_name: p.tool_name.clone(),
                call: call_key(&p.tool_name, &p.tool_input),
                at: Instant::now(),
            });
        }
        let _ = p.tx.send((outcome, resolution));
        self.emit(BridgeEvent::Resolved(PromptResolved {
            id,
            session: p.session,
            resolution,
        }));
        true
    }

    /// Was this question or plan handed to the TUI from a PreToolUse hold? Forgets it.
    fn take_handed(&self, info: &HookInfo) -> bool {
        let tool = info.tool_name.as_deref().unwrap_or_default();
        let call = call_key(tool, &info.tool_input);
        let mut handed = lock(&self.handed);
        handed.retain(|h| h.at.elapsed() < HANDED_TTL);
        let hit = handed
            .iter()
            .position(|h| h.tool_name == tool && h.session_id == info.session_id && h.call == call);
        hit.map(|i| handed.remove(i)).is_some()
    }

    fn answer(
        &self,
        id: PromptId,
        kind: PendingKind,
        build: impl FnOnce(&Pending) -> Result<Value, AnswerError>,
    ) -> Result<(), AnswerError> {
        let output = {
            let map = lock(&self.pending);
            let p = map.get(&id).ok_or(AnswerError::NotPending(id))?;
            if p.kind != kind {
                return Err(AnswerError::WrongKind(id));
            }
            build(p)?
        };
        if self.resolve(id, Outcome::Answer(output), Resolution::Chat) {
            Ok(())
        } else {
            Err(AnswerError::NotPending(id))
        }
    }

    /// Detect, from hook traffic, that a pending prompt was answered elsewhere.
    fn observe_for_arbiter(&self, info: &HookInfo) {
        let Some(sid) = info.session_id.as_deref() else {
            return;
        };
        let mut hits: Vec<(PromptId, Resolution)> = Vec::new();
        {
            let map = lock(&self.pending);
            for (id, p) in map.iter() {
                if p.session.session_id.as_deref() != Some(sid) {
                    continue;
                }
                match info.event.as_str() {
                    "PostToolUse" | "PostToolUseFailure" => {
                        let same_tool = info.tool_name.as_deref() == Some(p.tool_name.as_str());
                        let matched = match (&p.tool_use_id, &info.tool_use_id) {
                            (Some(a), Some(b)) if p.kind != PendingKind::Permission => a == b,
                            (Some(a), Some(b)) => {
                                a == b || (same_tool && p.tool_input == info.tool_input)
                            }
                            _ => {
                                same_tool
                                    && call_key(&p.tool_name, &p.tool_input)
                                        == call_key(&p.tool_name, &info.tool_input)
                            }
                        };
                        if matched {
                            hits.push((*id, Resolution::Terminal));
                        }
                    }
                    "Stop" | "StopFailure" | "UserPromptSubmit" | "SessionEnd" => {
                        hits.push((*id, Resolution::TurnEnded));
                    }
                    _ => {}
                }
            }
        }
        for (id, r) in hits {
            self.resolve(id, Outcome::Cancel, r);
        }
    }

    fn reconcile(&self, source: &dyn AgentsSource) -> io::Result<usize> {
        let entries = source.list()?;
        let tracked: Vec<(String, Option<u32>, Option<String>)> = lock(&self.sessions)
            .tracked
            .iter()
            .map(|(k, t)| (k.clone(), t.pid, t.session_id.clone()))
            .collect();
        let mut changed = 0;
        for (key, pid, sid) in tracked {
            let entry = entries.iter().find(|e| {
                (sid.is_some() && e.session_id == sid)
                    || (pid.is_some() && e.pid != 0 && Some(e.pid) == pid)
            });
            let Some(entry) = entry else { continue };
            {
                let mut s = lock(&self.sessions);
                if let Some(t) = s.tracked.get_mut(&key) {
                    if t.session_id.is_none() {
                        t.session_id = entry.session_id.clone();
                    }
                    if t.pid.is_none() && entry.pid != 0 {
                        t.pid = Some(entry.pid);
                    }
                }
            }
            if let Some(status) = entry.to_status() {
                let session = SessionRef {
                    key: Some(key),
                    session_id: entry.session_id.clone(),
                };
                if self.set_status(&session, status, StatusSource::Reconciler) {
                    changed += 1;
                }
            }
        }
        Ok(changed)
    }
}

/// What identifies one call of `tool`: the questions of an AskUserQuestion and the plan of an
/// ExitPlanMode (their input gains `answers` and other fields on the way), else the whole input.
fn call_key(tool: &str, input: &Value) -> Value {
    let field = match tool {
        "AskUserQuestion" => "questions",
        "ExitPlanMode" => "plan",
        _ => return input.clone(),
    };
    input.get(field).cloned().unwrap_or(Value::Null)
}

/// True when the hook closed its end (it sends nothing after the request line).
fn peer_gone(stream: &UnixStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return true;
    }
    let mut byte = [0u8; 1];
    let gone = match (&*stream).read(&mut byte) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) => !matches!(
            e.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ),
    };
    let _ = stream.set_nonblocking(false);
    gone
}

/// Status implied by one hook delivery.
fn status_for(info: &HookInfo) -> Option<Status> {
    match info.event.as_str() {
        "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure" => Some(Status::Busy),
        "Stop" | "StopFailure" | "SessionStart" => Some(Status::Idle),
        "PermissionRequest" => Some(Status::NeedsYou(NeedsKind::Permission)),
        "PreToolUse" if info.is_ask_user_question() => Some(Status::NeedsYou(NeedsKind::Question)),
        "PreToolUse" if info.is_exit_plan_mode() => Some(Status::NeedsYou(NeedsKind::Permission)),
        "Notification" => match info.notification_type.as_deref() {
            Some("permission_prompt") => Some(Status::NeedsYou(NeedsKind::Permission)),
            Some("elicitation_dialog") => Some(Status::NeedsYou(NeedsKind::Question)),
            Some("agent_needs_input") => Some(Status::NeedsYou(NeedsKind::Other)),
            Some("idle_prompt") => Some(Status::Idle),
            _ => None,
        },
        _ => None,
    }
}

/// Polls transcripts of pending permission prompts. A `tool_result` for the matching
/// `tool_use` means the TUI answered first.
fn transcript_watcher(inner: Arc<Inner>) {
    while !inner.shutdown.load(Ordering::SeqCst) {
        thread::sleep(inner.config.transcript_poll);
        type Row = (PromptId, PathBuf, String, Value, Option<String>);
        let (rows, claimed): (Vec<Row>, Vec<String>) = {
            let map = lock(&inner.pending);
            let claimed = map.values().filter_map(|p| p.tool_use_id.clone()).collect();
            let rows = map
                .iter()
                .filter(|(_, p)| p.kind == PendingKind::Permission || p.tui_shown)
                .filter_map(|(id, p)| {
                    p.transcript_path.clone().map(|path| {
                        (
                            *id,
                            path,
                            p.tool_name.clone(),
                            p.tool_input.clone(),
                            p.tool_use_id.clone(),
                        )
                    })
                })
                .collect();
            (rows, claimed)
        };
        for (id, path, name, input, known) in rows {
            let Ok(tail) = transcript::read_tail(&path) else {
                continue;
            };
            let tool_use_id =
                known.or_else(|| transcript::find_tool_use(&tail, &name, &input, &claimed));
            let Some(tool_use_id) = tool_use_id else {
                continue;
            };
            if transcript::has_tool_result(&tail, &tool_use_id) {
                inner.resolve(id, Outcome::Cancel, Resolution::Terminal);
            } else if let Some(p) = lock(&inner.pending).get_mut(&id) {
                p.tool_use_id = Some(tool_use_id);
            }
        }
    }
}
