//! The chat layer of the session manager: transcript watchers, native prompts, badges and
//! the status strip. It is part of [`super::Manager`] (a child module, so it can reach the
//! manager's private state).
//!
//! # Locks
//! `adapter` (inside each [`Watcher`]) may be held while taking `Chat::state`, the store or
//! the presence map. Never take an adapter lock while holding `Chat::state`.
//!
//! # Prompts
//! Three kinds reach the UI: `permission` (a live TUI dialog that a hook decision can
//! close), `question` (AskUserQuestion) and `plan` (ExitPlanMode). The last two are held
//! behind a `PreToolUse` hook, so the TUI shows nothing until the bridge releases them:
//! the chat answer, a typed key in the terminal, a switch to the terminal view or the
//! bounded wait ends the hold.
//!
//! A permission prompt from the bridge has no tool use id. The manager waits for the
//! matching `tool` item in the transcript (up to [`LINK_WAIT`]) so `prompt:pending` can
//! carry `toolUseId` and the item can show state `pending`. Question prompts carry their id
//! from the hook. Per prompt, the first answer wins in the bridge; this module only maps
//! the chat contract onto it.

use std::collections::BTreeMap;
use std::sync::Weak;

use patchroom_bridge::statusline::{chips_from_payload, resolve_user_status_line, Chips};
use patchroom_bridge::{
    PermissionAnswer, PermissionPrompt, PlanPrompt, PromptId, PromptResolved, QuestionAnswers,
    QuestionPrompt, Resolution, StatuslineRecord,
};
use patchroom_claude::{Adapter, Cursor, Locator, Meta, Page, Update, Watcher};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    lock, parse_id, Arc, Author, Duration, Error, HashMap, Manager, Mutex, Path, PathBuf, Result,
    UiEvent, WriteJob,
};

/// Transcript poll interval while a session runs.
const LIVE_POLL: Duration = Duration::from_millis(50);
/// Transcript poll interval once the process has exited.
const IDLE_POLL: Duration = Duration::from_secs(2);
/// How long a permission prompt waits for its `tool_use` line before it is announced anyway.
const LINK_WAIT: Duration = Duration::from_millis(700);
/// Pause between handing a picker to the TUI and the first typed key.
pub(super) const PICKER_DRAW_DELAY: Duration = Duration::from_millis(350);
/// Delay before the footer is read after a statusLine render or a mode key.
const MODE_SCRAPE_DELAY: Duration = Duration::from_millis(300);
/// Default page size of `chat_history`.
const DEFAULT_PAGE: usize = 200;
/// Longest string kept in a `prompt:pending` tool input.
const PROMPT_INPUT_STRING_LIMIT: usize = 8 * 1024;
/// Longest plan text kept in a `prompt:pending` tool input.
const PLAN_STRING_LIMIT: usize = 128 * 1024;

/// Shift+Tab: cycles the permission mode in the TUI.
const SHIFT_TAB: &[u8] = b"\x1b[Z";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromptKind {
    Permission,
    Question,
    Plan,
}

impl PromptKind {
    fn as_str(self) -> &'static str {
        match self {
            PromptKind::Permission => "permission",
            PromptKind::Question => "question",
            PromptKind::Plan => "plan",
        }
    }
}

struct OpenPrompt {
    kind: PromptKind,
    tool_name: String,
    tool_input: Value,
    tool_use_id: Option<String>,
    questions: Option<Value>,
    can_always: bool,
    /// `prompt:pending` was sent.
    emitted: bool,
    /// `prompt:pending` went out without a `toolUseId`; re-emit it when the line lands.
    awaiting_link: bool,
}

#[derive(Default)]
struct ChatState {
    prompts: HashMap<PromptId, OpenPrompt>,
    status_text: String,
    payload_chips: Chips,
    last_statusline: Option<(String, Chips)>,
    /// The mode read off the TUI footer (wins over the transcript's last `permission-mode`).
    screen_mode: Option<String>,
    /// A delayed footer read is already scheduled.
    mode_scrape_pending: bool,
    /// The DM is shown as a terminal: a hidden AskUserQuestion picker is released at once.
    terminal_view: bool,
}

/// Transcript watcher and prompt state of one DM.
pub(in crate::manager) struct Chat {
    watcher: Watcher,
    state: Mutex<ChatState>,
}

/// How long a plan answer waits for the TUI dialog to draw after the hold is released.
const PLAN_DIALOG_WAIT: Duration = Duration::from_secs(4);

/// A terminal emulator fed with a session's output, so dialog labels can be read off the
/// real screen. (The TUI repaints only what changed, so raw output alone cannot say what
/// is on screen.)
pub(super) struct Screen {
    parser: vt100::Parser,
}

impl Screen {
    pub(super) fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows.max(1), cols.max(1), 0),
        }
    }

    pub(super) fn feed(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    pub(super) fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.screen_mut().set_size(rows.max(1), cols.max(1));
    }

    /// The visible screen as text, one line per row.
    fn text(&self) -> String {
        self.parser.screen().contents()
    }

    /// The permission mode the TUI shows in its footer, as the name used in the transcript
    /// (`default`, `auto`, `plan`, `acceptEdits`, `bypassPermissions`).
    pub(super) fn mode(&self) -> Option<String> {
        mode_from_screen(&self.text())
    }
}

