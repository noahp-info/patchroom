//! Typed rows and inputs.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::error::Error;

/// Row identifier: a ULID, sortable by creation time and safe to mint offline.
pub type Id = ulid::Ulid;

/// Unix time in milliseconds.
pub type Millis = i64;

/// Who wrote a row. Stored as `human:<ref>` or `agent:<ref>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "ref", rename_all = "snake_case")]
pub enum Author {
    /// A person, identified by a caller chosen reference (for example `me`).
    Human(String),
    /// An agent, identified by its conversation id or provider name.
    Agent(String),
}

impl Author {
    /// The default local user.
    pub fn me() -> Self {
        Author::Human("me".into())
    }
}

impl fmt::Display for Author {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Author::Human(r) => write!(f, "human:{r}"),
            Author::Agent(r) => write!(f, "agent:{r}"),
        }
    }
}

impl FromStr for Author {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self, Error> {
        match s.split_once(':') {
            Some(("human", r)) if !r.is_empty() => Ok(Author::Human(r.into())),
            Some(("agent", r)) if !r.is_empty() => Ok(Author::Agent(r.into())),
            _ => Err(Error::invalid(format!("bad author ref: {s:?}"))),
        }
    }
}

macro_rules! str_enum {
    ($(#[$m:meta])* $name:ident { $($(#[$vm:meta])* $var:ident => $s:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $($(#[$vm])* #[serde(rename = $s)] $var),+
        }
        impl $name {
            /// The stored text form.
            pub fn as_str(self) -> &'static str {
                match self { $($name::$var => $s),+ }
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.as_str()) }
        }
        impl FromStr for $name {
            type Err = Error;
            fn from_str(s: &str) -> Result<Self, Error> {
                match s {
                    $($s => Ok($name::$var),)+
                    _ => Err(Error::invalid(format!(concat!("bad ", stringify!($name), ": {:?}"), s))),
                }
            }
        }
    };
}

str_enum! {
    /// Conversation flavor.
    ConversationKind {
        /// One session with one agent.
        Dm => "dm",
        /// A room that DMs join.
        Channel => "channel",
    }
}

str_enum! {
    /// What a sidebar section row is.
    SectionKind {
        /// A section that holds DMs.
        Section => "section",
        /// A rule with an optional label. A labeled divider folds the sections below it.
        Divider => "divider",
    }
}

str_enum! {
    /// How a channel hands out work (SPEC 3.7).
    AssignMode {
        /// Agents claim cards.
        BoardClaim => "board_claim",
        /// The human assigns with @mention.
        Mention => "mention",
        /// One lead agent dispatches.
        Lead => "lead",
    }
}

str_enum! {
    /// Message flavor.
    MessageKind {
        /// Typed by the human.
        User => "user",
        /// Agent output.
        Assistant => "assistant",
        /// Tool call or result.
        Tool => "tool",
        /// Harness event.
        System => "system",
        /// Patchroom-only item that never reaches the agent.
        Note => "note",
    }
}

str_enum! {
    /// Task board column.
    TaskStatus {
        /// Not started.
        Todo => "todo",
        /// An owner reserved it.
        Claimed => "claimed",
        /// In progress.
        Working => "working",
        /// Waiting on something.
        Blocked => "blocked",
        /// Awaiting review.
        Review => "review",
        /// Finished.
        Done => "done",
    }
}

str_enum! {
    /// Pin flavor.
    PinKind {
        /// Pinned to the conversation.
        Pin => "pin",
        /// Saved for later.
        Saved => "saved",
    }
}

str_enum! {
    /// What an [`ItemMark`] says about a chat item.
    MarkKind {
        /// Pinned to the conversation.
        Pin => "pin",
        /// Saved for later, across conversations.
        Saved => "saved",
        /// An emoji label. Never reaches the agent.
        Reaction => "reaction",
    }
}

/// A pin, saved item or reaction on one chat item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ItemMark {
    /// Row id.
    pub id: Id,
    /// Writer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Owning conversation.
    pub conversation_id: Id,
    /// Stable key of the chat item.
    pub item_key: String,
    /// Pin, saved or reaction.
    pub kind: MarkKind,
    /// The emoji of a reaction, empty otherwise.
    pub emoji: String,
    /// Up to [`SNAPSHOT_CHARS`] characters of the item's text.
    pub snapshot: String,
}

