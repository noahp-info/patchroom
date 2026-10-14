//! Transcript line to chat item mapping.
//!
//! A [`Mapper`] is fed one JSONL line at a time and keeps the ordered item list. Every
//! line ends in exactly one of three outcomes (see [`Outcome`]):
//!
//! * **mapped**: it created or updated at least one [`ChatItem`];
//! * **hidden**: it is deliberately not shown, for a reason from the lists in
//!   [`HIDDEN_LINE_TYPES`], [`HIDDEN_ATTACHMENT_TYPES`] or the conditional rules below;
//! * **fallback**: it is unrecognized and becomes a `fallback` item ("View in terminal").
//!
//! Nothing is dropped silently, and no input can panic or stop the feed.
//!
//! # Hidden metadata
//!
//! Line types that carry session bookkeeping, not conversation, are listed with their
//! reason in [`HIDDEN_LINE_TYPES`]. Attachment types are context injections the model
//! sees but the TUI does not show; they are listed in [`HIDDEN_ATTACHMENT_TYPES`].
//! Conditional hiding:
//!
//! | Line | Hidden when | Reason |
//! |---|---|---|
//! | `user` | `isMeta` is true | `meta-user-message` (skill bodies, hook feedback, image notes) |
//! | `user` | `isCompactSummary` is true | `compact-summary` (the summary is internal) |
//! | `user` | text is only `<local-command-caveat>` or `<system-reminder>` blocks | `caveat-or-reminder` |
//! | `assistant` | a `thinking` block has no text (only a signature) | `thinking-signature-only` |
//! | `assistant` | a `text` block is empty | `empty-text-block` |
//! | `system` | `stop_hook_summary` with no errors and no prevented continuation | `stop-hook-ok` |
//! | `system` | `bridge_status` | `bridge-status` |
//! | `system` | `local_command` that only echoes the command already shown as a user line | `duplicate-command-echo` |
//!
//! Some hidden lines still feed the status strip chips through [`Meta`]: `permission-mode`
//! and `mode` (permission mode), `pr-link` (PR url), `worktree-state` (worktree name),
//! `ai-title` (title) and `cost-state` (cost).

use std::collections::{BTreeMap, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};

use serde_json::{json, Map, Value};

use crate::item::{
    ChatItem, Diff, DiffHunk, ImageRef, ItemBody, PlanState, QuestionSpec, QuestionState,
    SubagentState, ToolResult, ToolState,
};
use crate::text::{
    fmt_duration, parse_ts, strip_ansi, strip_blocks, tag_inner, truncate_strings, truncate_utf8,
    unwrap_pasted,
};

/// Largest tool result text kept in an item, in bytes.
pub const RESULT_TEXT_LIMIT: usize = 16 * 1024;

/// Largest string inside a tool input kept in an item, in bytes.
pub const INPUT_STRING_LIMIT: usize = 16 * 1024;

/// Most diff lines kept in one item.
const DIFF_LINE_LIMIT: usize = 2_000;

/// Every `system` item subtype this crate emits.
pub const SYSTEM_SUBTYPES: &[&str] = &[
    "compact_boundary",
    "local_command",
    "bash_output",
    "turn_duration",
    "api_error",
    "away_summary",
    "notice",
    "interrupted",
    "task_notification",
    "stop_hook",
    "hook_error",
];

/// Top-level line types that are session bookkeeping. Each is hidden, with its reason.
pub const HIDDEN_LINE_TYPES: &[(&str, &str)] = &[
    ("last-prompt", "bookkeeping: pointer to the last prompt"),
    ("mode", "bookkeeping: feeds the mode chip"),
    ("permission-mode", "bookkeeping: feeds the mode chip"),
    ("ai-title", "bookkeeping: generated session title"),
    ("custom-title", "bookkeeping: user session title"),
    ("agent-name", "bookkeeping: agent display name"),
    ("pr-link", "bookkeeping: feeds the PR chip"),
    ("worktree-state", "bookkeeping: feeds the worktree chip"),
    ("cost-state", "bookkeeping: running cost totals"),
    ("queue-operation", "bookkeeping: prompt queue; the prompt itself arrives as a user line or queued_command attachment"),
    ("file-history-snapshot", "bookkeeping: undo snapshots"),
    ("file-history-delta", "bookkeeping: undo snapshots"),
    ("atis-latch", "bookkeeping: internal latch"),
    ("frame-link", "bookkeeping: artifact frame link"),
    ("relocated", "bookkeeping: working directory move"),
    ("bridge-session", "bookkeeping: remote bridge session"),
    ("artifact-autoreact-ledger", "bookkeeping: artifact ledger"),
    ("artifact-comment-monitor", "bookkeeping: artifact comment monitor"),
    ("summary", "bookkeeping: legacy conversation summary"),
    ("tag", "bookkeeping: session tag"),
    ("content-replacement", "bookkeeping: tool result replacement record"),
    ("speculation-accept", "bookkeeping: speculative execution record"),
    ("continued-in", "bookkeeping: this session continues in another session file"),
];

/// Attachment types that are context injections, not conversation. Each is hidden.
pub const HIDDEN_ATTACHMENT_TYPES: &[&str] = &[
    "total_tokens_reminder",
    "hook_success",
    "hook_non_blocking_error",
    "hook_cancelled",
    "hook_additional_context",
    "hook_permission_decision",
    "hook_system_message",
    "hook_stopped_continuation",
    "async_hook_response",
    "deferred_tools_record",
    "deferred_tools_delta",
    "environment",
    "batching_reminder_sent",
    "bash_output_audience_note",
    "task_reminder",
    "todo_reminder",
    "hook_additional_context",
    "edited_text_file",
    "silent_turn_reminder",
    "prompt_snapshot",
    "skill_listing",
    "date",
    "date_change",
    "agent_listing_delta",
    "mcp_instructions_delta",
    "remote_session_change",
    "model",
    "session_context",
    "credential_org",
    "file",
    "instructions",
    "command_permissions",
    "auto_mode",
    "auto_mode_exit",
    "invoked_skills",
    "nested_memory",
    "relevant_memories",
    "memory",
    "compact_file_reference",
    "task_status",
    "plan_mode",
    "plan_mode_exit",
    "plan_file_reference",
    "thinking_drop",
    "diagnostics",
    "skill_mention",
    "read_truncation_notice",
    "opened_file_in_ide",
    "selected_lines_in_ide",
    "mcp_resource",
    "agent_mention",
    "output_style",
    "ultrathink_effort",
    "critical_system_reminder",
];

/// Cut every string inside `v` to `limit` bytes, appending a note. Returns true when
/// anything was cut. Used for tool inputs that travel to the UI.
pub fn cap_strings(v: &mut Value, limit: usize) -> bool {
    truncate_strings(v, limit)
}

/// What happened to one line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// At least one item was created or updated.
    Mapped,
    /// Deliberately hidden. The reason is one short phrase.
    Hidden(&'static str),
    /// Unrecognized. A `fallback` item was created.
    Fallback,
}

/// Result of feeding one line.
#[derive(Debug, Clone, PartialEq)]
pub struct Feed {
    /// What happened to the line.
    pub outcome: Outcome,
    /// Indexes (into [`Mapper::items`]) of items created or updated, in order.
    pub changed: Vec<usize>,
    /// [`Mapper::meta`] changed.
    pub meta_changed: bool,
}

/// Line accounting for `dump` and the corpus checks.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Accounting {
    /// Non-empty lines fed.
    pub lines: u64,
    /// Items in the final list.
    pub items: u64,
    /// Lines hidden as metadata.
    pub hidden: u64,
    /// Lines that fell back.
    pub fallback: u64,
    /// Lines that were not valid JSON objects, or that hit an internal failure.
    /// Each also falls back, so `lines = mapped + hidden + fallback` still holds.
    pub errors: u64,
}

