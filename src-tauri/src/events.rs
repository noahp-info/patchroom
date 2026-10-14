//! UI-facing events and the sink they are delivered to.
//!
//! Event names and payload shapes are the fixed IPC contract with the frontend.

use serde::Serialize;
use serde_json::{json, Value};

/// Presence state of a DM.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceStatus {
    /// A turn is running.
    Busy,
    /// Waiting for the next prompt.
    Idle,
    /// Blocked on the user.
    Waiting,
    /// The child process ended.
    Exited,
}

/// Why a `waiting` session needs the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Needs {
    /// A permission dialog is open.
    Permission,
    /// A question picker is open.
    Question,
    /// Some other dialog waits for input.
    Other,
}

/// An event for the frontend.
#[derive(Debug, Clone, PartialEq)]
pub enum UiEvent {
    /// `pty:output {id, data}`: `data` is base64 of raw PTY bytes.
    Output {
        /// Session id.
        id: String,
        /// Base64 (standard alphabet, padded) of the bytes.
        data: String,
    },
    /// `pty:exit {id, code}`.
    Exit {
        /// Session id.
        id: String,
        /// Exit code.
        code: i64,
    },
    /// `session:title {id, title}`.
    Title {
        /// Session id.
        id: String,
        /// New title.
        title: String,
    },
    /// `session:status {id, status, needs?}`.
    Status {
        /// Session id.
        id: String,
        /// New status.
        status: PresenceStatus,
        /// Reason, only for `waiting`.
        needs: Option<Needs>,
    },
    /// `chat:items {id, items}`: new or updated chat items (same `key` replaces).
    ChatItems {
        /// Session id.
        id: String,
        /// Items as JSON (the `patchroom-claude` wire format).
        items: Value,
    },
    /// `prompt:pending {id, promptId, kind, toolName, toolInput, toolUseId?, questions?, canAlways}`.
    PromptPending {
        /// Session id.
        id: String,
        /// The full payload, `id` included.
        payload: Value,
    },
    /// `prompt:resolved {id, promptId, by}`.
    PromptResolved {
        /// Session id.
        id: String,
        /// Prompt id, for example `prompt-3`.
        prompt_id: String,
        /// `chat`, `terminal`, `timeout` or `interrupt`.
        by: &'static str,
    },
    /// `session:badges {id, unread, needsYou}`.
    Badges {
        /// Session id.
        id: String,
        /// New assistant items since the DM was last viewed.
        unread: u32,
        /// A prompt waits on the user.
        needs_you: bool,
    },
    /// `statusline:update {id, text, chips}`.
    Statusline {
        /// Session id.
        id: String,
        /// The user's statusLine output as ANSI.
        text: String,
        /// Structured chips as JSON.
        chips: Value,
    },
}

impl UiEvent {
    /// The Tauri event name.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            UiEvent::Output { .. } => "pty:output",
            UiEvent::Exit { .. } => "pty:exit",
            UiEvent::Title { .. } => "session:title",
            UiEvent::Status { .. } => "session:status",
            UiEvent::ChatItems { .. } => "chat:items",
            UiEvent::PromptPending { .. } => "prompt:pending",
            UiEvent::PromptResolved { .. } => "prompt:resolved",
            UiEvent::Badges { .. } => "session:badges",
            UiEvent::Statusline { .. } => "statusline:update",
        }
    }

    /// The JSON payload.
    #[must_use]
    pub fn payload(&self) -> Value {
        match self {
            UiEvent::Output { id, data } => json!({ "id": id, "data": data }),
            UiEvent::Exit { id, code } => json!({ "id": id, "code": code }),
            UiEvent::Title { id, title } => json!({ "id": id, "title": title }),
            UiEvent::Status { id, status, needs } => match needs {
                Some(n) => json!({ "id": id, "status": status, "needs": n }),
                None => json!({ "id": id, "status": status }),
            },
            UiEvent::ChatItems { id, items } => json!({ "id": id, "items": items }),
            UiEvent::PromptPending { payload, .. } => payload.clone(),
            UiEvent::PromptResolved { id, prompt_id, by } => {
                json!({ "id": id, "promptId": prompt_id, "by": by })
            }
            UiEvent::Badges {
                id,
                unread,
                needs_you,
            } => json!({ "id": id, "unread": unread, "needsYou": needs_you }),
            UiEvent::Statusline { id, text, chips } => {
                json!({ "id": id, "text": text, "chips": chips })
            }
        }
    }
}

/// Receives events from the session manager. Implementations must not block
/// for long: they run on the output forwarder threads.
pub trait EventSink: Send + Sync + 'static {
    /// Deliver one event.
    fn emit(&self, event: UiEvent);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_event_payloads_match_the_contract() {
        let e = UiEvent::Badges {
            id: "a".into(),
            unread: 2,
            needs_you: true,
        };
        assert_eq!(
            (e.name(), e.payload()),
            (
                "session:badges",
                json!({"id":"a","unread":2,"needsYou":true})
            )
        );
        let e = UiEvent::PromptResolved {
            id: "a".into(),
            prompt_id: "prompt-1".into(),
            by: "terminal",
        };
        assert_eq!(
            (e.name(), e.payload()),
            (
                "prompt:resolved",
                json!({"id":"a","promptId":"prompt-1","by":"terminal"})
            )
        );
        let e = UiEvent::Statusline {
            id: "a".into(),
            text: "\u{1b}[1mx".into(),
            chips: json!({"model":"Haiku"}),
        };
        assert_eq!(e.name(), "statusline:update");
        assert_eq!(e.payload()["chips"]["model"], "Haiku");
        let e = UiEvent::ChatItems {
            id: "a".into(),
            items: json!([]),
        };
        assert_eq!(
            (e.name(), e.payload()),
            ("chat:items", json!({"id":"a","items":[]}))
        );
    }

    #[test]
    fn payload_shapes_match_the_contract() {
        let e = UiEvent::Status {
            id: "a".into(),
            status: PresenceStatus::Waiting,
            needs: Some(Needs::Permission),
        };
        assert_eq!(e.name(), "session:status");
        assert_eq!(
            e.payload(),
            json!({"id":"a","status":"waiting","needs":"permission"})
        );
        let e = UiEvent::Status {
            id: "a".into(),
            status: PresenceStatus::Idle,
            needs: None,
        };
        assert_eq!(e.payload(), json!({"id":"a","status":"idle"}));
        let e = UiEvent::Exit {
            id: "a".into(),
            code: 3,
        };
        assert_eq!(
            (e.name(), e.payload()),
            ("pty:exit", json!({"id":"a","code":3}))
        );
    }
}