/// Longest `snapshot` of an [`ItemMark`], in characters.
pub const SNAPSHOT_CHARS: usize = 280;

/// When the oldest unread and needs-you items of a conversation appeared (Activity list).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityMarks {
    /// The conversation.
    pub conversation_id: Id,
    /// Unread count.
    pub unread: u32,
    /// A prompt waits on the user.
    pub needs_you: bool,
    /// Time of the oldest unread item.
    pub unread_since: Option<Millis>,
    /// Key of the oldest unread item.
    pub unread_key: Option<String>,
    /// Short text of the oldest unread item.
    pub unread_summary: Option<String>,
    /// Time the conversation started waiting on the user.
    pub needs_since: Option<Millis>,
}

/// Ids of the default sections created on first run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefaultSections {
    /// "Starred", or `None` once the user deleted it.
    pub starred: Option<Id>,
    /// "Direct messages": where new DMs land and deleted sections' DMs fall back to.
    pub dm: Id,
    /// "Archived", or `None` once the user deleted it.
    pub archived: Option<Id>,
}

/// A top level workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    /// Row id.
    pub id: Id,
    /// Writer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Display name.
    pub name: String,
}

/// A sidebar section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Section {
    /// Row id.
    pub id: Id,
    /// Writer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Owning workspace.
    pub workspace_id: Id,
    /// Display name.
    pub name: String,
    /// Zero based order within the workspace.
    pub position: i64,
    /// Whether the section is collapsed in the sidebar.
    pub collapsed: bool,
    /// Home folder of a folder section; `None` for a plain section.
    pub folder: Option<String>,
    /// Folder sections fold sessions idle this many days into "Older than X days".
    pub archive_days: i64,
    /// Whether this row holds DMs or is only a divider.
    pub kind: SectionKind,
    /// Leading emoji of the header; `None` for none.
    pub emoji: Option<String>,
}

/// Input for [`crate::Store::create_conversation`].
#[derive(Debug, Clone, PartialEq)]
pub struct NewConversation {
    /// Owning workspace.
    pub workspace_id: Id,
    /// Sidebar section, if placed.
    pub section_id: Option<Id>,
    /// `Dm` or `Channel`.
    pub kind: ConversationKind,
    /// Display name.
    pub name: String,
    /// Provider key such as `claude`.
    pub provider: Option<String>,
    /// Working directory.
    pub cwd: Option<String>,
    /// Git worktree path.
    pub worktree: Option<String>,
    /// CLI session id for resume.
    pub session_id: Option<String>,
    /// Channel assignment mode.
    pub assign_mode: Option<AssignMode>,
}

/// A DM or channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Conversation {
    /// Row id.
    pub id: Id,
    /// Writer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Owning workspace.
    pub workspace_id: Id,
    /// Sidebar section, if placed.
    pub section_id: Option<Id>,
    /// Order within the section.
    pub position: i64,
    /// DM or channel.
    pub kind: ConversationKind,
    /// Display name.
    pub name: String,
    /// Provider key such as `claude`.
    pub provider: Option<String>,
    /// Working directory.
    pub cwd: Option<String>,
    /// Git worktree path.
    pub worktree: Option<String>,
    /// CLI session id for resume.
    pub session_id: Option<String>,
    /// Opaque adapter state as JSON text.
    pub adapter_state: String,
    /// Channel assignment mode.
    pub assign_mode: Option<AssignMode>,
    /// Lead agent DM for `Lead` channels.
    pub lead_id: Option<Id>,
    /// Starred in the sidebar.
    pub starred: bool,
    /// Archived: hidden from the main list, no badges.
    pub archived: bool,
}

/// A DM that belongs to a channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Membership {
    /// Row id.
    pub id: Id,
    /// Writer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// The channel.
    pub channel_id: Id,
    /// The member DM.
    pub dm_id: Id,
}

/// Input for [`crate::Store::append_message`].
#[derive(Debug, Clone, PartialEq)]
pub struct NewMessage {
    /// Target conversation.
    pub conversation_id: Id,
    /// Writer.
    pub author: Author,
    /// Flavor.
    pub kind: MessageKind,
    /// Text.
    pub body: String,
    /// Transcript identity used to mirror idempotently (for example a uuid or line number).
    pub source_ref: Option<String>,
}

