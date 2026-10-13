//! Typed view of the hook JSON the CLI sends on stdin.

use std::path::PathBuf;

use serde_json::Value;

/// The fields the bridge cares about. The full payload is always kept alongside.
#[derive(Debug, Clone, PartialEq)]
pub struct HookInfo {
    /// `hook_event_name`, for example `PermissionRequest`.
    pub event: String,
    /// CLI session id.
    pub session_id: Option<String>,
    /// Tool name for tool hooks.
    pub tool_name: Option<String>,
    /// Tool use id. Present on PreToolUse and PostToolUse, absent on PermissionRequest.
    pub tool_use_id: Option<String>,
    /// Tool input object (`Value::Null` when absent).
    pub tool_input: Value,
    /// Path to the session transcript JSONL.
    pub transcript_path: Option<PathBuf>,
    /// Prompt id shared by all hooks of one turn.
    pub prompt_id: Option<String>,
    /// Working directory of the session.
    pub cwd: Option<String>,
    /// Permission mode of the session.
    pub permission_mode: Option<String>,
    /// Notification type for `Notification` hooks.
    pub notification_type: Option<String>,
    /// `permission_suggestions` of a PermissionRequest (`Value::Null` when absent).
    pub permission_suggestions: Value,
}

impl HookInfo {
    /// Parse a payload. Returns `None` when `hook_event_name` is missing.
    pub fn from_payload(payload: &Value) -> Option<Self> {
        let s = |k: &str| payload.get(k).and_then(Value::as_str).map(str::to_owned);
        Some(Self {
            event: s("hook_event_name")?,
            session_id: s("session_id"),
            tool_name: s("tool_name"),
            tool_use_id: s("tool_use_id"),
            tool_input: payload.get("tool_input").cloned().unwrap_or(Value::Null),
            transcript_path: s("transcript_path").map(PathBuf::from),
            prompt_id: s("prompt_id"),
            cwd: s("cwd"),
            permission_mode: s("permission_mode"),
            notification_type: s("notification_type"),
            permission_suggestions: payload
                .get("permission_suggestions")
                .cloned()
                .unwrap_or(Value::Null),
        })
    }

    /// True for the AskUserQuestion tool.
    pub fn is_ask_user_question(&self) -> bool {
        self.tool_name.as_deref() == Some("AskUserQuestion")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_permission_request_payload() {
        let p = json!({
            "hook_event_name": "PermissionRequest",
            "session_id": "s1",
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
            "transcript_path": "/t/s1.jsonl",
            "prompt_id": "p1",
            "cwd": "/w",
            "permission_mode": "default",
            "permission_suggestions": [{"type": "addRules"}]
        });
        let i = HookInfo::from_payload(&p).unwrap();
        assert_eq!(i.event, "PermissionRequest");
        assert_eq!(i.tool_name.as_deref(), Some("Bash"));
        assert!(i.tool_use_id.is_none());
        assert_eq!(i.tool_input["command"], "ls");
        assert!(!i.is_ask_user_question());
    }

    #[test]
    fn missing_event_name_is_none() {
        assert!(HookInfo::from_payload(&json!({"session_id": "x"})).is_none());
    }
}