/// Session facts from hidden lines, for the status strip chips.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Meta {
    /// Permission mode (`default`, `plan`, `auto`, `acceptEdits`, ...).
    pub mode: Option<String>,
    /// PR url.
    pub pr_url: Option<String>,
    /// Worktree name.
    pub worktree: Option<String>,
    /// Generated session title.
    pub title: Option<String>,
    /// Total cost in USD.
    pub cost_usd: Option<f64>,
}

/// A transcript line to item mapper for one file.
pub struct Mapper {
    file_tag: String,
    parent: Option<String>,
    items: Vec<ChatItem>,
    index: HashMap<String, usize>,
    agent_ids: HashMap<String, String>,
    meta: Meta,
    acct: Accounting,
    hidden_reasons: BTreeMap<String, u64>,
    fallback_types: BTreeMap<String, u64>,
    cur_changed: Vec<usize>,
    cur_fallback: bool,
    cur_meta: bool,
    cur_error: bool,
    cur_hidden: Option<&'static str>,
}

impl Mapper {
    /// A mapper for the main transcript (`file_tag` "main") or a subagent file (its agent id).
    /// `parent` becomes `parentToolUseId` on every item.
    pub fn new(file_tag: impl Into<String>, parent: Option<String>) -> Self {
        Self {
            file_tag: file_tag.into(),
            parent,
            items: Vec::new(),
            index: HashMap::new(),
            agent_ids: HashMap::new(),
            meta: Meta::default(),
            acct: Accounting::default(),
            hidden_reasons: BTreeMap::new(),
            fallback_types: BTreeMap::new(),
            cur_changed: Vec::new(),
            cur_fallback: false,
            cur_meta: false,
            cur_error: false,
            cur_hidden: None,
        }
    }

    /// The ordered items.
    #[must_use]
    pub fn items(&self) -> &[ChatItem] {
        &self.items
    }

    /// The item with this key.
    #[must_use]
    pub fn item(&self, key: &str) -> Option<&ChatItem> {
        self.index.get(key).map(|&i| &self.items[i])
    }

    /// Position of the item with this key.
    #[must_use]
    pub fn position(&self, key: &str) -> Option<usize> {
        self.index.get(key).copied()
    }

    /// Facts from hidden lines.
    #[must_use]
    pub fn meta(&self) -> &Meta {
        &self.meta
    }

    /// Line accounting so far (`items` is filled in).
    #[must_use]
    pub fn accounting(&self) -> Accounting {
        let mut a = self.acct.clone();
        a.items = self.items.len() as u64;
        a
    }

    /// Hidden line counts by reason.
    #[must_use]
    pub fn hidden_reasons(&self) -> &BTreeMap<String, u64> {
        &self.hidden_reasons
    }

    /// Fallback line counts by line type.
    #[must_use]
    pub fn fallback_types(&self) -> &BTreeMap<String, u64> {
        &self.fallback_types
    }

    /// The subagent id the Agent call `tool_use_id` started, once its result is seen.
    #[must_use]
    pub fn agent_id_of(&self, tool_use_id: &str) -> Option<&str> {
        self.agent_ids.get(tool_use_id).map(String::as_str)
    }

    /// Tool use ids of subagents that are still running.
    #[must_use]
    pub fn running_subagents(&self) -> Vec<String> {
        self.items
            .iter()
            .filter_map(|i| match &i.body {
                ItemBody::Subagent {
                    tool_use_id,
                    state: SubagentState::Running,
                    ..
                } => Some(tool_use_id.clone()),
                _ => None,
            })
            .collect()
    }

    /// Set the number of items in a subagent thread. Returns the item index when it changed.
    pub fn set_subagent_count(&mut self, tool_use_id: &str, count: u64) -> Option<usize> {
        let i = *self.index.get(tool_use_id)?;
        match &mut self.items[i].body {
            ItemBody::Subagent { item_count, .. } if *item_count != count => {
                *item_count = count;
                Some(i)
            }
            _ => None,
        }
    }

    /// Set the state of a tool item (for example `pending` while a permission prompt is
    /// open). Only moves between `pending` and `running`, never overrides a result.
    pub fn set_tool_pending(&mut self, tool_use_id: &str, pending: bool) -> Option<usize> {
        let i = *self.index.get(tool_use_id)?;
        let want = if pending {
            ToolState::Pending
        } else {
            ToolState::Running
        };
        match &mut self.items[i].body {
            ItemBody::Tool { state, .. }
                if matches!(*state, ToolState::Pending | ToolState::Running) && *state != want =>
            {
                *state = want;
                Some(i)
            }
            _ => None,
        }
    }

    /// Feed one line. `offset` is the line's byte offset in its file (used in image refs
    /// and as a fallback key). Blank lines are ignored: they return `Hidden("blank")` and
    /// are not counted.
    pub fn feed(&mut self, line: &str, offset: u64) -> Feed {
        if line.trim().is_empty() {
            return Feed {
                outcome: Outcome::Hidden("blank"),
                changed: Vec::new(),
                meta_changed: false,
            };
        }
        self.acct.lines += 1;
        self.cur_changed.clear();
        self.cur_fallback = false;
        self.cur_meta = false;
        self.cur_error = false;
        self.cur_hidden = None;
        let ran = catch_unwind(AssertUnwindSafe(|| self.feed_inner(line, offset)));
        if ran.is_err() {
            self.cur_error = true;
            self.fallback_item(
                format!("@{}:{offset}", self.file_tag),
                0,
                "mapper-error",
                "internal mapping failure",
            );
        }
        if self.cur_error {
            self.acct.errors += 1;
        }
        let outcome = if self.cur_fallback {
            self.acct.fallback += 1;
            Outcome::Fallback
        } else if !self.cur_changed.is_empty() {
            Outcome::Mapped
        } else {
            let reason = self.cur_hidden.unwrap_or("no-visible-content");
            self.acct.hidden += 1;
            *self.hidden_reasons.entry(reason.to_owned()).or_insert(0) += 1;
            Outcome::Hidden(reason)
        };
        Feed {
            outcome,
            changed: std::mem::take(&mut self.cur_changed),
            meta_changed: self.cur_meta,
        }
    }