/// A chat message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    /// Row id.
    pub id: Id,
    /// Writer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Owning conversation.
    pub conversation_id: Id,
    /// Flavor.
    pub kind: MessageKind,
    /// Text.
    pub body: String,
    /// Transcript identity, if mirrored.
    pub source_ref: Option<String>,
}

/// A comment anchored to a byte range of a message body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Comment {
    /// Row id.
    pub id: Id,
    /// Writer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Anchored message.
    pub message_id: Id,
    /// Start byte offset (inclusive) in the message body.
    pub range_start: usize,
    /// End byte offset (exclusive) in the message body.
    pub range_end: usize,
    /// The highlighted text captured at creation.
    pub quote: String,
    /// The comment text.
    pub body: String,
    /// Marked done.
    pub resolved: bool,
    /// The message text under the range changed since creation.
    pub stale: bool,
}

/// A file attached to a message. Stores a path, never file contents.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    /// Row id.
    pub id: Id,
    /// Writer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Owning message.
    pub message_id: Id,
    /// Free form kind such as `screenshot`.
    pub kind: String,
    /// Display name.
    pub name: String,
    /// File path on disk.
    pub path: String,
    /// Media type.
    pub mime: Option<String>,
}

/// Input for [`crate::Store::create_task`].
#[derive(Debug, Clone, PartialEq)]
pub struct NewTask {
    /// Channel that owns the board.
    pub channel_id: Id,
    /// Card title.
    pub title: String,
    /// Card details.
    pub description: String,
}

/// A task board card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Task {
    /// Row id.
    pub id: Id,
    /// Writer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Owning channel.
    pub channel_id: Id,
    /// Card title.
    pub title: String,
    /// Card details.
    pub description: String,
    /// Current owner.
    pub owner: Option<Author>,
    /// Column.
    pub status: TaskStatus,
    /// Owner's worktree.
    pub worktree: Option<String>,
    /// Branch name.
    pub branch: Option<String>,
    /// Pull request URL.
    pub pr_url: Option<String>,
    /// Order on the board.
    pub position: i64,
}

/// Git facts for a task card.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TaskGit {
    /// Owner's worktree.
    pub worktree: Option<String>,
    /// Branch name.
    pub branch: Option<String>,
    /// Pull request URL.
    pub pr_url: Option<String>,
}

/// A file or area claim on a task.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Claim {
    /// Row id.
    pub id: Id,
    /// Claimer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Task the claim belongs to.
    pub task_id: Id,
    /// Normalized relative path or area.
    pub path: String,
    /// Release time; `None` while active.
    pub released_at: Option<Millis>,
}

/// An emoji label on a message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reaction {
    /// Row id.
    pub id: Id,
    /// Reactor.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Target message.
    pub message_id: Id,
    /// The emoji text.
    pub emoji: String,
}

/// A pinned or saved message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pin {
    /// Row id.
    pub id: Id,
    /// Writer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Target message.
    pub message_id: Id,
    /// Pin or saved.
    pub kind: PinKind,
}

/// The unsent composer text of a conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Draft {
    /// Row id.
    pub id: Id,
    /// Writer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Owning conversation.
    pub conversation_id: Id,
    /// Draft text.
    pub body: String,
}

/// Input for [`crate::Store::upsert_plugin`].
#[derive(Debug, Clone, PartialEq)]
pub struct NewPlugin {
    /// Unique plugin name.
    pub name: String,
    /// Version string.
    pub version: String,
    /// Capability manifest as JSON text.
    pub manifest: String,
}

/// An installed plugin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Plugin {
    /// Row id.
    pub id: Id,
    /// Installer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Unique name.
    pub name: String,
    /// Version string.
    pub version: String,
    /// Capability manifest as JSON text.
    pub manifest: String,
    /// Whether the plugin is active.
    pub enabled: bool,
}

/// A key/value setting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Setting {
    /// Row id.
    pub id: Id,
    /// Writer.
    pub author: Author,
    /// Creation time.
    pub created_at: Millis,
    /// Last change time.
    pub updated_at: Millis,
    /// Unique key.
    pub key: String,
    /// Value text (callers store JSON if they need structure).
    pub value: String,
}

/// Sidebar badges of one conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Badges {
    /// The conversation.
    pub conversation_id: Id,
    /// New assistant items since the DM was last viewed.
    pub unread: u32,
    /// A prompt waits on the user. Clears on resolution, never on view.
    pub needs_you: bool,
}
