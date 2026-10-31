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
    /// `notify:fire {id, event, title, body}`: the backend decided this event notifies and
    /// posted the native notification. The UI plays the sound.
    NotifyFire {
        /// Session id (empty for the test notification).
        id: String,
        /// `needs`, `done`, `message`, `error`, `bell` or `session` (sound only).
        event: &'static str,
        /// Notification title (the DM name).
        title: String,
        /// Notification body.
        body: String,
    },
    /// `notify:open {id}`: the user clicked a native notification; show this DM.
    NotifyOpen {
        /// Session id.
        id: String,
    },
    /// `prefs:changed {prefs}`.
    PrefsChanged {
        /// The full prefs as JSON.
        prefs: Value,
    },
    /// `activity:changed {}`: re-read `activity_list`.
    ActivityChanged,
    /// `folder:changed {sectionId}`: re-read `folder_sessions` for that folder section.
    FolderChanged {
        /// The folder section.
        section_id: String,
    },
    /// `session:terminal_wait {id, reason, since}`: claude waits on something the chat cannot
    /// render (no bridge prompt). Sent when it begins and again if `reason` changes.
    TerminalWait {
        /// Session id.
        id: String,
        /// What it waits for, for example `dialog open`.
        reason: String,
        /// When the wait began, epoch milliseconds.
        since: i64,
    },
    /// `session:terminal_wait_clear {id}`: the terminal-only wait ended.
    TerminalWaitClear {
        /// Session id.
        id: String,
    },
    /// `link:open {id, url}`: a session's CLI asked to open a URL. The UI opens it per the
    /// Links preference.
    OpenUrl {
        /// The DM, when known.
        id: Option<String>,
        /// An http(s) URL.
        url: String,
    },
    /// `menu:settings {}`: the app menu's Settings item (Cmd+,) was chosen.
    OpenSettings,
    /// `session:working {id, verb, detail}`: the CLI's live working line, read off its screen
    /// ("Slithering…", "1m 31s · ↓ 409 tokens · deep in thought"). Both null when it is gone.
    Working {
        /// Session id.
        id: String,
        /// The spinner word, with its ellipsis.
        verb: Option<String>,
        /// The text in parentheses after it, without "esc to interrupt".
        detail: Option<String>,
    },
    /// `session:mirror {id, mirror}`: the DM became a read-only mirror of a session that runs
    /// in another terminal (`mirror` is `{where, pid, takeoverWhenClosed}`), or stopped being one
    /// (`mirror` is null).
    Mirror {
        /// Session id.
        id: String,
        /// The mirror state, or `Null`.
        mirror: Value,
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
            UiEvent::NotifyFire { .. } => "notify:fire",
            UiEvent::NotifyOpen { .. } => "notify:open",
            UiEvent::PrefsChanged { .. } => "prefs:changed",
            UiEvent::ActivityChanged => "activity:changed",
            UiEvent::FolderChanged { .. } => "folder:changed",
            UiEvent::TerminalWait { .. } => "session:terminal_wait",
            UiEvent::TerminalWaitClear { .. } => "session:terminal_wait_clear",
            UiEvent::Working { .. } => "session:working",
            UiEvent::OpenUrl { .. } => "link:open",
            UiEvent::OpenSettings => "menu:settings",
            UiEvent::Mirror { .. } => "session:mirror",
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
            UiEvent::NotifyFire {
                id,
                event,
                title,
                body,
            } => json!({ "id": id, "event": event, "title": title, "body": body }),
            UiEvent::NotifyOpen { id } => json!({ "id": id }),
            UiEvent::PrefsChanged { prefs } => json!({ "prefs": prefs }),
            UiEvent::ActivityChanged | UiEvent::OpenSettings => json!({}),
            UiEvent::FolderChanged { section_id } => json!({ "sectionId": section_id }),
            UiEvent::TerminalWait { id, reason, since } => {
                json!({ "id": id, "reason": reason, "since": since })
            }
            UiEvent::TerminalWaitClear { id } => json!({ "id": id }),
            UiEvent::OpenUrl { id, url } => json!({ "id": id, "url": url }),
            UiEvent::Working { id, verb, detail } => {
                json!({ "id": id, "verb": verb, "detail": detail })
            }
            UiEvent::Mirror { id, mirror } => json!({ "id": id, "mirror": mirror }),
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
    fn p3_event_payloads_match_the_contract() {
        let e = UiEvent::NotifyFire {
            id: "a".into(),
            event: "needs",
            title: "proj".into(),
            body: "Waiting for permission".into(),
        };
        assert_eq!(e.name(), "notify:fire");
        assert_eq!(
            e.payload(),
            json!({"id":"a","event":"needs","title":"proj","body":"Waiting for permission"})
        );
        let e = UiEvent::Title {
            id: "a".into(),
            title: "t".into(),
        };
        assert_eq!(
            (e.name(), e.payload()),
            ("session:title", json!({"id":"a","title":"t"}))
        );
        let e = UiEvent::PrefsChanged {
            prefs: json!({"themeId":"x"}),
        };
        assert_eq!(
            (e.name(), e.payload()),
            ("prefs:changed", json!({"prefs":{"themeId":"x"}}))
        );
        let e = UiEvent::ActivityChanged;
        assert_eq!((e.name(), e.payload()), ("activity:changed", json!({})));
        let e = UiEvent::FolderChanged {
            section_id: "s".into(),
        };
        assert_eq!(
            (e.name(), e.payload()),
            ("folder:changed", json!({"sectionId":"s"}))
        );
        let e = UiEvent::NotifyOpen { id: "a".into() };
        assert_eq!((e.name(), e.payload()), ("notify:open", json!({"id":"a"})));
    }

    #[test]
    fn session_parity_event_payloads_match_the_contract() {
        let e = UiEvent::TerminalWait {
            id: "a".into(),
            reason: "dialog open".into(),
            since: 5,
        };
        assert_eq!(
            (e.name(), e.payload()),
            (
                "session:terminal_wait",
                json!({"id":"a","reason":"dialog open","since":5})
            )
        );
        let e = UiEvent::TerminalWaitClear { id: "a".into() };
        assert_eq!(
            (e.name(), e.payload()),
            ("session:terminal_wait_clear", json!({"id":"a"}))
        );
        let e = UiEvent::Mirror {
            id: "a".into(),
            mirror: json!({"where":"iTerm","pid":7,"takeoverWhenClosed":false}),
        };
        assert_eq!(e.name(), "session:mirror");
        assert_eq!(e.payload()["mirror"]["where"], "iTerm");
        let e = UiEvent::Mirror {
            id: "a".into(),
            mirror: Value::Null,
        };
        assert_eq!(e.payload(), json!({"id":"a","mirror":null}));
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
