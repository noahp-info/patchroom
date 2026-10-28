//! Patchroom hook bridge.
//!
//! The bridge is a unix-socket server (mode `0600`, newline-delimited JSON, see
//! [`protocol`]). The tiny `patchroom-hook` binary forwards every CLI hook to it. The
//! bridge turns hook traffic into status events, and holds two kinds of hook open so a
//! chat client can answer them natively:
//!
//! * `PermissionRequest`: the TUI dialog is live while the hook runs and the hook is never
//!   cancelled by the CLI. A chat answer returns allow or deny. If the user answers in the
//!   TUI first, the bridge notices (PostToolUse, or a `tool_result` in the transcript) and
//!   cancels the pending hook so it exits.
//! * `PreToolUse` for `AskUserQuestion`: the TUI picker stays hidden until the hook
//!   returns. A chat answer returns `updatedInput` with `answers`. There is no practical
//!   timeout ([`ASK_HOLD`]): the hold ends on an answer (chat or terminal), an interrupt,
//!   or when the session or the hook goes away.
//! * `PreToolUse` for `ExitPlanMode`: same hold. No hook decision can close the TUI plan
//!   dialog (it ignores both a `PermissionRequest` and a `PreToolUse` allow), so a chat
//!   client answers by releasing the hold with [`Bridge::release`] and pressing the
//!   dialog's keys itself.
//! * `PermissionRequest` for `AskUserQuestion` or `ExitPlanMode`: the call reached the
//!   permission path without a chat answer (for example after a resume). It is held as a
//!   question or plan prompt, with the TUI picker or dialog already on screen
//!   (`tui_shown`). A chat answer to a question allows the permission with the answers in
//!   `updatedInput`. When the TUI just took the call over from a `PreToolUse` hold (chat
//!   plan answer, hand-off to the terminal, interrupt), the hook returns at once instead.
//!
//! Per prompt, the first answer wins ([`events::Resolution`]). Every other path fails
//! open: no decision means the CLI's own TUI decides.
//!
//! ```no_run
//! use patchroom_bridge::{Bridge, BridgeConfig, HookSettings, PermissionAnswer};
//!
//! let bridge = Bridge::start(BridgeConfig::new("/tmp/pr/bridge.sock"))?;
//! bridge.set_chat_attached(true);
//! let events = bridge.subscribe();
//! let settings = HookSettings::new("/path/to/patchroom-hook", bridge.socket_path())
//!     .with_session_key("dm-1");
//! // launch: claude --setting-sources local --settings <settings.to_json_string()>
//! # let _ = (settings, events);
//! # let _ = PermissionAnswer::Allow;
//! # Ok::<(), patchroom_bridge::BridgeError>(())
//! ```

pub mod agents;
pub mod events;
pub mod hookinfo;
pub mod protocol;
pub mod settings;
pub mod statusline;
pub mod transcript;

mod server;

pub use agents::{AgentEntry, AgentsSource, CommandAgentsSource};
pub use events::{
    BridgeEvent, HookRecord, NeedsKind, OpenUrlRecord, PermissionPrompt, PlanPrompt, PromptId,
    PromptResolved, Question, QuestionOption, QuestionPrompt, Resolution, SessionRef, Status,
    StatusEvent, StatusSource, StatuslineRecord,
};
pub use hookinfo::HookInfo;
pub use server::{
    AnswerError, Bridge, BridgeConfig, BridgeError, PendingKind, PendingPrompt, PermissionAnswer,
    QuestionAnswers, Reconciler, ASK_HOLD,
};
pub use settings::{HookSettings, StatuslineWrap};