/// Read the footer's `<name> mode on` / `accept edits on` / `bypass permissions on` label.
fn mode_from_screen(text: &str) -> Option<String> {
    text.lines().rev().find_map(|line| {
        let l = line.to_lowercase();
        if l.contains("accept edits on") {
            return Some("acceptEdits".to_owned());
        }
        if l.contains("bypass permissions on") {
            return Some("bypassPermissions".to_owned());
        }
        let idx = l.find(" mode on")?;
        let name = l[..idx].split_whitespace().last()?;
        let name: String = name.chars().filter(char::is_ascii_alphabetic).collect();
        match name.as_str() {
            "" => None,
            "manual" => Some("default".to_owned()),
            other => Some(other.to_owned()),
        }
    })
}

/// The number of the dialog option whose label contains one of `needles` (lowercase),
/// read from numbered lines such as `❯ 2. Yes, manually approve edits`.
fn option_number(screen_text: &str, needles: &[&str]) -> Option<u32> {
    screen_text.lines().rev().find_map(|line| {
        let t = line.trim_start_matches(|c: char| c.is_whitespace() || !c.is_ascii_alphanumeric());
        let (num, rest) = t.split_once('.')?;
        let n: u32 = num.trim().parse().ok().filter(|n| *n > 0)?;
        let label = rest.to_lowercase();
        needles
            .iter()
            .any(|needle| label.contains(needle))
            .then_some(n)
    })
}

/// What a plan answer asks the TUI dialog for.
enum PlanChoice {
    /// "Yes, manually approve edits": proceed without elevating permissions.
    Approve,
    /// "Yes, and use auto mode" (or auto-accept edits): the plan dialog's own "always".
    ApproveAuto,
    /// "Tell Claude what to change", with the feedback text.
    Revise(String),
}

/// The answer in `prompt_answer {id, promptId, answer}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PromptAnswer {
    /// Allow this call.
    Allow,
    /// Allow and apply the CLI's own permission suggestions.
    AllowAlways,
    /// Deny, with an optional message for the model.
    Deny {
        /// Message handed to the model.
        #[serde(default)]
        message: Option<String>,
    },
    /// Answers to an AskUserQuestion: question text to chosen label(s) joined with ", ".
    Questions {
        /// Answers by question text.
        answers: BTreeMap<String, String>,
    },
    /// Hand the prompt to the terminal (the hook releases and the TUI decides).
    Terminal,
}

/// Result of `chat_image`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    /// `data:<media type>;base64,<bytes>`.
    pub data_url: String,
}

/// Is `bytes` something a person typed (as opposed to an xterm.js reply to a terminal
/// query, or a focus report)? Replies and reports start with an escape sequence.
pub(super) fn looks_like_keystroke(bytes: &[u8]) -> bool {
    match bytes {
        [] => false,
        [0x1b] => true,
        [0x1b, b'[' | b'O', b'A'..=b'D'] => true,
        [0x1b, ..] => false,
        _ => true,
    }
}

fn by_for(r: Resolution) -> &'static str {
    match r {
        Resolution::Chat => "chat",
        Resolution::Terminal => "terminal",
        Resolution::Timeout => "timeout",
        Resolution::NoChat
        | Resolution::HookGone
        | Resolution::TurnEnded
        | Resolution::Shutdown => "interrupt",
    }
}

fn parse_prompt_id(s: &str) -> Option<PromptId> {
    s.strip_prefix("prompt-")
        .unwrap_or(s)
        .parse::<u64>()
        .ok()
        .map(PromptId)
}

fn compose_chips(payload: &Chips, meta: &Meta, screen_mode: Option<&str>) -> Chips {
    let mut c = payload.clone();
    if meta.mode.is_some() {
        c.mode.clone_from(&meta.mode);
    }
    if let Some(m) = screen_mode {
        c.mode = Some(m.to_owned());
    }
    if c.pr_url.is_none() {
        c.pr_url.clone_from(&meta.pr_url);
    }
    if c.worktree.is_none() {
        c.worktree.clone_from(&meta.worktree);
    }
    if c.cost.is_none() {
        c.cost = meta.cost_usd;
    }
    c
}

impl Manager {
    // ---- lifecycle ----

    pub(super) fn user_status_line_padding(&self, cwd: &str) -> Option<i64> {
        resolve_user_status_line(&[PathBuf::from(cwd)], self.cfg.claude_config_dir.as_deref())
            .and_then(|s| s.padding)
    }

    fn chat_of(&self, id: &str) -> Option<Arc<Chat>> {
        lock(&self.chats).get(id).cloned()
    }

    fn make_chat(
        self: &Arc<Self>,
        id: &str,
        locator: Locator,
        poll: Duration,
    ) -> Option<Arc<Chat>> {
        let weak: Weak<Manager> = Arc::downgrade(self);
        let id_owned = id.to_owned();
        let watcher = Watcher::spawn(Adapter::new(locator), poll, move |adapter, update| {
            if let Some(m) = weak.upgrade() {
                m.on_transcript_update(&id_owned, adapter, update);
            }
        })
        .ok()?;
        let chat = Arc::new(Chat {
            watcher,
            state: Mutex::new(ChatState::default()),
        });
        let mut chats = lock(&self.chats);
        // Another thread may have raced us; keep the first.
        Some(Arc::clone(chats.entry(id.to_owned()).or_insert(chat)))
    }

