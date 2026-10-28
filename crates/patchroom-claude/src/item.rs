//! Chat items: the wire format shared with the frontend.
//!
//! JSON fields are camelCase. `kind` is exactly the lowercase variant name. Every item
//! has a stable `key` (the same `key` replaces the earlier item), a `ts` in epoch
//! milliseconds, the `kind`, and an optional `parentToolUseId` for items that belong to
//! a subagent thread.
//!
//! ```
//! use patchroom_claude::{ChatItem, ItemBody};
//! let item = ChatItem::new("k1", 1_700_000_000_000, ItemBody::Assistant { text: "hi".into() });
//! assert_eq!(
//!     serde_json::to_string(&item).unwrap(),
//!     r#"{"key":"k1","ts":1700000000000,"kind":"assistant","text":"hi"}"#
//! );
//! ```

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A reference to an image whose bytes are fetched on demand with `chat_image`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    /// Opaque reference. Pass it back to `chat_image` unchanged.
    #[serde(rename = "ref")]
    pub image_ref: String,
    /// MIME type, for example `image/png`.
    pub media_type: String,
}

/// Lifecycle of a tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolState {
    /// Waiting for a permission decision.
    Pending,
    /// Approved or auto-approved, no result yet.
    Running,
    /// Finished without error.
    Ok,
    /// Finished with an error.
    Error,
    /// The user or a rule refused the call.
    Denied,
    /// The user interrupted the call.
    Interrupted,
}

/// Result of a tool call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    /// Text of the result, cut to [`crate::RESULT_TEXT_LIMIT`] bytes.
    pub text: String,
    /// The CLI flagged the result as an error.
    pub is_error: bool,
    /// `text` was cut.
    pub truncated: bool,
    /// Images in the result, fetched with `chat_image`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageRef>,
}

/// One hunk of a unified diff. `lines` carry their prefix: space, `+` or `-`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    /// First line in the old file (1-based).
    pub old_start: u64,
    /// Old line count.
    pub old_lines: u64,
    /// First line in the new file (1-based).
    pub new_start: u64,
    /// New line count.
    pub new_lines: u64,
    /// Lines with their one-character prefix.
    pub lines: Vec<String>,
}

/// An inline diff for Edit and Write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// Absolute path of the file.
    pub file_path: String,
    /// The call creates the file.
    pub created: bool,
    /// Hunks. A pending call has one synthetic hunk built from its input.
    pub hunks: Vec<DiffHunk>,
}

/// One AskUserQuestion option.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    /// Label. It is the value the CLI expects as the answer.
    pub label: String,
    /// Longer description.
    #[serde(default)]
    pub description: String,
}

/// One AskUserQuestion question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionSpec {
    /// Question text. It is the key of the answer.
    pub question: String,
    /// Short header.
    #[serde(default)]
    pub header: String,
    /// Several options may be chosen.
    #[serde(default)]
    pub multi_select: bool,
    /// Offered options.
    #[serde(default)]
    pub options: Vec<QuestionOption>,
}

/// State of a question item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionState {
    /// Waiting for an answer.
    Pending,
    /// Answered. `answers` is set.
    Answered,
    /// The user declined to answer.
    Declined,
    /// The turn was interrupted.
    Interrupted,
}

/// State of a plan item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanState {
    /// Waiting for approval.
    Pending,
    /// The user approved the plan.
    Approved,
    /// The user rejected the plan.
    Rejected,
    /// The turn was interrupted.
    Interrupted,
}

/// State of a subagent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentState {
    /// Still working.
    Running,
    /// Finished.
    Ok,
    /// Failed.
    Error,
    /// Stopped by the user.
    Interrupted,
}

