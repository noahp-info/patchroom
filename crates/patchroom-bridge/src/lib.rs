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
//!   returns. A chat answer returns `updatedInput` with `answers`. If nobody answers
//!   within [`BridgeConfig::ask_wait`] the hook is released so the picker appears.
//! * `PreToolUse` for `ExitPlanMode`: same hold. No hook decision can close the TUI plan
//!   dialog (it ignores both a `PermissionRequest` and a `PreToolUse` allow), so a chat
//!   client answers by releasing the hold with [`Bridge::release`] and pressing the
//!   dialog's keys itself. A `PermissionRequest` for `ExitPlanMode` gets no decision.
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
    QuestionAnswers, Reconciler,
};
pub use settings::{HookSettings, StatuslineWrap};