    /// Start (or speed up) the transcript watcher of a claude DM that just launched.
    pub(super) fn start_chat(self: &Arc<Self>, id: &str, cwd: &str, claude_sid: Option<&str>) {
        if let Some(chat) = self.chat_of(id) {
            chat.watcher.set_interval(LIVE_POLL);
            chat.watcher.kick();
            return;
        }
        let (Some(cfg), Some(sid)) = (self.cfg.claude_config_dir.clone(), claude_sid) else {
            return;
        };
        let locator = Locator {
            config_dir: cfg,
            cwd: PathBuf::from(cwd),
            session_id: sid.to_owned(),
            explicit: None,
        };
        self.make_chat(id, locator, LIVE_POLL);
    }

    /// The chat of a DM, created on demand from the stored row (history of an exited DM).
    fn chat_for_read(self: &Arc<Self>, id: &str) -> Result<Arc<Chat>> {
        if let Some(c) = self.chat_of(id) {
            return Ok(c);
        }
        let conv = self.conversation(id)?;
        let spec = super::AdapterState::parse(&conv.adapter_state);
        let (Some(cfg), Some(sid), true) = (
            self.cfg.claude_config_dir.clone(),
            conv.session_id.clone(),
            spec.is_claude(),
        ) else {
            return Err(Error::Invalid("this DM has no claude transcript".into()));
        };
        let locator = Locator {
            config_dir: cfg,
            cwd: PathBuf::from(conv.cwd.unwrap_or_default()),
            session_id: sid,
            explicit: None,
        };
        self.make_chat(id, locator, IDLE_POLL)
            .ok_or_else(|| Error::Invalid("cannot start the transcript watcher".into()))
    }

    pub(super) fn drop_chat(&self, id: &str) {
        let chat = lock(&self.chats).remove(id);
        if let Some(c) = chat {
            c.watcher.stop();
        }
    }

    pub(super) fn stop_chats(&self) {
        let all: Vec<Arc<Chat>> = lock(&self.chats).drain().map(|(_, c)| c).collect();
        for c in all {
            c.watcher.stop();
        }
    }

    pub(super) fn on_session_exit(&self, id: &str) {
        if self.shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        // The process is gone, so whatever waited on it can no longer be answered.
        self.clear_needs_you(id);
        if let Some(chat) = self.chat_of(id) {
            chat.watcher.set_interval(IDLE_POLL);
        }
    }

    // ---- commands ----

    /// `chat_history {id, before?, limit?}`.
    ///
    /// # Errors
    /// Unknown id, or a DM without a claude transcript.
    pub fn chat_history(
        self: &Arc<Self>,
        id: &str,
        before: Option<Cursor>,
        limit: Option<usize>,
    ) -> Result<Page> {
        let chat = self.chat_for_read(id)?;
        chat.watcher.sync();
        Ok(chat
            .watcher
            .with(|a| a.history(before.as_ref(), limit.unwrap_or(DEFAULT_PAGE))))
    }

    /// `chat_thread {id, toolUseId}`: the items of a subagent.
    ///
    /// # Errors
    /// Unknown id, or a DM without a claude transcript.
    pub fn chat_thread(
        self: &Arc<Self>,
        id: &str,
        tool_use_id: &str,
    ) -> Result<Vec<patchroom_claude::ChatItem>> {
        let chat = self.chat_for_read(id)?;
        chat.watcher.sync();
        Ok(chat.watcher.with(|a| a.thread(tool_use_id)))
    }

    /// `chat_image {id, ref}`.
    ///
    /// # Errors
    /// Unknown id, or an unknown or unreadable image ref.
    pub fn chat_image(self: &Arc<Self>, id: &str, image_ref: &str) -> Result<ImageData> {
        let chat = self.chat_for_read(id)?;
        chat.watcher
            .with(|a| a.image(image_ref))
            .map(|data_url| ImageData { data_url })
            .ok_or_else(|| Error::Invalid(format!("no image for ref {image_ref:?}")))
    }

    /// `session_mark_read {id}`: clear the unread count. Never touches needs-you.
    ///
    /// # Errors
    /// Unknown id.
    pub fn mark_read(&self, id: &str) -> Result<()> {
        let conv = parse_id(id)?;
        let b = lock(&self.store).clear_unread(&Author::me(), conv)?;
        self.emit_badges(id, b.unread, b.needs_you);
        Ok(())
    }

    /// `statusline_cycle_mode {id}`: Shift+Tab to the PTY.
    ///
    /// # Errors
    /// Unknown id or exited session.
    pub fn cycle_mode(self: &Arc<Self>, id: &str) -> Result<()> {
        self.enqueue(id, WriteJob::Bytes(SHIFT_TAB.to_vec()))?;
        self.schedule_mode_scrape(id);
        Ok(())
    }

    /// Read the permission mode off the TUI footer shortly from now (the footer repaints
    /// after the key lands). One pending read per session.
    pub(super) fn schedule_mode_scrape(self: &Arc<Self>, id: &str) {
        let Some(chat) = self.chat_of(id) else { return };
        {
            let mut st = lock(&chat.state);
            if st.mode_scrape_pending {
                return;
            }
            st.mode_scrape_pending = true;
        }
        let me = Arc::clone(self);
        let id = id.to_owned();
        let spawned = std::thread::Builder::new()
            .name("patchroom-mode-scrape".into())
            .spawn(move || {
                std::thread::sleep(MODE_SCRAPE_DELAY);
                me.scrape_mode(&id);
            });
        if spawned.is_err() {
            lock(&chat.state).mode_scrape_pending = false;
        }
    }