/// The kind-specific part of an item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ItemBody {
    /// A message from the human. `<pasted_content>` wrappers are unwrapped.
    User {
        /// Message text.
        text: String,
        /// Attached images.
        images: Vec<ImageRef>,
        /// The prompt was cancelled (Esc) before Claude replied or used a tool: the next
        /// prompt or an interrupt marker followed it with nothing in between.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        cancelled: bool,
    },
    /// Assistant text (markdown).
    Assistant {
        /// Markdown text.
        text: String,
    },
    /// Assistant thinking. Collapsed by default.
    Thinking {
        /// Thinking text.
        text: String,
    },
    /// A tool call and its result.
    Tool {
        /// Tool use id.
        tool_use_id: String,
        /// Tool name, for example `Bash` or `mcp__server__tool`.
        name: String,
        /// Tool input as the model wrote it. Strings over [`crate::INPUT_STRING_LIMIT`]
        /// bytes are cut and `input_truncated` is set.
        input: Value,
        /// Input strings were cut.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        input_truncated: bool,
        /// Lifecycle state.
        state: ToolState,
        /// Result, once there is one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<ToolResult>,
        /// Inline diff for Edit and Write.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<Diff>,
    },
    /// An AskUserQuestion call.
    Question {
        /// Tool use id.
        tool_use_id: String,
        /// The questions.
        questions: Vec<QuestionSpec>,
        /// Question text to answer, once answered.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answers: Option<std::collections::BTreeMap<String, String>>,
        /// Lifecycle state.
        state: QuestionState,
    },
    /// An ExitPlanMode call.
    Plan {
        /// Tool use id.
        tool_use_id: String,
        /// The plan (markdown).
        plan: String,
        /// Lifecycle state.
        state: PlanState,
    },
    /// A subagent started by the Agent tool. Its items come from `chat_thread`.
    Subagent {
        /// Tool use id of the Agent call. Pass it to `chat_thread`.
        tool_use_id: String,
        /// Short description.
        description: String,
        /// Agent type, for example `general-purpose`.
        agent_type: String,
        /// Number of items in the subagent thread.
        item_count: u64,
        /// Lifecycle state.
        state: SubagentState,
    },
    /// A harness event: compact boundary, local command output, turn duration, API error.
    System {
        /// One of the subtypes in [`crate::SYSTEM_SUBTYPES`].
        subtype: String,
        /// Display text.
        text: String,
    },
    /// Anything unrecognized. Renders as a row with "View in terminal".
    Fallback {
        /// The transcript line type (or block type) that was not recognized.
        line_type: String,
        /// Short description of the shape.
        summary: String,
    },
}

/// One chat item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatItem {
    /// Stable key. A later item with the same key replaces this one.
    pub key: String,
    /// Time in epoch milliseconds (0 when the line has no timestamp).
    pub ts: i64,
    /// Set on items that belong to a subagent thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_use_id: Option<String>,
    /// Kind-specific fields, flattened next to `kind`.
    #[serde(flatten)]
    pub body: ItemBody,
}

impl ChatItem {
    /// An item with no parent.
    pub fn new(key: impl Into<String>, ts: i64, body: ItemBody) -> Self {
        Self {
            key: key.into(),
            ts,
            parent_tool_use_id: None,
            body,
        }
    }

    /// The lowercase kind name.
    #[must_use]
    pub fn kind_name(&self) -> &'static str {
        match self.body {
            ItemBody::User { .. } => "user",
            ItemBody::Assistant { .. } => "assistant",
            ItemBody::Thinking { .. } => "thinking",
            ItemBody::Tool { .. } => "tool",
            ItemBody::Question { .. } => "question",
            ItemBody::Plan { .. } => "plan",
            ItemBody::Subagent { .. } => "subagent",
            ItemBody::System { .. } => "system",
            ItemBody::Fallback { .. } => "fallback",
        }
    }
}

/// Most characters of one item that search indexes.
pub const SEARCH_TEXT_LIMIT: usize = 8_000;
/// Tool input fields that say what a call did, in the order they are indexed.
const TOOL_INPUT_FIELDS: [&str; 7] = [
    "command",
    "file_path",
    "path",
    "pattern",
    "description",
    "url",
    "query",
];

fn clip_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

impl ChatItem {
    /// The text full-text search indexes for this item, or `None` for kinds that are not
    /// searched (thinking and unrecognized lines). Capped at [`SEARCH_TEXT_LIMIT`] characters.
    #[must_use]
    pub fn search_text(&self) -> Option<String> {
        let text = match &self.body {
            ItemBody::User { text, .. } | ItemBody::Assistant { text } => text.clone(),
            ItemBody::Thinking { .. } | ItemBody::Fallback { .. } => return None,
            ItemBody::Tool {
                name,
                input,
                result,
                ..
            } => {
                let mut parts = vec![name.clone()];
                for f in TOOL_INPUT_FIELDS {
                    if let Some(v) = input.get(f).and_then(Value::as_str) {
                        parts.push(v.to_owned());
                    }
                }
                if let Some(r) = result {
                    parts.push(clip_chars(&r.text, 2_000));
                }
                parts.join("\n")
            }
            ItemBody::Question {
                questions, answers, ..
            } => {
                let mut parts: Vec<String> = questions.iter().map(|q| q.question.clone()).collect();
                if let Some(a) = answers {
                    parts.extend(a.values().cloned());
                }
                parts.join("\n")
            }
            ItemBody::Plan { plan, .. } => plan.clone(),
            ItemBody::Subagent { description, .. } => description.clone(),
            ItemBody::System { text, .. } => text.clone(),
        };
        let text = clip_chars(text.trim(), SEARCH_TEXT_LIMIT);
        (!text.is_empty()).then_some(text)
    }

