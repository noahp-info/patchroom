//! Patchroom Claude Code adapter.
//!
//! Turns a Claude Code session transcript (JSONL) into [`ChatItem`]s for the chat layer.
//!
//! * [`item`]: the wire format (camelCase JSON, `kind` tag).
//! * [`map`]: line to item mapping, the hidden-metadata lists, accounting.
//! * [`tail`]: the offset-based incremental reader.
//! * [`adapter`]: [`Adapter`] and the background [`Watcher`], history paging, subagent
//!   threads and on-demand images.
//!
//! The `patchroom-claude dump <transcript.jsonl>` binary runs a whole file through the
//! mapper and prints the items plus line accounting (see [`dump`]).

pub mod adapter;
pub mod dump;
pub mod item;
pub mod map;
pub mod tail;
mod text;

pub use adapter::{Adapter, Cursor, Locator, Page, Update, Watcher};
pub use item::{
    ChatItem, Diff, DiffHunk, ImageRef, ItemBody, PlanState, QuestionOption, QuestionSpec,
    QuestionState, SubagentState, ToolResult, ToolState,
};
pub use map::{
    cap_strings, Accounting, Feed, Mapper, Meta, Outcome, HIDDEN_ATTACHMENT_TYPES,
    HIDDEN_LINE_TYPES, INPUT_STRING_LIMIT, RESULT_TEXT_LIMIT, SYSTEM_SUBTYPES,
};