    fn scrape_mode(&self, id: &str) {
        let Some(chat) = self.chat_of(id) else { return };
        let mode = self
            .live_of(id)
            .ok()
            .and_then(|l| l.screen.as_ref().and_then(|s| lock(s).mode()));
        {
            let mut st = lock(&chat.state);
            st.mode_scrape_pending = false;
            if mode.is_none() || st.screen_mode == mode {
                return;
            }
            st.screen_mode = mode;
        }
        let meta = chat.watcher.with(|a| a.meta().clone());
        self.refresh_statusline(id, &chat, &meta);
    }

    /// `session_view {id, view}`: tell the backend whether the DM shows the chat or the
    /// terminal. While the terminal is shown, a hidden AskUserQuestion picker is handed to
    /// the TUI at once instead of waiting for a chat answer.
    ///
    /// # Errors
    /// Unknown id.
    pub fn set_view(&self, id: &str, terminal: bool) -> Result<()> {
        parse_id(id)?;
        if let Some(chat) = self.chat_of(id) {
            lock(&chat.state).terminal_view = terminal;
        }
        if terminal {
            self.release_questions_to_terminal(id);
        }
        Ok(())
    }

    /// `prompt_answer {id, promptId, answer}`.
    ///
    /// # Errors
    /// Unknown prompt (already resolved), wrong answer kind, or `allow_always` without
    /// permission suggestions.
    pub fn prompt_answer(&self, id: &str, prompt_id: &str, answer: PromptAnswer) -> Result<()> {
        let pid = parse_prompt_id(prompt_id)
            .ok_or_else(|| Error::Invalid(format!("bad prompt id {prompt_id:?}")))?;
        let chat = self
            .chat_of(id)
            .ok_or_else(|| Error::NoSession(id.to_owned()))?;
        let kind = lock(&chat.state)
            .prompts
            .get(&pid)
            .map(|p| p.kind)
            .ok_or_else(|| Error::Invalid(format!("{prompt_id} is not pending")))?;
        let to_err = |e: patchroom_bridge::AnswerError| Error::Invalid(e.to_string());
        match answer {
            PromptAnswer::Terminal => {
                if self.bridge.release_to_terminal(pid) {
                    Ok(())
                } else {
                    Err(Error::Invalid(format!("{prompt_id} is not pending")))
                }
            }
            PromptAnswer::Allow | PromptAnswer::AllowAlways | PromptAnswer::Deny { .. }
                if kind == PromptKind::Question =>
            {
                Err(Error::Invalid(
                    "a question needs answers, not allow or deny".into(),
                ))
            }
            PromptAnswer::Questions { .. } if kind == PromptKind::Plan => Err(Error::Invalid(
                "a plan takes allow, allow_always (auto mode) or deny (revise)".into(),
            )),
            PromptAnswer::Allow if kind == PromptKind::Plan => {
                self.answer_plan(id, pid, &PlanChoice::Approve)
            }
            PromptAnswer::AllowAlways if kind == PromptKind::Plan => {
                self.answer_plan(id, pid, &PlanChoice::ApproveAuto)
            }
            PromptAnswer::Deny { message } if kind == PromptKind::Plan => {
                let text = message
                    .filter(|m| !m.trim().is_empty())
                    .unwrap_or_else(|| "Please revise the plan.".to_owned());
                self.answer_plan(id, pid, &PlanChoice::Revise(text))
            }
            PromptAnswer::Allow => self
                .bridge
                .answer_permission(pid, PermissionAnswer::Allow)
                .map_err(to_err),
            PromptAnswer::AllowAlways => self
                .bridge
                .answer_permission(pid, PermissionAnswer::AllowAlways)
                .map_err(to_err),
            PromptAnswer::Deny { message } => self
                .bridge
                .answer_permission(
                    pid,
                    PermissionAnswer::Deny {
                        message: message
                            .filter(|m| !m.trim().is_empty())
                            .unwrap_or_else(|| "Denied from the Patchroom chat.".to_owned()),
                    },
                )
                .map_err(to_err),
            PromptAnswer::Questions { answers } => {
                if kind != PromptKind::Question {
                    return Err(Error::Invalid(
                        "only a question takes answers; use allow or deny".into(),
                    ));
                }
                let mut qa = QuestionAnswers::new();
                for (q, a) in answers {
                    qa = qa.with(q, a);
                }
                self.bridge.answer_question(pid, qa).map_err(to_err)
            }
        }
    }

    /// Answer a plan approval through the TUI dialog: release the hold, wait for the dialog
    /// to draw, read which digit is which option, and press it. No hook decision can close
    /// this dialog. Blocks up to [`PLAN_DIALOG_WAIT`].
    fn answer_plan(&self, id: &str, pid: PromptId, choice: &PlanChoice) -> Result<()> {
        let live = self.live_of(id)?;
        let screen = live
            .screen
            .as_ref()
            .ok_or_else(|| Error::Invalid("this DM has no terminal screen".into()))?;
        if !self.bridge.release(pid, Resolution::Chat) {
            return Err(Error::Invalid(format!("{pid} is not pending")));
        }
        let needles: &[&str] = match choice {
            PlanChoice::Approve => &["manually approve"],
            PlanChoice::ApproveAuto => &["auto mode", "auto-accept"],
            PlanChoice::Revise(_) => &["tell claude"],
        };
        let end = std::time::Instant::now() + PLAN_DIALOG_WAIT;
        let digit = loop {
            let text = lock(screen).text();
            // The last option is always "Tell Claude what to change": once it shows, the
            // whole dialog is drawn.
            if option_number(&text, &["tell claude"]).is_some() {
                if let Some(d) = option_number(&text, needles) {
                    break d;
                }
            }
            if std::time::Instant::now() >= end {
                return Err(Error::Invalid(
                    "the plan dialog did not show the expected option; answer it in the terminal"
                        .into(),
                ));
            }
            std::thread::sleep(Duration::from_millis(40));
        };
        // Let the dialog finish drawing before the key lands.
        self.enqueue(id, WriteJob::Sleep(Duration::from_millis(150)))?;
        self.enqueue(id, WriteJob::Bytes(digit.to_string().into_bytes()))?;
        if let PlanChoice::Revise(text) = choice {
            self.enqueue(id, WriteJob::Sleep(Duration::from_millis(500)))?;
            let flat: String = text
                .chars()
                .map(|c| if c == '\n' { ' ' } else { c })
                .collect();
            self.enqueue(id, WriteJob::Bytes(flat.into_bytes()))?;
            self.enqueue(id, WriteJob::Sleep(Duration::from_millis(200)))?;
            self.enqueue(id, WriteJob::Bytes(b"\r".to_vec()))?;
        }
        Ok(())
    }