    fn feed_inner(&mut self, line: &str, offset: u64) {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                self.cur_error = true;
                self.fallback_item(
                    format!("@{}:{offset}", self.file_tag),
                    0,
                    "invalid-json",
                    &format!("line is not valid JSON ({e})"),
                );
                return;
            }
        };
        let Some(obj) = v.as_object() else {
            self.cur_error = true;
            self.fallback_item(
                format!("@{}:{offset}", self.file_tag),
                0,
                "non-object",
                "line is JSON but not an object",
            );
            return;
        };
        let ty = obj.get("type").and_then(Value::as_str).unwrap_or("");
        let ts = obj
            .get("timestamp")
            .and_then(Value::as_str)
            .map_or(0, parse_ts);
        let key_base = obj
            .get("uuid")
            .and_then(Value::as_str)
            .map_or_else(|| format!("@{}:{offset}", self.file_tag), str::to_owned);
        let line_ctx = LineCtx {
            obj,
            offset,
            ts,
            key_base,
        };
        match ty {
            "assistant" => self.on_assistant(&line_ctx),
            "user" => self.on_user(&line_ctx),
            "system" => self.on_system(&line_ctx),
            "attachment" => self.on_attachment(&line_ctx),
            "" => {
                self.fallback_item(
                    line_ctx.key_base.clone(),
                    ts,
                    "(no type)",
                    &describe_shape(obj),
                );
            }
            other => {
                if let Some((_, _)) = HIDDEN_LINE_TYPES.iter().find(|(t, _)| *t == other) {
                    self.on_meta_line(other, obj);
                    self.cur_hidden = Some(hidden_reason(other));
                } else {
                    self.fallback_item(line_ctx.key_base.clone(), ts, other, &describe_shape(obj));
                }
            }
        }
    }

    // ---- bookkeeping lines ----

    fn on_meta_line(&mut self, ty: &str, obj: &Map<String, Value>) {
        let s = |k: &str| obj.get(k).and_then(Value::as_str).map(str::to_owned);
        let before = self.meta.clone();
        match ty {
            "permission-mode" => self.meta.mode = s("permissionMode"),
            "mode" => {
                if self.meta.mode.is_none() {
                    self.meta.mode = s("mode");
                }
            }
            "pr-link" => self.meta.pr_url = s("prUrl"),
            "ai-title" => self.meta.title = s("aiTitle"),
            "worktree-state" => {
                self.meta.worktree = obj
                    .get("worktreeSession")
                    .and_then(|w| w.get("worktreeName"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            "cost-state" => {
                self.meta.cost_usd = obj.get("totalCostUSD").and_then(Value::as_f64);
            }
            _ => {}
        }
        if self.meta != before {
            self.cur_meta = true;
        }
    }

    // ---- assistant ----

    fn on_assistant(&mut self, l: &LineCtx<'_>) {
        let Some(msg) = l.obj.get("message") else {
            self.fallback_item(
                l.key_base.clone(),
                l.ts,
                "assistant",
                "assistant line has no message",
            );
            return;
        };
        let synthetic = msg.get("model").and_then(Value::as_str) == Some("<synthetic>");
        let is_error = l.obj.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true)
            || l.obj.get("error").is_some_and(|e| !e.is_null());
        let blocks: Vec<Value> = match msg.get("content") {
            Some(Value::Array(a)) => a.clone(),
            Some(Value::String(s)) => vec![json!({"type": "text", "text": s})],
            _ => {
                self.fallback_item(
                    l.key_base.clone(),
                    l.ts,
                    "assistant",
                    "assistant message has no content",
                );
                return;
            }
        };
        if blocks.is_empty() {
            self.cur_hidden = Some("empty-assistant-message");
            return;
        }
        for (idx, b) in blocks.iter().enumerate() {
            let key = format!("{}:{idx}", l.key_base);
            let bt = b.get("type").and_then(Value::as_str).unwrap_or("");
            match bt {
                "text" => {
                    let text = b.get("text").and_then(Value::as_str).unwrap_or("");
                    if text.trim().is_empty() {
                        self.cur_hidden = Some("empty-text-block");
                    } else if is_error {
                        self.push(key, l.ts, system("api_error", text));
                    } else if synthetic {
                        self.push(key, l.ts, system("notice", text));
                    } else {
                        self.push(
                            key,
                            l.ts,
                            ItemBody::Assistant {
                                text: text.to_owned(),
                            },
                        );
                    }
                }
                "thinking" => {
                    let text = b.get("thinking").and_then(Value::as_str).unwrap_or("");
                    if text.trim().is_empty() {
                        self.cur_hidden = Some("thinking-signature-only");
                    } else {
                        self.push(
                            key,
                            l.ts,
                            ItemBody::Thinking {
                                text: text.to_owned(),
                            },
                        );
                    }
                }
                "redacted_thinking" => self.cur_hidden = Some("thinking-signature-only"),
                "tool_use" => self.on_tool_use(b, l.ts),
                other => {
                    self.fallback_item(
                        key,
                        l.ts,
                        &format!("assistant:{other}"),
                        &format!("assistant content block of type {other:?}"),
                    );
                }
            }
        }
    }

    fn on_tool_use(&mut self, b: &Value, ts: i64) {
        let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
        let name = b
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if id.is_empty() || name.is_empty() {
            self.fallback_item(
                format!("@{}:tool-{}", self.file_tag, self.items.len()),
                ts,
                "assistant:tool_use",
                "tool_use block without id or name",
            );
            return;
        }
        if let Some(&i) = self.index.get(&id) {
            // Same call seen again (re-written history). Keep what we know, mark touched.
            self.cur_changed.push(i);
            return;
        }
        let input = b.get("input").cloned().unwrap_or(Value::Null);
        let body = match name.as_str() {
            "AskUserQuestion" => ItemBody::Question {
                tool_use_id: id.clone(),
                questions: parse_questions(&input),
                answers: None,
                state: QuestionState::Pending,
            },
            "ExitPlanMode" => ItemBody::Plan {
                tool_use_id: id.clone(),
                plan: input
                    .get("plan")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                state: PlanState::Pending,
            },
            "Agent" | "Task" => ItemBody::Subagent {
                tool_use_id: id.clone(),
                description: input
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                agent_type: input
                    .get("subagent_type")
                    .and_then(Value::as_str)
                    .unwrap_or("general-purpose")
                    .to_owned(),
                item_count: 0,
                state: SubagentState::Running,
            },
            _ => {
                let diff = diff_from_input(&name, &input);
                let mut input = input;
                let input_truncated = truncate_strings(&mut input, INPUT_STRING_LIMIT);
                ItemBody::Tool {
                    tool_use_id: id.clone(),
                    name,
                    input,
                    input_truncated,
                    state: ToolState::Running,
                    result: None,
                    diff,
                }
            }
        };
        self.push(id, ts, body);
    }

    // ---- user ----

    fn on_user(&mut self, l: &LineCtx<'_>) {
        let Some(msg) = l.obj.get("message") else {
            self.fallback_item(l.key_base.clone(), l.ts, "user", "user line has no message");
            return;
        };
        let content = msg.get("content");
        let has_result = matches!(content, Some(Value::Array(a))
            if a.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")));
        if has_result {
            self.on_tool_results(l, content.unwrap_or(&Value::Null));
            return;
        }
        if flag(l.obj, "isCompactSummary") {
            self.cur_hidden = Some("compact-summary");
            return;
        }
        if flag(l.obj, "isMeta") {
            self.cur_hidden = Some("meta-user-message");
            return;
        }
        let mut texts: Vec<String> = Vec::new();
        let mut images: Vec<ImageRef> = Vec::new();
        match content {
            Some(Value::String(s)) => texts.push(s.clone()),
            Some(Value::Array(blocks)) => {
                let mut n = 0usize;
                for b in blocks {
                    match b.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let t = b.get("text").and_then(Value::as_str).unwrap_or("");
                            if !t.trim_start().starts_with("[Image: source:") {
                                texts.push(t.to_owned());
                            }
                        }
                        Some("image") => {
                            images.push(self.image_ref(l.offset, n, b));
                            n += 1;
                        }
                        other => {
                            let t = other.unwrap_or("(none)");
                            self.fallback_item(
                                format!("{}:{n}:{t}", l.key_base),
                                l.ts,
                                &format!("user:{t}"),
                                &format!("user content block of type {t:?}"),
                            );
                        }
                    }
                }
            }
            _ => {
                self.fallback_item(
                    l.key_base.clone(),
                    l.ts,
                    "user",
                    "user message has no content",
                );
                return;
            }
        }
        let joined = texts.join("\n\n");
        self.user_text(&l.key_base, l.ts, &joined, images);
    }

    /// Classify user-side text and create the matching item.
    fn user_text(&mut self, key: &str, ts: i64, raw: &str, images: Vec<ImageRef>) {
        let mut t = strip_blocks(raw, "system-reminder");
        if t.contains("<local-command-caveat") {
            t = strip_blocks(&t, "local-command-caveat");
        }
        let t = t.trim();
        if t.is_empty() && images.is_empty() {
            self.cur_hidden = Some("caveat-or-reminder");
            return;
        }
        if let Some(inner) = tag_inner(t, "task-notification") {
            self.on_task_notification(key, ts, inner);
            return;
        }
        if t.starts_with("<command-name>") || t.contains("<command-name>") {
            let name = tag_inner(t, "command-name").unwrap_or("").trim();
            let args = tag_inner(t, "command-args").unwrap_or("").trim();
            let text = if args.is_empty() {
                name.to_owned()
            } else {
                format!("{name} {args}")
            };
            self.push(
                key.to_owned(),
                ts,
                ItemBody::User {
                    text,
                    images: Vec::new(),
                },
            );
            return;
        }
        if t.starts_with("<local-command-stdout") || t.starts_with("<local-command-stderr") {
            let inner = tag_inner(t, "local-command-stdout")
                .or_else(|| tag_inner(t, "local-command-stderr"))
                .unwrap_or(t);
            let text = strip_ansi(inner).trim().to_owned();
            self.push(
                key.to_owned(),
                ts,
                system(
                    "local_command",
                    if text.is_empty() {
                        "(no output)"
                    } else {
                        &text
                    },
                ),
            );
            return;
        }
        if let Some(cmd) = tag_inner(t, "bash-input") {
            self.push(
                key.to_owned(),
                ts,
                ItemBody::User {
                    text: format!("!{}", cmd.trim()),
                    images: Vec::new(),
                },
            );
            return;
        }
        if t.starts_with("<bash-stdout") || t.starts_with("<bash-stderr") {
            let out = tag_inner(t, "bash-stdout").unwrap_or("");
            let err = tag_inner(t, "bash-stderr").unwrap_or("");
            let mut text = strip_ansi(out).trim().to_owned();
            let err = strip_ansi(err);
            if !err.trim().is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(err.trim());
            }
            let (text, _) = truncate_utf8(&text, RESULT_TEXT_LIMIT);
            self.push(
                key.to_owned(),
                ts,
                system(
                    "bash_output",
                    if text.is_empty() {
                        "(no output)"
                    } else {
                        &text
                    },
                ),
            );
            return;
        }
        if t.starts_with("[Request interrupted by user") {
            self.push(key.to_owned(), ts, system("interrupted", t));
            return;
        }
        let text = unwrap_pasted(t).trim().to_owned();
        self.push(key.to_owned(), ts, ItemBody::User { text, images });
    }

    fn on_task_notification(&mut self, key: &str, ts: i64, inner: &str) {
        let field = |t: &str| tag_inner(inner, t).map(|s| s.trim().to_owned());
        let summary = field("summary").unwrap_or_else(|| "Background task update".to_owned());
        let status = field("status").unwrap_or_default();
        if let Some(tu) = field("tool-use-id") {
            if let Some(&i) = self.index.get(&tu) {
                if let ItemBody::Subagent { state, .. } = &mut self.items[i].body {
                    let next = match status.as_str() {
                        "completed" => SubagentState::Ok,
                        "failed" | "error" => SubagentState::Error,
                        "killed" | "stopped" | "cancelled" => SubagentState::Interrupted,
                        _ => *state,
                    };
                    if next != *state {
                        *state = next;
                        self.cur_changed.push(i);
                    }
                }
            }
        }
        let text = if status.is_empty() {
            summary
        } else {
            format!("{summary} ({status})")
        };
        self.push(key.to_owned(), ts, system("task_notification", &text));
    }

    fn on_tool_results(&mut self, l: &LineCtx<'_>, content: &Value) {
        let Some(blocks) = content.as_array() else {
            return;
        };
        let results: Vec<&Value> = blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
            .collect();
        let single = results.len() == 1;
        let denial = l
            .obj
            .get("toolDenialKind")
            .and_then(Value::as_str)
            .map(str::to_owned);
        // Image numbering runs over the whole line in document order.
        let mut image_n = 0usize;
        for b in blocks {
            match b.get("type").and_then(Value::as_str) {
                Some("tool_result") => {
                    let id = b.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                    let (text, images, consumed) = self.result_payload(b, l.offset, image_n);
                    image_n += consumed;
                    let tur = if single {
                        l.obj.get("toolUseResult")
                    } else {
                        None
                    };
                    let is_error = b.get("is_error").and_then(Value::as_bool) == Some(true);
                    self.apply_result(
                        id,
                        l.ts,
                        ResultIn {
                            text,
                            images,
                            is_error,
                            denial: denial.as_deref(),
                            tur,
                        },
                    );
                }
                Some("image") => image_n += 1,
                _ => {}
            }
        }
        // Text next to results (rare): show it as the user's own words.
        let extra: Vec<String> = blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str).map(str::to_owned))
            .collect();
        if !extra.is_empty() && !flag(l.obj, "isMeta") {
            let key = format!("{}:text", l.key_base);
            self.user_text(&key, l.ts, &extra.join("\n\n"), Vec::new());
        }
    }

    /// Text, image refs and the number of image blocks consumed for one tool_result block.
    fn result_payload(
        &self,
        b: &Value,
        offset: u64,
        image_start: usize,
    ) -> (String, Vec<ImageRef>, usize) {
        let mut n = 0usize;
        let mut images = Vec::new();
        let text = match b.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => {
                let mut texts = Vec::new();
                for p in parts {
                    match p.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(t) = p.get("text").and_then(Value::as_str) {
                                texts.push(t.to_owned());
                            }
                        }
                        Some("image") => {
                            images.push(self.image_ref(offset, image_start + n, p));
                            n += 1;
                        }
                        Some("tool_reference") => {
                            let name = p.get("tool_name").and_then(Value::as_str).unwrap_or("?");
                            texts.push(format!("[tool reference: {name}]"));
                        }
                        Some(other) => texts.push(format!("[{other} block]")),
                        None => {}
                    }
                }
                texts.join("\n")
            }
            _ => String::new(),
        };
        (text, images, n)
    }

    fn apply_result(&mut self, tool_use_id: &str, ts: i64, r: ResultIn<'_>) {
        if tool_use_id.is_empty() {
            self.fallback_item(
                format!("@{}:result-{}", self.file_tag, self.items.len()),
                ts,
                "user:tool_result",
                "tool_result block without tool_use_id",
            );
            return;
        }
        if !self.index.contains_key(tool_use_id) {
            // The call is not in this stream (tail started late, or history was cut).
            self.push(
                tool_use_id.to_owned(),
                ts,
                ItemBody::Tool {
                    tool_use_id: tool_use_id.to_owned(),
                    name: "(unknown tool)".to_owned(),
                    input: Value::Null,
                    input_truncated: false,
                    state: ToolState::Running,
                    result: None,
                    diff: None,
                },
            );
        }
        let Some(&i) = self.index.get(tool_use_id) else {
            return;
        };
        let denied = r.denial.is_some_and(|d| d != "cancelled")
            || (r.is_error && r.text.starts_with("The user doesn't want to proceed"));
        let cancelled = r.denial == Some("cancelled")
            || r.tur
                .and_then(|t| t.get("interrupted"))
                .and_then(Value::as_bool)
                == Some(true);
        let tur_str = r.tur.and_then(Value::as_str).unwrap_or("");
        match &mut self.items[i].body {
            ItemBody::Tool {
                state,
                result,
                diff,
                name,
                ..
            } => {
                *state = if cancelled {
                    ToolState::Interrupted
                } else if denied {
                    ToolState::Denied
                } else if r.is_error {
                    ToolState::Error
                } else {
                    ToolState::Ok
                };
                let (text, truncated) = truncate_utf8(&r.text, RESULT_TEXT_LIMIT);
                *result = Some(ToolResult {
                    text,
                    is_error: r.is_error,
                    truncated,
                    images: r.images,
                });
                if matches!(
                    name.as_str(),
                    "Edit" | "Write" | "MultiEdit" | "NotebookEdit"
                ) {
                    if let Some(d) = r.tur.and_then(diff_from_result) {
                        *diff = Some(d);
                    } else if *state != ToolState::Ok {
                        // A refused edit never happened: drop the speculative diff.
                        *diff = None;
                    }
                }
            }
            ItemBody::Question {
                questions,
                answers,
                state,
                ..
            } => {
                let found = r
                    .tur
                    .and_then(|t| t.get("answers"))
                    .and_then(Value::as_object)
                    .map(|o| {
                        o.iter()
                            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                            .collect::<BTreeMap<_, _>>()
                    })
                    .filter(|m| !m.is_empty())
                    .or_else(|| {
                        let m = parse_answer_pairs(&r.text);
                        (!m.is_empty()).then_some(m)
                    });
                let declined = r.text.contains("declined to answer")
                    || tur_str.contains("declined to answer")
                    || denied;
                if let Some(a) = found {
                    *answers = Some(a);
                    *state = QuestionState::Answered;
                } else if cancelled {
                    *state = QuestionState::Interrupted;
                } else if declined || r.is_error {
                    *state = QuestionState::Declined;
                } else {
                    *state = QuestionState::Answered;
                }
                let _ = questions;
            }
            ItemBody::Plan { state, .. } => {
                *state = if cancelled {
                    PlanState::Interrupted
                } else if denied || r.is_error {
                    PlanState::Rejected
                } else {
                    PlanState::Approved
                };
            }
            ItemBody::Subagent {
                state, item_count, ..
            } => {
                let status = r
                    .tur
                    .and_then(|t| t.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(aid) = r.tur.and_then(|t| t.get("agentId")).and_then(Value::as_str) {
                    self.agent_ids
                        .insert(tool_use_id.to_owned(), aid.to_owned());
                }
                *state = if cancelled {
                    SubagentState::Interrupted
                } else if r.is_error || denied {
                    SubagentState::Error
                } else if status == "async_launched" {
                    SubagentState::Running
                } else {
                    SubagentState::Ok
                };
                if let Some(n) = r
                    .tur
                    .and_then(|t| t.get("totalToolUseCount"))
                    .and_then(Value::as_u64)
                {
                    *item_count = (*item_count).max(n);
                }
            }
            _ => {}
        }
        self.cur_changed.push(i);
    }

    // ---- system ----

    fn on_system(&mut self, l: &LineCtx<'_>) {
        let sub = l.obj.get("subtype").and_then(Value::as_str).unwrap_or("");
        let content = l.obj.get("content").and_then(Value::as_str).unwrap_or("");
        match sub {
            "turn_duration" => {
                let ms = l.obj.get("durationMs").and_then(Value::as_u64).unwrap_or(0);
                self.push(
                    l.key_base.clone(),
                    l.ts,
                    system("turn_duration", &format!("Worked for {}", fmt_duration(ms))),
                );
            }
            "away_summary" => {
                self.push(l.key_base.clone(), l.ts, system("away_summary", content));
            }
            "compact_boundary" => {
                let meta = l.obj.get("compactMetadata");
                let trigger = meta
                    .and_then(|m| m.get("trigger"))
                    .and_then(Value::as_str)
                    .unwrap_or("manual");
                let tokens = meta
                    .and_then(|m| m.get("preTokens"))
                    .and_then(Value::as_u64);
                let text = match tokens {
                    Some(t) => format!("Conversation compacted ({trigger}, {t} tokens before)"),
                    None => format!("Conversation compacted ({trigger})"),
                };
                self.push(l.key_base.clone(), l.ts, system("compact_boundary", &text));
            }
            "local_command" => {
                if content.contains("<command-name>") {
                    let name = tag_inner(content, "command-name").unwrap_or("").trim();
                    let args = tag_inner(content, "command-args").unwrap_or("").trim();
                    let text = if args.is_empty() {
                        name.to_owned()
                    } else {
                        format!("{name} {args}")
                    };
                    let dup = self.items.last().is_some_and(
                        |i| matches!(&i.body, ItemBody::User { text: t, .. } if *t == text),
                    );
                    if dup {
                        self.cur_hidden = Some("duplicate-command-echo");
                    } else {
                        self.push(
                            l.key_base.clone(),
                            l.ts,
                            ItemBody::User {
                                text,
                                images: Vec::new(),
                            },
                        );
                    }
                } else {
                    let inner = tag_inner(content, "local-command-stdout")
                        .or_else(|| tag_inner(content, "local-command-stderr"))
                        .unwrap_or(content);
                    let text = strip_ansi(inner).trim().to_owned();
                    self.push(
                        l.key_base.clone(),
                        l.ts,
                        system(
                            "local_command",
                            if text.is_empty() {
                                "(no output)"
                            } else {
                                &text
                            },
                        ),
                    );
                }
            }
            "informational" => {
                self.push(l.key_base.clone(), l.ts, system("notice", content));
            }
            "api_error" | "api_retry" => {
                let text = if content.is_empty() {
                    l.obj
                        .get("error")
                        .map_or_else(|| sub.to_owned(), |e| e.to_string())
                } else {
                    content.to_owned()
                };
                self.push(l.key_base.clone(), l.ts, system("api_error", &text));
            }
            "stop_hook_summary" => {
                let errors: Vec<&str> = l
                    .obj
                    .get("hookErrors")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let prevented = flag(l.obj, "preventedContinuation");
                if errors.is_empty() && !prevented {
                    self.cur_hidden = Some("stop-hook-ok");
                } else {
                    let first = errors
                        .first()
                        .copied()
                        .unwrap_or("Stop hook blocked continuation");
                    let (text, _) = truncate_utf8(first, 600);
                    self.push(l.key_base.clone(), l.ts, system("stop_hook", &text));
                }
            }
            "bridge_status" => self.cur_hidden = Some("bridge-status"),
            other => {
                self.fallback_item(
                    l.key_base.clone(),
                    l.ts,
                    &format!("system:{other}"),
                    &describe_shape(l.obj),
                );
            }
        }
    }

    // ---- attachments ----

    fn on_attachment(&mut self, l: &LineCtx<'_>) {
        let att = l.obj.get("attachment");
        let at = att
            .and_then(|a| a.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        match at {
            "queued_command" => {
                let prompt = att.and_then(|a| a.get("prompt"));
                let text = match prompt {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(a)) => a
                        .iter()
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n\n"),
                    _ => String::new(),
                };
                let key = att
                    .and_then(|a| a.get("source_uuid"))
                    .and_then(Value::as_str)
                    .map_or_else(|| l.key_base.clone(), |s| format!("queued:{s}"));
                if text.trim().is_empty() {
                    self.cur_hidden = Some("empty-queued-command");
                } else {
                    self.user_text(&key, l.ts, &text, Vec::new());
                }
            }
            "hook_blocking_error" => {
                let be = att.and_then(|a| a.get("blockingError"));
                let msg = be
                    .and_then(|b| b.get("blockingError"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let hook = att
                    .and_then(|a| a.get("hookName"))
                    .and_then(Value::as_str)
                    .unwrap_or("hook");
                let (msg, _) = truncate_utf8(msg, 600);
                self.push(
                    l.key_base.clone(),
                    l.ts,
                    system("hook_error", &format!("{hook} hook blocked: {msg}")),
                );
            }
            "" => {
                self.fallback_item(
                    l.key_base.clone(),
                    l.ts,
                    "attachment",
                    "attachment without a type",
                );
            }
            t if HIDDEN_ATTACHMENT_TYPES.contains(&t) => {
                self.cur_hidden = Some("context-attachment");
            }
            other => {
                self.fallback_item(
                    l.key_base.clone(),
                    l.ts,
                    &format!("attachment:{other}"),
                    &format!("attachment of unknown type {other:?}"),
                );
            }
        }
    }

    // ---- plumbing ----

    fn image_ref(&self, offset: u64, n: usize, block: &Value) -> ImageRef {
        let media = block
            .get("source")
            .and_then(|s| s.get("media_type"))
            .and_then(Value::as_str)
            .unwrap_or("image/png");
        ImageRef {
            image_ref: format!("{}@{offset}#{n}", self.file_tag),
            media_type: media.to_owned(),
        }
    }

    fn push(&mut self, key: String, ts: i64, body: ItemBody) {
        let item = ChatItem {
            key: key.clone(),
            ts,
            parent_tool_use_id: self.parent.clone(),
            body,
        };
        let i = match self.index.get(&key) {
            Some(&i) => {
                // Keep the original position and time; the new body replaces the old.
                let ts0 = self.items[i].ts;
                self.items[i] = ChatItem {
                    ts: if ts0 != 0 { ts0 } else { ts },
                    ..item
                };
                i
            }
            None => {
                self.items.push(item);
                let i = self.items.len() - 1;
                self.index.insert(key, i);
                i
            }
        };
        if !self.cur_changed.contains(&i) {
            self.cur_changed.push(i);
        }
    }

    fn fallback_item(&mut self, key: String, ts: i64, line_type: &str, summary: &str) {
        self.cur_fallback = true;
        *self.fallback_types.entry(line_type.to_owned()).or_insert(0) += 1;
        let (summary, _) = truncate_utf8(summary, 240);
        self.push(
            key,
            ts,
            ItemBody::Fallback {
                line_type: line_type.to_owned(),
                summary,
            },
        );
    }
}

struct LineCtx<'a> {
    obj: &'a Map<String, Value>,
    offset: u64,
    ts: i64,
    key_base: String,
}

struct ResultIn<'a> {
    text: String,
    images: Vec<ImageRef>,
    is_error: bool,
    denial: Option<&'a str>,
    tur: Option<&'a Value>,
}

