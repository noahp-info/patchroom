//! Types published by the bridge to its subscribers.

use std::fmt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::protocol::Resolution;

/// Identifies one pending prompt (a blocked hook) inside the bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct PromptId(pub u64);

impl fmt::Display for PromptId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "prompt-{}", self.0)
    }
}

/// Which session a hook belongs to.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionRef {
    /// Patchroom's key for the session (conversation id), when the launch supplied one.
    pub key: Option<String>,
    /// The CLI's own session id, once a hook has reported it.
    pub session_id: Option<String>,
}

impl SessionRef {
    /// Stable string for dedupe maps: the key if present, else the CLI session id.
    pub fn id(&self) -> String {
        self.key
            .clone()
            .or_else(|| self.session_id.clone())
            .unwrap_or_default()
    }
}

/// Why a session needs the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedsKind {
    /// A permission dialog is open.
    Permission,
    /// An AskUserQuestion picker (or other input request) is open.
    Question,
    /// Some other dialog or request waits for input.
    Other,
}

/// Presence status of a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "state", content = "kind", rename_all = "snake_case")]
pub enum Status {
    /// A turn is running.
    Busy,
    /// Waiting for the next prompt.
    Idle,
    /// Blocked on the user.
    NeedsYou(NeedsKind),
}

/// Where a status came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusSource {
    /// Derived from hook traffic.
    Hook,
    /// Derived from `claude agents --json`.
    Reconciler,
}

/// A status change for one session.
#[derive(Debug, Clone, PartialEq)]
pub struct StatusEvent {
    /// The session.
    pub session: SessionRef,
    /// The new status.
    pub status: Status,
    /// What produced it.
    pub source: StatusSource,
}

/// A permission request waiting for a chat answer.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionPrompt {
    /// Prompt id to pass to `answer_permission`.
    pub id: PromptId,
    /// The session.
    pub session: SessionRef,
    /// Tool asking for permission.
    pub tool_name: String,
    /// Tool input.
    pub tool_input: Value,
    /// The CLI's `permission_suggestions` (kept raw).
    pub suggestions: Value,
    /// Session working directory.
    pub cwd: Option<String>,
    /// Permission mode.
    pub permission_mode: Option<String>,
    /// Turn id shared by hooks of one prompt.
    pub prompt_id: Option<String>,
}

/// One AskUserQuestion option.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuestionOption {
    /// Label. This is the value the CLI expects in `answers`.
    pub label: String,
    /// Longer description.
    #[serde(default)]
    pub description: String,
}

/// One AskUserQuestion question.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Question {
    /// Question text. This is the key the CLI expects in `answers`.
    pub question: String,
    /// Short header.
    #[serde(default)]
    pub header: String,
    /// Whether several options may be chosen.
    #[serde(default, rename = "multiSelect")]
    pub multi_select: bool,
    /// Offered options.
    #[serde(default)]
    pub options: Vec<QuestionOption>,
}

/// An AskUserQuestion waiting for a chat answer.
#[derive(Debug, Clone, PartialEq)]
pub struct QuestionPrompt {
    /// Prompt id to pass to `answer_question`.
    pub id: PromptId,
    /// The session.
    pub session: SessionRef,
    /// Tool use id of the AskUserQuestion call.
    pub tool_use_id: Option<String>,
    /// The questions.
    pub questions: Vec<Question>,
    /// How long the bridge holds the TUI picker back before releasing it.
    pub wait: std::time::Duration,
}

/// A prompt left the pending table.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptResolved {
    /// The prompt.
    pub id: PromptId,
    /// The session.
    pub session: SessionRef,
    /// How it was resolved.
    pub resolution: Resolution,
}

/// A raw hook delivery, for adapters that want every event.
#[derive(Debug, Clone, PartialEq)]
pub struct HookRecord {
    /// The session.
    pub session: SessionRef,
    /// Event name.
    pub event: String,
    /// Full payload as the CLI sent it.
    pub payload: Value,
    /// Transcript path from the payload, if any.
    pub transcript_path: Option<PathBuf>,
}

/// Everything the bridge publishes.
#[derive(Debug, Clone, PartialEq)]
pub enum BridgeEvent {
    /// A hook arrived.
    Hook(HookRecord),
    /// A session status changed.
    Status(StatusEvent),
    /// A permission request awaits a chat answer.
    Permission(PermissionPrompt),
    /// An AskUserQuestion awaits a chat answer.
    Question(QuestionPrompt),
    /// A pending prompt was resolved.
    Resolved(PromptResolved),
}