    // ---- transcript updates ----

    /// Runs on the watcher thread (or a `sync` caller) with the adapter locked.
    pub(super) fn on_transcript_update(&self, id: &str, adapter: &mut Adapter, update: Update) {
        if !update.items.is_empty() && (!update.initial || update.reset) {
            self.emit_items(id, &update.items);
        }
        if update.new_assistant > 0 {
            if let Ok(conv) = parse_id(id) {
                let b = lock(&self.store).add_unread(&Author::me(), conv, update.new_assistant);
                if let Ok(b) = b {
                    self.emit_badges(id, b.unread, b.needs_you);
                }
            }
        }
        let Some(chat) = self.chat_of(id) else { return };
        if update.meta_changed {
            self.refresh_statusline(id, &chat, adapter.meta());
        }
        self.try_emit_prompts(id, &chat, adapter, false);
    }

    fn emit_items(&self, id: &str, items: &[patchroom_claude::ChatItem]) {
        if let Ok(v) = serde_json::to_value(items) {
            self.sink.emit(UiEvent::ChatItems {
                id: id.to_owned(),
                items: v,
            });
        }
    }

    pub(super) fn on_hook_traffic(&self, key: &str, event: &str, transcript: Option<&Path>) {
        let Some(chat) = self.chat_of(key) else {
            return;
        };
        if let Some(p) = transcript {
            let follow = event == "SessionStart";
            chat.watcher.with(|a| {
                if (follow || a.path().is_none()) && a.set_transcript(p) {
                    // The next poll reads the new file.
                }
            });
        }
        chat.watcher.kick();
    }

    // ---- badges ----

    fn emit_badges(&self, id: &str, unread: u32, needs_you: bool) {
        self.sink.emit(UiEvent::Badges {
            id: id.to_owned(),
            unread,
            needs_you,
        });
    }

    /// Set the persisted needs-you flag from presence (`waiting` means needs you).
    pub(super) fn note_needs_you(&self, id: &str, needs: bool) {
        let Ok(conv) = parse_id(id) else { return };
        let store = lock(&self.store);
        let Ok(current) = store.badges(conv) else {
            return;
        };
        if current.needs_you == needs {
            return;
        }
        if let Ok(b) = store.set_needs_you(&Author::me(), conv, needs) {
            drop(store);
            self.emit_badges(id, b.unread, b.needs_you);
        }
    }

    pub(super) fn clear_needs_you(&self, id: &str) {
        self.note_needs_you(id, false);
    }

    // ---- prompts ----

    pub(super) fn on_permission_prompt(self: &Arc<Self>, p: &PermissionPrompt) {
        let Some(key) = p.session.key.as_deref() else {
            return;
        };
        let Some(chat) = self.chat_of(key) else {
            return;
        };
        let can_always = match &p.suggestions {
            Value::Array(a) => !a.is_empty(),
            Value::Null => false,
            _ => true,
        };
        lock(&chat.state).prompts.insert(
            p.id,
            OpenPrompt {
                kind: PromptKind::Permission,
                tool_name: p.tool_name.clone(),
                tool_input: p.tool_input.clone(),
                tool_use_id: None,
                questions: None,
                can_always,
                emitted: false,
                awaiting_link: false,
            },
        );
        // Look now, then once more after the grace period (the tool_use line trails the
        // hook by about 100 ms).
        chat.watcher.kick();
        chat.watcher
            .with(|a| self.try_emit_prompts(key, &chat, a, false));
        let me = Arc::clone(self);
        let (key, chat2) = (key.to_owned(), Arc::clone(&chat));
        let timer = std::thread::Builder::new()
            .name("patchroom-prompt-link".into())
            .spawn(move || {
                std::thread::sleep(LINK_WAIT);
                chat2
                    .watcher
                    .with(|a| me.try_emit_prompts(&key, &chat2, a, true));
            });
        drop(timer);
    }

    pub(super) fn on_question_prompt(&self, q: &QuestionPrompt) {
        let Some(key) = q.session.key.as_deref() else {
            return;
        };
        let Some(chat) = self.chat_of(key) else {
            return;
        };
        let questions = serde_json::to_value(&q.questions).unwrap_or(Value::Null);
        let mut input = q.tool_input.clone();
        patchroom_claude::cap_strings(&mut input, PROMPT_INPUT_STRING_LIMIT);
        let release_now = {
            let mut st = lock(&chat.state);
            if st.terminal_view {
                true
            } else {
                st.prompts.insert(
                    q.id,
                    OpenPrompt {
                        kind: PromptKind::Question,
                        tool_name: "AskUserQuestion".to_owned(),
                        tool_input: input,
                        tool_use_id: q.tool_use_id.clone(),
                        questions: Some(questions),
                        can_always: false,
                        emitted: true,
                        awaiting_link: false,
                    },
                );
                if let Some(p) = st.prompts.get(&q.id) {
                    self.sink.emit(UiEvent::PromptPending {
                        id: key.to_owned(),
                        payload: pending_payload(key, q.id, p),
                    });
                }
                false
            }
        };
        if release_now {
            // The DM shows the terminal: let the TUI draw its picker right away.
            self.bridge.release_to_terminal(q.id);
        }
    }