fn flag(obj: &Map<String, Value>, k: &str) -> bool {
    obj.get(k).and_then(Value::as_bool) == Some(true)
}

fn system(subtype: &str, text: &str) -> ItemBody {
    ItemBody::System {
        subtype: subtype.to_owned(),
        text: text.to_owned(),
    }
}

fn hidden_reason(ty: &str) -> &'static str {
    HIDDEN_LINE_TYPES
        .iter()
        .find(|(t, _)| *t == ty)
        .map_or("bookkeeping", |(t, _)| t)
}

fn describe_shape(obj: &Map<String, Value>) -> String {
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys.truncate(12);
    format!("keys: {}", keys.join(", "))
}

fn parse_questions(input: &Value) -> Vec<QuestionSpec> {
    input
        .get("questions")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|q| serde_json::from_value::<QuestionSpec>(q.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Parse `"question"="answer"` pairs out of the CLI's answer sentence.
fn parse_answer_pairs(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut rest = text;
    while let Some(sep) = rest.find("\"=\"") {
        let Some(q_start) = rest[..sep].rfind('"') else {
            break;
        };
        let q = &rest[q_start + 1..sep];
        let after = &rest[sep + 3..];
        // An answer ends at `", "` (next pair) or `". ` / `".` (end of the sentence).
        let end = ["\", \"", "\". ", "\"."]
            .iter()
            .filter_map(|m| after.find(m))
            .min()
            .or_else(|| after.rfind('"'));
        let Some(end) = end else { break };
        out.insert(q.to_owned(), after[..end].to_owned());
        rest = &after[end + 1..];
    }
    out
}

fn diff_from_input(name: &str, input: &Value) -> Option<Diff> {
    let path = input.get("file_path").and_then(Value::as_str)?.to_owned();
    match name {
        "Edit" => {
            let old = input.get("old_string").and_then(Value::as_str)?;
            let new = input.get("new_string").and_then(Value::as_str)?;
            Some(Diff {
                file_path: path,
                created: false,
                hunks: vec![synthetic_hunk(old, new)],
            })
        }
        "Write" => {
            let content = input.get("content").and_then(Value::as_str)?;
            Some(Diff {
                file_path: path,
                created: false,
                hunks: vec![synthetic_hunk("", content)],
            })
        }
        "MultiEdit" => {
            let edits = input.get("edits").and_then(Value::as_array)?;
            let hunks: Vec<DiffHunk> = edits
                .iter()
                .filter_map(|e| {
                    let old = e.get("old_string").and_then(Value::as_str)?;
                    let new = e.get("new_string").and_then(Value::as_str)?;
                    Some(synthetic_hunk(old, new))
                })
                .collect();
            (!hunks.is_empty()).then_some(Diff {
                file_path: path,
                created: false,
                hunks,
            })
        }
        _ => None,
    }
}

fn synthetic_hunk(old: &str, new: &str) -> DiffHunk {
    let mut lines = Vec::new();
    let old_n = if old.is_empty() {
        0
    } else {
        old.lines().count()
    };
    let new_n = if new.is_empty() {
        0
    } else {
        new.lines().count()
    };
    lines.extend(old.lines().map(|l| format!("-{l}")));
    lines.extend(new.lines().map(|l| format!("+{l}")));
    lines.truncate(DIFF_LINE_LIMIT);
    DiffHunk {
        old_start: 1,
        old_lines: old_n as u64,
        new_start: 1,
        new_lines: new_n as u64,
        lines,
    }
}

fn diff_from_result(tur: &Value) -> Option<Diff> {
    let path = tur.get("filePath").and_then(Value::as_str)?.to_owned();
    let created = tur.get("type").and_then(Value::as_str) == Some("create");
    let mut hunks: Vec<DiffHunk> = tur
        .get("structuredPatch")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|h| {
                    Some(DiffHunk {
                        old_start: h.get("oldStart")?.as_u64()?,
                        old_lines: h.get("oldLines")?.as_u64()?,
                        new_start: h.get("newStart")?.as_u64()?,
                        new_lines: h.get("newLines")?.as_u64()?,
                        lines: h
                            .get("lines")?
                            .as_array()?
                            .iter()
                            .filter_map(|l| l.as_str().map(str::to_owned))
                            .collect(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if hunks.is_empty() && created {
        if let Some(c) = tur.get("content").and_then(Value::as_str) {
            hunks.push(synthetic_hunk("", c));
        }
    }
    if hunks.is_empty() {
        return None;
    }
    let mut budget = DIFF_LINE_LIMIT;
    for h in &mut hunks {
        h.lines.truncate(budget);
        budget = budget.saturating_sub(h.lines.len());
    }
    Some(Diff {
        file_path: path,
        created,
        hunks,
    })
}

/// Every image block in a transcript line, in document order, as `(media_type, base64)`.
/// Numbering matches the `#n` of image refs.
#[must_use]
pub fn collect_images(line: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(content) = line.get("message").and_then(|m| m.get("content")) else {
        return out;
    };
    let Some(blocks) = content.as_array() else {
        return out;
    };
    let mut take = |b: &Value| {
        if b.get("type").and_then(Value::as_str) == Some("image") {
            let src = b.get("source");
            let data = src.and_then(|s| s.get("data")).and_then(Value::as_str);
            let media = src
                .and_then(|s| s.get("media_type"))
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            out.push((media.to_owned(), data.unwrap_or("").to_owned()));
        }
    };
    for b in blocks {
        take(b);
        if b.get("type").and_then(Value::as_str) == Some("tool_result") {
            if let Some(parts) = b.get("content").and_then(Value::as_array) {
                for p in parts {
                    take(p);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(m: &mut Mapper, lines: &[Value]) -> Vec<Feed> {
        lines
            .iter()
            .enumerate()
            .map(|(i, l)| m.feed(&l.to_string(), i as u64 * 100))
            .collect()
    }

    fn assistant(uuid: &str, blocks: Value) -> Value {
        json!({"type":"assistant","uuid":uuid,"timestamp":"2026-01-01T00:00:00.000Z",
               "message":{"role":"assistant","model":"m","content":blocks}})
    }

    fn user(uuid: &str, content: Value) -> Value {
        json!({"type":"user","uuid":uuid,"timestamp":"2026-01-01T00:00:01.000Z",
               "message":{"role":"user","content":content}})
    }

    #[test]
    fn text_tool_and_result_pair_up() {
        let mut m = Mapper::new("main", None);
        let feeds = feed_all(
            &mut m,
            &[
                user("u1", json!("hello")),
                assistant("a1", json!([{"type":"text","text":"hi"}])),
                assistant(
                    "a2",
                    json!([{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]),
                ),
                user(
                    "u2",
                    json!([{"type":"tool_result","tool_use_id":"t1","content":"a\nb"}]),
                ),
            ],
        );
        assert!(feeds.iter().all(|f| f.outcome == Outcome::Mapped));
        assert_eq!(m.items().len(), 3);
        match &m.items()[2].body {
            ItemBody::Tool { state, result, .. } => {
                assert_eq!(*state, ToolState::Ok);
                assert_eq!(result.as_ref().unwrap().text, "a\nb");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(feeds[3].changed, vec![2]);
        let acct = m.accounting();
        assert_eq!(
            (acct.lines, acct.items, acct.hidden, acct.fallback),
            (4, 3, 0, 0)
        );
    }

    #[test]
    fn hidden_lines_are_counted_with_reasons() {
        let mut m = Mapper::new("main", None);
        let f = feed_all(
            &mut m,
            &[
                json!({"type":"last-prompt","lastPrompt":"x"}),
                json!({"type":"attachment","uuid":"x","attachment":{"type":"total_tokens_reminder"}}),
                assistant(
                    "a",
                    json!([{"type":"thinking","thinking":"","signature":"s"}]),
                ),
                user("m", json!("meta"))
                    .as_object()
                    .map(|o| {
                        let mut o = o.clone();
                        o.insert("isMeta".into(), json!(true));
                        Value::Object(o)
                    })
                    .unwrap(),
            ],
        );
        assert!(f.iter().all(|x| matches!(x.outcome, Outcome::Hidden(_))));
        let a = m.accounting();
        assert_eq!((a.lines, a.hidden, a.fallback, a.items), (4, 4, 0, 0));
        assert_eq!(m.hidden_reasons()["context-attachment"], 1);
        assert_eq!(m.hidden_reasons()["thinking-signature-only"], 1);
    }

    #[test]
    fn unknown_shapes_fall_back_without_panic() {
        let mut m = Mapper::new("main", None);
        let lines = [
            "not json at all".to_owned(),
            "[1,2,3]".to_owned(),
            json!({"type":"brand-new-line","a":1}).to_string(),
            json!({"type":"attachment","uuid":"z","attachment":{"type":"never-seen"}}).to_string(),
            assistant("w", json!([{"type":"server_tool_use","id":"x"}])).to_string(),
            json!({"type":"assistant","uuid":"q"}).to_string(),
            json!({"type":"user","uuid":"q2","message":{"content":42}}).to_string(),
        ];
        for (i, l) in lines.iter().enumerate() {
            let f = m.feed(l, i as u64);
            assert_eq!(f.outcome, Outcome::Fallback, "{l}");
        }
        let a = m.accounting();
        assert_eq!(a.fallback, 7);
        assert_eq!(a.errors, 2);
        assert_eq!(m.fallback_types()["brand-new-line"], 1);
        assert!(m.items().iter().all(|i| i.kind_name() == "fallback"));
    }

    #[test]
    fn blank_lines_are_not_counted() {
        let mut m = Mapper::new("main", None);
        m.feed("   ", 0);
        assert_eq!(m.accounting().lines, 0);
    }

    #[test]
    fn pasted_content_is_unwrapped_and_images_are_refs() {
        let mut m = Mapper::new("main", None);
        m.feed(
            &user(
                "u",
                json!([
                    {"type":"text","text":"[Image #1] look\n\n<pasted_content id=\"a\">\nX\n</pasted_content id=\"a\">"},
                    {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"QUJD"}},
                    {"type":"text","text":"[Image: source: /tmp/x.png]"}
                ]),
            )
            .to_string(),
            40,
        );
        match &m.items()[0].body {
            ItemBody::User { text, images } => {
                assert_eq!(text, "[Image #1] look\n\nX");
                assert_eq!(images.len(), 1);
                assert_eq!(images[0].image_ref, "main@40#0");
                assert_eq!(images[0].media_type, "image/jpeg");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn denial_and_interrupt_states() {
        let mut m = Mapper::new("main", None);
        let mk = |id: &str| {
            assistant(
                id,
                json!([{"type":"tool_use","id":id,"name":"Bash","input":{}}]),
            )
        };
        let res = |id: &str, kind: &str| {
            let mut v = user(
                &format!("r{id}"),
                json!([{"type":"tool_result","tool_use_id":id,"content":"no","is_error":true}]),
            );
            v["toolDenialKind"] = json!(kind);
            v
        };
        feed_all(
            &mut m,
            &[
                mk("a"),
                mk("b"),
                res("a", "user-rejected"),
                res("b", "cancelled"),
            ],
        );
        let st = |k: &str| match &m.item(k).unwrap().body {
            ItemBody::Tool { state, .. } => *state,
            _ => unreachable!(),
        };
        assert_eq!(st("a"), ToolState::Denied);
        assert_eq!(st("b"), ToolState::Interrupted);
    }

    #[test]
    fn question_plan_and_subagent_items() {
        let mut m = Mapper::new("main", None);
        feed_all(
            &mut m,
            &[
                assistant(
                    "q",
                    json!([{"type":"tool_use","id":"tq","name":"AskUserQuestion","input":{
                        "questions":[{"question":"Color?","header":"C","multiSelect":false,
                                      "options":[{"label":"Red","description":"r"}]}]}}]),
                ),
                json!({"type":"user","uuid":"rq","timestamp":"2026-01-01T00:00:02.000Z",
                    "toolUseResult":{"questions":[],"answers":{"Color?":"Red"}},
                    "message":{"content":[{"type":"tool_result","tool_use_id":"tq","content":"ok"}]}}),
                assistant(
                    "p",
                    json!([{"type":"tool_use","id":"tp","name":"ExitPlanMode","input":{"plan":"Do X"}}]),
                ),
                assistant(
                    "s",
                    json!([{"type":"tool_use","id":"ts","name":"Agent","input":{"description":"d","subagent_type":"explore"}}]),
                ),
                json!({"type":"user","uuid":"rs",
                    "toolUseResult":{"status":"async_launched","agentId":"ag1"},
                    "message":{"content":[{"type":"tool_result","tool_use_id":"ts","content":"launched"}]}}),
            ],
        );
        match &m.item("tq").unwrap().body {
            ItemBody::Question {
                answers,
                state,
                questions,
                ..
            } => {
                assert_eq!(*state, QuestionState::Answered);
                assert_eq!(answers.as_ref().unwrap()["Color?"], "Red");
                assert_eq!(questions[0].options[0].label, "Red");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            &m.item("tp").unwrap().body,
            ItemBody::Plan {
                state: PlanState::Pending,
                ..
            }
        ));
        match &m.item("ts").unwrap().body {
            ItemBody::Subagent {
                state, agent_type, ..
            } => {
                assert_eq!(*state, SubagentState::Running);
                assert_eq!(agent_type, "explore");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(m.agent_id_of("ts"), Some("ag1"));
        // A task notification completes the subagent.
        m.feed(
            &user(
                "n",
                json!("<task-notification>\n<tool-use-id>ts</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>"),
            )
            .to_string(),
            900,
        );
        assert!(matches!(
            &m.item("ts").unwrap().body,
            ItemBody::Subagent {
                state: SubagentState::Ok,
                ..
            }
        ));
    }

    #[test]
    fn edit_gets_a_pending_diff_then_the_real_one() {
        let mut m = Mapper::new("main", None);
        feed_all(
            &mut m,
            &[assistant(
                "e",
                json!([{"type":"tool_use","id":"te","name":"Edit","input":{
                        "file_path":"/a/b.rs","old_string":"x","new_string":"y\nz"}}]),
            )],
        );
        match &m.item("te").unwrap().body {
            ItemBody::Tool { diff, .. } => {
                assert_eq!(
                    diff.as_ref().unwrap().hunks[0].lines,
                    vec!["-x", "+y", "+z"]
                );
            }
            other => panic!("{other:?}"),
        }
        m.feed(
            &json!({"type":"user","uuid":"re",
                "toolUseResult":{"filePath":"/a/b.rs","structuredPatch":[
                    {"oldStart":3,"oldLines":1,"newStart":3,"newLines":2,"lines":["-x","+y","+z"," c"]}]},
                "message":{"content":[{"type":"tool_result","tool_use_id":"te","content":"ok"}]}})
            .to_string(),
            50,
        );
        match &m.item("te").unwrap().body {
            ItemBody::Tool { diff, .. } => assert_eq!(diff.as_ref().unwrap().hunks[0].old_start, 3),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn long_results_and_inputs_are_cut() {
        let mut m = Mapper::new("main", None);
        let big = "x".repeat(RESULT_TEXT_LIMIT + 50);
        feed_all(
            &mut m,
            &[
                assistant(
                    "a",
                    json!([{"type":"tool_use","id":"t","name":"Write","input":{"file_path":"/f","content":big.clone()}}]),
                ),
                user(
                    "r",
                    json!([{"type":"tool_result","tool_use_id":"t","content":big}]),
                ),
            ],
        );
        match &m.item("t").unwrap().body {
            ItemBody::Tool {
                result,
                input_truncated,
                input,
                ..
            } => {
                assert!(result.as_ref().unwrap().truncated);
                assert!(*input_truncated);
                assert!(input["content"].as_str().unwrap().len() < RESULT_TEXT_LIMIT + 100);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn system_lines_map_per_subtype() {
        let mut m = Mapper::new("main", None);
        let sys = |sub: &str, extra: Value| {
            let mut v = json!({"type":"system","subtype":sub,"uuid":format!("s-{sub}")});
            for (k, x) in extra.as_object().unwrap() {
                v[k] = x.clone();
            }
            v
        };
        let f = feed_all(
            &mut m,
            &[
                sys("turn_duration", json!({"durationMs": 72000})),
                sys(
                    "compact_boundary",
                    json!({"compactMetadata":{"trigger":"auto","preTokens":5}}),
                ),
                sys(
                    "stop_hook_summary",
                    json!({"hookErrors":[],"preventedContinuation":false}),
                ),
                sys("stop_hook_summary", json!({"hookErrors":["boom"]})),
                sys(
                    "local_command",
                    json!({"content":"<local-command-stdout>\u{1b}[1mhi\u{1b}[22m</local-command-stdout>"}),
                ),
                sys("brand_new", json!({})),
            ],
        );
        assert!(matches!(f[2].outcome, Outcome::Hidden("stop-hook-ok")));
        assert_eq!(f[5].outcome, Outcome::Fallback);
        let texts: Vec<String> = m
            .items()
            .iter()
            .filter_map(|i| match &i.body {
                ItemBody::System { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(texts[0], "Worked for 1m 12s");
        assert!(texts[1].contains("auto"));
        assert_eq!(texts[2], "boom");
        assert_eq!(texts[3], "hi");
    }

    #[test]
    fn meta_lines_feed_chips() {
        let mut m = Mapper::new("main", None);
        let f = m.feed(
            &json!({"type":"permission-mode","permissionMode":"plan"}).to_string(),
            0,
        );
        assert!(f.meta_changed);
        m.feed(
            &json!({"type":"pr-link","prUrl":"https://example.test/pr/1"}).to_string(),
            1,
        );
        m.feed(
            &json!({"type":"worktree-state","worktreeSession":{"worktreeName":"wt"}}).to_string(),
            2,
        );
        let f = m.feed(
            &json!({"type":"permission-mode","permissionMode":"plan"}).to_string(),
            3,
        );
        assert!(!f.meta_changed);
        assert_eq!(m.meta().mode.as_deref(), Some("plan"));
        assert_eq!(
            m.meta().pr_url.as_deref(),
            Some("https://example.test/pr/1")
        );
        assert_eq!(m.meta().worktree.as_deref(), Some("wt"));
    }

    #[test]
    fn same_key_replaces_in_place() {
        let mut m = Mapper::new("main", None);
        let l = assistant("a", json!([{"type":"text","text":"one"}]));
        m.feed(&l.to_string(), 0);
        m.feed(
            &assistant("b", json!([{"type":"text","text":"two"}])).to_string(),
            1,
        );
        let again = assistant("a", json!([{"type":"text","text":"ONE"}]));
        let f = m.feed(&again.to_string(), 2);
        assert_eq!(f.changed, vec![0]);
        assert_eq!(m.items().len(), 2);
        assert!(matches!(&m.items()[0].body, ItemBody::Assistant { text } if text == "ONE"));
    }

    #[test]
    fn answer_sentence_parses() {
        let m = parse_answer_pairs(
            "Your questions have been answered: \"Which color?\"=\"Blue\", \"Size?\"=\"L\". You can now continue.",
        );
        assert_eq!(m["Which color?"], "Blue");
        assert_eq!(m["Size?"], "L");
    }

    #[test]
    fn thread_mapper_tags_parent() {
        let mut m = Mapper::new("ag1", Some("toolu_parent".into()));
        m.feed(
            &assistant("a", json!([{"type":"text","text":"x"}])).to_string(),
            0,
        );
        assert_eq!(
            m.items()[0].parent_tool_use_id.as_deref(),
            Some("toolu_parent")
        );
    }

    #[test]
    fn collect_images_matches_ref_numbering() {
        let line = user(
            "u",
            json!([
                {"type":"tool_result","tool_use_id":"t","content":[
                    {"type":"image","source":{"media_type":"image/png","data":"AAA"}},
                    {"type":"image","source":{"media_type":"image/jpeg","data":"BBB"}}]},
            ]),
        );
        let imgs = collect_images(&line);
        assert_eq!(imgs.len(), 2);
        assert_eq!(imgs[1], ("image/jpeg".to_owned(), "BBB".to_owned()));
    }
}