    /// One short line about the item for lists (snapshots, Activity rows): the first
    /// non-empty line of its text with runs of whitespace collapsed, at most `max` characters.
    #[must_use]
    pub fn summary(&self, max: usize) -> String {
        let base = match &self.body {
            ItemBody::Tool { name, input, .. } => {
                let detail = TOOL_INPUT_FIELDS
                    .iter()
                    .find_map(|f| input.get(*f).and_then(Value::as_str))
                    .unwrap_or("");
                format!("{name} {detail}")
            }
            ItemBody::Question { questions, .. } => questions
                .first()
                .map(|q| q.question.clone())
                .unwrap_or_default(),
            _ => self.search_text().unwrap_or_default(),
        };
        let line = base
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("");
        let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        clip_chars(&collapsed, max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn search_text_and_summary_cover_each_kind() {
        let user = ChatItem::new(
            "u",
            1,
            ItemBody::User {
                text: "  fix the\nlogin bug ".into(),
                images: vec![],
                cancelled: false,
            },
        );
        assert_eq!(user.search_text().as_deref(), Some("fix the\nlogin bug"));
        assert_eq!(user.summary(80), "fix the");
        let thinking = ChatItem::new("t", 1, ItemBody::Thinking { text: "hmm".into() });
        assert_eq!(thinking.search_text(), None);
        let tool = ChatItem::new(
            "x",
            1,
            ItemBody::Tool {
                tool_use_id: "x".into(),
                name: "Bash".into(),
                input: json!({"command": "cargo   test", "ignored": "zzz"}),
                input_truncated: false,
                state: ToolState::Ok,
                result: Some(ToolResult {
                    text: "3 passed".into(),
                    is_error: false,
                    truncated: false,
                    images: vec![],
                }),
                diff: None,
            },
        );
        assert_eq!(
            tool.search_text().as_deref(),
            Some("Bash\ncargo   test\n3 passed")
        );
        assert_eq!(tool.summary(80), "Bash cargo test");
        assert_eq!(tool.summary(6), "Bash c");
        let empty = ChatItem::new("e", 1, ItemBody::Assistant { text: "  ".into() });
        assert_eq!(empty.search_text(), None);
    }

    #[test]
    fn wire_format_is_camel_case_with_flat_kind() {
        let item = ChatItem::new(
            "toolu_1",
            5,
            ItemBody::Tool {
                tool_use_id: "toolu_1".into(),
                name: "Bash".into(),
                input: json!({"command": "ls"}),
                input_truncated: false,
                state: ToolState::Ok,
                result: Some(ToolResult {
                    text: "a".into(),
                    is_error: false,
                    truncated: false,
                    images: vec![],
                }),
                diff: None,
            },
        );
        assert_eq!(
            serde_json::to_value(&item).unwrap(),
            json!({
                "key": "toolu_1", "ts": 5, "kind": "tool", "toolUseId": "toolu_1",
                "name": "Bash", "input": {"command": "ls"}, "state": "ok",
                "result": {"text": "a", "isError": false, "truncated": false}
            })
        );
    }

    #[test]
    fn every_kind_round_trips() {
        let bodies = vec![
            ItemBody::User {
                text: "t".into(),
                images: vec![ImageRef {
                    image_ref: "main@0#0".into(),
                    media_type: "image/png".into(),
                }],
                cancelled: true,
            },
            ItemBody::Thinking { text: "t".into() },
            ItemBody::Question {
                tool_use_id: "q".into(),
                questions: vec![],
                answers: None,
                state: QuestionState::Pending,
            },
            ItemBody::Plan {
                tool_use_id: "p".into(),
                plan: "x".into(),
                state: PlanState::Approved,
            },
            ItemBody::Subagent {
                tool_use_id: "a".into(),
                description: "d".into(),
                agent_type: "general-purpose".into(),
                item_count: 3,
                state: SubagentState::Running,
            },
            ItemBody::System {
                subtype: "turn_duration".into(),
                text: "t".into(),
            },
            ItemBody::Fallback {
                line_type: "x".into(),
                summary: "s".into(),
            },
        ];
        for b in bodies {
            let item = ChatItem::new("k", 1, b);
            let v = serde_json::to_value(&item).unwrap();
            assert_eq!(v["kind"], item.kind_name());
            let back: ChatItem = serde_json::from_value(v).unwrap();
            assert_eq!(back, item);
        }
    }
}