    pub(super) fn on_plan_prompt(&self, p: &PlanPrompt) {
        let Some(key) = p.session.key.as_deref() else {
            return;
        };
        let Some(chat) = self.chat_of(key) else {
            return;
        };
        let mut input = p.tool_input.clone();
        patchroom_claude::cap_strings(&mut input, PLAN_STRING_LIMIT);
        let release_now = {
            let mut st = lock(&chat.state);
            if st.terminal_view {
                true
            } else {
                st.prompts.insert(
                    p.id,
                    OpenPrompt {
                        kind: PromptKind::Plan,
                        tool_name: "ExitPlanMode".to_owned(),
                        tool_input: input,
                        tool_use_id: p.tool_use_id.clone(),
                        questions: None,
                        // "Yes, and use auto mode" is the plan dialog's own always.
                        can_always: true,
                        emitted: true,
                        awaiting_link: false,
                    },
                );
                if let Some(open) = st.prompts.get(&p.id) {
                    self.sink.emit(UiEvent::PromptPending {
                        id: key.to_owned(),
                        payload: pending_payload(key, p.id, open),
                    });
                }
                false
            }
        };
        if release_now {
            self.bridge.release_to_terminal(p.id);
        }
    }

    /// Announce permission prompts whose `tool_use` is now in the transcript (or
    /// all of them, when `force`). Called with the adapter locked.
    fn try_emit_prompts(&self, id: &str, chat: &Chat, adapter: &mut Adapter, force: bool) {
        let mut pending_items = Vec::new();
        {
            let mut st = lock(&chat.state);
            let claimed: Vec<String> = st
                .prompts
                .values()
                .filter_map(|p| p.tool_use_id.clone())
                .collect();
            let mut ids: Vec<PromptId> = st
                .prompts
                .iter()
                .filter(|(_, p)| !p.emitted && p.kind == PromptKind::Permission)
                .map(|(k, _)| *k)
                .collect();
            ids.sort();
            for pid in ids {
                let Some(p) = st.prompts.get_mut(&pid) else {
                    continue;
                };
                if p.tool_use_id.is_none() {
                    p.tool_use_id = adapter.find_open_tool(&p.tool_name, &p.tool_input, &claimed);
                }
                if p.tool_use_id.is_none() && !force {
                    continue;
                }
                if let Some(tu) = &p.tool_use_id {
                    if let Some(item) = adapter.set_tool_pending(tu, true) {
                        pending_items.push(item);
                    }
                }
                p.emitted = true;
                p.awaiting_link = p.tool_use_id.is_none();
                let mut shown = p.tool_input.clone();
                patchroom_claude::cap_strings(&mut shown, PROMPT_INPUT_STRING_LIMIT);
                let payload = pending_payload_with(id, pid, p, &shown);
                self.sink.emit(UiEvent::PromptPending {
                    id: id.to_owned(),
                    payload,
                });
            }
        }
        // A prompt announced without its tool_use (the line trailed LINK_WAIT) keeps
        // watching. Once the line lands, announce again with the same promptId.
        {
            let mut st = lock(&chat.state);
            let claimed: Vec<String> = st
                .prompts
                .values()
                .filter_map(|p| p.tool_use_id.clone())
                .collect();
            let mut ids: Vec<PromptId> = st
                .prompts
                .iter()
                .filter(|(_, p)| p.emitted && p.awaiting_link && p.kind == PromptKind::Permission)
                .map(|(k, _)| *k)
                .collect();
            ids.sort();
            let mut claimed = claimed;
            for pid in ids {
                let Some(p) = st.prompts.get_mut(&pid) else {
                    continue;
                };
                let found = adapter.find_open_tool(&p.tool_name, &p.tool_input, &claimed);
                if !relink(p, found) {
                    continue;
                }
                if let Some(tu) = &p.tool_use_id {
                    claimed.push(tu.clone());
                    if let Some(item) = adapter.set_tool_pending(tu, true) {
                        pending_items.push(item);
                    }
                }
                let mut shown = p.tool_input.clone();
                patchroom_claude::cap_strings(&mut shown, PROMPT_INPUT_STRING_LIMIT);
                let payload = pending_payload_with(id, pid, p, &shown);
                self.sink.emit(UiEvent::PromptPending {
                    id: id.to_owned(),
                    payload,
                });
            }
        }
        if !pending_items.is_empty() {
            self.emit_items(id, &pending_items);
        }
    }

