//! Typed events emitted by a [`crate::Session`].

/// Which title an OSC 0/1/2 sequence set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleKind {
    /// OSC 0: icon name and window title.
    IconAndWindow,
    /// OSC 1: icon name.
    Icon,
    /// OSC 2: window title.
    Window,
}

/// State carried by an OSC 9;4 progress report (ConEmu/Windows Terminal style,
/// which claude emits: 3 at prompt submit, 0 at stop).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressState {
    /// 0: clear the indicator (idle).
    Hidden,
    /// 1: determinate progress.
    Normal,
    /// 2: error.
    Error,
    /// 3: indeterminate (busy).
    Indeterminate,
    /// 4: paused or warning.
    Paused,
}

/// A terminal query that the emulator is expected to answer. xterm.js answers
/// these itself. A headless host sets `reply_to_terminal_queries` instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalQuery {
    /// `ESC [ c` (DA1).
    PrimaryDeviceAttributes,
    /// `ESC [ > 0 q` (XTVERSION).
    XtVersion,
}

/// How the child ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    /// Exit code. Signal deaths report 128 + signal on most platforms.
    pub code: u32,
    /// Signal name when the child was killed by one.
    pub signal: Option<String>,
}

impl ExitInfo {
    /// True for a clean zero exit.
    #[must_use]
    pub fn success(&self) -> bool {
        self.code == 0 && self.signal.is_none()
    }
}

/// An event from the PTY stream.
///
/// For each chunk read from the PTY, one [`PtyEvent::Output`] with the
/// untouched bytes is sent first, followed by the events parsed out of that
/// chunk. [`PtyEvent::Exit`] is always the last event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    /// Raw bytes exactly as the child wrote them. Feed these to the terminal.
    Output(Vec<u8>),
    /// OSC 0/1/2 title change.
    Title {
        /// Which title was set.
        kind: TitleKind,
        /// The new title.
        text: String,
    },
    /// OSC 9 attention message, for example "Claude needs your permission".
    Notification(String),
    /// OSC 777;notify attention message.
    Notify {
        /// Title, empty when absent.
        title: String,
        /// Body.
        body: String,
    },
    /// A BEL outside any escape sequence.
    Bell,
    /// OSC 9;4 progress report.
    Progress {
        /// State of the indicator.
        state: ProgressState,
        /// Percent complete (0 to 100) when present.
        value: Option<u8>,
    },
    /// The child sent a query a terminal should answer.
    Query(TerminalQuery),
    /// The child exited. No events follow.
    Exit(ExitInfo),
}
