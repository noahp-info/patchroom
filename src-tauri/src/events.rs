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