    pub(super) fn on_prompt_resolved(&self, r: &PromptResolved) {
        let Some(key) = r.session.key.as_deref() else {
            return;
        };
        let Some(chat) = self.chat_of(key) else {
            return;
        };
        let Some(p) = lock(&chat.state).prompts.remove(&r.id) else {
            return;
        };
        if !p.emitted {
            // The UI never saw it (answered at once in the terminal): stay silent.
            return;
        }
        self.sink.emit(UiEvent::PromptResolved {
            id: key.to_owned(),
            prompt_id: r.id.to_string(),
            by: by_for(r.resolution),
        });
        if let Some(tu) = p.tool_use_id.filter(|_| p.kind == PromptKind::Permission) {
            let item = chat.watcher.with(|a| a.set_tool_pending(&tu, false));
            if let Some(item) = item {
                self.emit_items(key, &[item]);
            }
        }
        chat.watcher.kick();
    }

    /// Release every held prompt (question or plan) of `id` to the TUI. Returns true if any.
    pub(super) fn release_questions_to_terminal(&self, id: &str) -> bool {
        let Some(chat) = self.chat_of(id) else {
            return false;
        };
        let ids: Vec<PromptId> = lock(&chat.state)
            .prompts
            .iter()
            .filter(|(_, p)| p.kind != PromptKind::Permission)
            .map(|(k, _)| *k)
            .collect();
        let mut any = false;
        for pid in ids {
            any |= self.bridge.release_to_terminal(pid);
        }
        any
    }

    // ---- status strip ----

    pub(super) fn on_statusline(self: &Arc<Self>, rec: &StatuslineRecord) {
        let Some(key) = rec.session.key.as_deref() else {
            return;
        };
        let Some(chat) = self.chat_of(key) else {
            return;
        };
        {
            let mut st = lock(&chat.state);
            st.status_text.clone_from(&rec.output);
            st.payload_chips = chips_from_payload(&rec.payload);
        }
        let meta = chat.watcher.with(|a| a.meta().clone());
        self.refresh_statusline(key, &chat, &meta);
        // claude re-renders the status line when the permission mode changes; read the
        // footer once it has repainted.
        self.schedule_mode_scrape(key);
    }

    fn refresh_statusline(&self, id: &str, chat: &Chat, meta: &Meta) {
        let mut st = lock(&chat.state);
        let chips = compose_chips(&st.payload_chips, meta, st.screen_mode.as_deref());
        let next = (st.status_text.clone(), chips);
        if st.last_statusline.as_ref() == Some(&next) {
            return;
        }
        st.last_statusline = Some(next.clone());
        drop(st);
        self.sink.emit(UiEvent::Statusline {
            id: id.to_owned(),
            text: next.0,
            chips: serde_json::to_value(&next.1).unwrap_or(Value::Null),
        });
    }
}

/// Attach a late-found `tool_use` id to a prompt that was announced without one.
/// True when the prompt must be announced again.
fn relink(p: &mut OpenPrompt, found: Option<String>) -> bool {
    if !p.awaiting_link {
        return false;
    }
    match found {
        Some(tu) => {
            p.tool_use_id = Some(tu);
            p.awaiting_link = false;
            true
        }
        None => false,
    }
}

fn pending_payload(id: &str, pid: PromptId, p: &OpenPrompt) -> Value {
    pending_payload_with(id, pid, p, &p.tool_input)
}

fn pending_payload_with(id: &str, pid: PromptId, p: &OpenPrompt, input: &Value) -> Value {
    let mut v = json!({
        "id": id,
        "promptId": pid.to_string(),
        "kind": p.kind.as_str(),
        "toolName": p.tool_name,
        "toolInput": input,
        "canAlways": p.can_always,
    });
    if let Some(tu) = &p.tool_use_id {
        v["toolUseId"] = json!(tu);
    }
    if let Some(q) = &p.questions {
        v["questions"] = q.clone();
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_tool_use_is_re_announced_once() {
        let mut p = OpenPrompt {
            kind: PromptKind::Permission,
            tool_name: "Bash".into(),
            tool_input: json!({"command": "ls"}),
            tool_use_id: None,
            questions: None,
            can_always: true,
            emitted: true,
            awaiting_link: true,
        };
        assert!(!relink(&mut p, None));
        assert!(p.awaiting_link);
        assert!(relink(&mut p, Some("toolu_1".into())));
        assert_eq!(p.tool_use_id.as_deref(), Some("toolu_1"));
        let v = pending_payload("dm", PromptId(7), &p);
        assert_eq!(v["toolUseId"], "toolu_1");
        assert!(!relink(&mut p, Some("toolu_2".into())));
        assert_eq!(p.tool_use_id.as_deref(), Some("toolu_1"));
    }

    #[test]
    fn keystrokes_are_told_from_terminal_replies() {
        assert!(looks_like_keystroke(b"1"));
        assert!(looks_like_keystroke(b"\r"));
        assert!(looks_like_keystroke(b"hello"));
        assert!(looks_like_keystroke(b"\x1b"));
        assert!(looks_like_keystroke(b"\x1b[B"));
        assert!(looks_like_keystroke(b"\x1bOA"));
        assert!(!looks_like_keystroke(b"\x1b[I"));
        assert!(!looks_like_keystroke(b"\x1b[O"));
        assert!(!looks_like_keystroke(b"\x1b[?62;4c"));
        assert!(!looks_like_keystroke(b"\x1b[>0;276;0c"));
        assert!(!looks_like_keystroke(b"\x1b]7501;ok\x07"));
        assert!(!looks_like_keystroke(b""));
    }

    #[test]
    fn dialog_options_are_read_from_the_emulated_screen() {
        let mut screen = Screen::new(24, 80);
        // The TUI prints words with cursor moves and repaints only what changed.
        screen.feed(
            "\u{1b}[2J\u{1b}[1;1HWould you like to proceed?\r\n\u{276f} 1.\u{1b}[1CYes,\u{1b}[1Cand\u{1b}[1Cuse\u{1b}[1Cauto\u{1b}[1Cmode\r\n  2.\u{1b}[1CYes,\u{1b}[1Cmanually\u{1b}[1Capprove\u{1b}[1Cedits\r\n  3.\u{1b}[1CTell\u{1b}[1CClaude\u{1b}[1Cwhat\u{1b}[1Cto\u{1b}[1Cchange"
                .as_bytes(),
        );
        let text = screen.text();
        assert!(text.contains("2. Yes, manually approve edits"), "{text}");
        assert_eq!(option_number(&text, &["manually approve"]), Some(2));
        assert_eq!(option_number(&text, &["auto mode", "auto-accept"]), Some(1));
        assert_eq!(option_number(&text, &["tell claude"]), Some(3));
        assert_eq!(option_number(&text, &["no such label"]), None);
        // A later repaint that only moves the cursor marker keeps the labels readable.
        screen.feed("\u{1b}[2;1H \u{1b}[3;1H\u{276f}".as_bytes());
        assert_eq!(
            option_number(&screen.text(), &["manually approve"]),
            Some(2)
        );
        screen.resize(30, 100);
        assert_eq!(option_number(&screen.text(), &["tell claude"]), Some(3));
    }

    #[test]
    fn mode_is_read_from_the_footer() {
        let cases = [
            ("some output\n  \u{23f5}\u{23f5} auto mode on (shift+tab to cycle) \u{b7} \u{2190} for agents", "auto"),
            ("\u{23f8} manual mode on \u{b7} \u{2190} for agents", "default"),
            ("\u{23f8} plan mode on (shift+tab to cycle)", "plan"),
            ("\u{23f5}\u{23f5} accept edits on (shift+tab to cycle)", "acceptEdits"),
            ("\u{23f5}\u{23f5} bypass permissions on (shift+tab to cycle)", "bypassPermissions"),
        ];
        for (text, want) in cases {
            assert_eq!(mode_from_screen(text).as_deref(), Some(want), "{text}");
        }
        assert_eq!(mode_from_screen("no footer here"), None);
        // The newest (lowest) footer wins over stale text above it.
        assert_eq!(
            mode_from_screen("auto mode on\n...\nplan mode on").as_deref(),
            Some("plan")
        );
    }

    #[test]
    fn prompt_ids_round_trip() {
        assert_eq!(parse_prompt_id("prompt-12"), Some(PromptId(12)));
        assert_eq!(parse_prompt_id("12"), Some(PromptId(12)));
        assert_eq!(parse_prompt_id("nope"), None);
        assert_eq!(PromptId(7).to_string(), "prompt-7");
    }

    #[test]
    fn answers_parse_from_the_contract_json() {
        let a: PromptAnswer = serde_json::from_value(json!({"kind":"allow"})).unwrap();
        assert_eq!(a, PromptAnswer::Allow);
        let a: PromptAnswer = serde_json::from_value(json!({"kind":"allow_always"})).unwrap();
        assert_eq!(a, PromptAnswer::AllowAlways);
        let a: PromptAnswer = serde_json::from_value(json!({"kind":"deny"})).unwrap();
        assert_eq!(a, PromptAnswer::Deny { message: None });
        let a: PromptAnswer =
            serde_json::from_value(json!({"kind":"deny","message":"no"})).unwrap();
        assert_eq!(
            a,
            PromptAnswer::Deny {
                message: Some("no".into())
            }
        );
        let a: PromptAnswer =
            serde_json::from_value(json!({"kind":"questions","answers":{"Color?":"Red, Blue"}}))
                .unwrap();
        assert!(
            matches!(a, PromptAnswer::Questions { answers } if answers["Color?"] == "Red, Blue")
        );
        let a: PromptAnswer = serde_json::from_value(json!({"kind":"terminal"})).unwrap();
        assert_eq!(a, PromptAnswer::Terminal);
        assert!(serde_json::from_value::<PromptAnswer>(json!({"kind":"bogus"})).is_err());
    }

    #[test]
    fn resolutions_map_to_the_contract_values() {
        assert_eq!(by_for(Resolution::Chat), "chat");
        assert_eq!(by_for(Resolution::Terminal), "terminal");
        assert_eq!(by_for(Resolution::Timeout), "timeout");
        assert_eq!(by_for(Resolution::TurnEnded), "interrupt");
        assert_eq!(by_for(Resolution::HookGone), "interrupt");
    }

    #[test]
    fn chips_prefer_the_transcript_mode_and_fill_gaps() {
        let payload = Chips {
            model: Some("Haiku".into()),
            mode: Some("default".into()),
            ..Chips::default()
        };
        let meta = Meta {
            mode: Some("plan".into()),
            pr_url: Some("https://example.test/pr/1".into()),
            worktree: Some("wt".into()),
            cost_usd: Some(0.5),
            ..Meta::default()
        };
        let c = compose_chips(&payload, &meta, None);
        assert_eq!(c.model.as_deref(), Some("Haiku"));
        assert_eq!(c.mode.as_deref(), Some("plan"));
        // The footer is what the TUI shows right now, so it wins.
        let c = compose_chips(&payload, &meta, Some("acceptEdits"));
        assert_eq!(c.mode.as_deref(), Some("acceptEdits"));
        assert_eq!(c.pr_url.as_deref(), Some("https://example.test/pr/1"));
        assert_eq!(c.worktree.as_deref(), Some("wt"));
        assert_eq!(c.cost, Some(0.5));
    }
}
