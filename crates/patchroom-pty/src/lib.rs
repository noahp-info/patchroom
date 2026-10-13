//! PTY session host for Patchroom.
//!
//! [`Session::spawn`] starts a command through the user's login shell
//! (`$SHELL -l -c`) on a fresh PTY and returns a [`Session`] handle. Output
//! and parsed terminal events arrive on a channel from a dedicated drain
//! thread, so the child can never block on a full PTY buffer.
//!
//! ```no_run
//! use patchroom_pty::{Command, PtyEvent, Session, SpawnConfig};
//!
//! let cfg = SpawnConfig::new(Command::program("claude", ["--model", "haiku"]), "s1");
//! let session = Session::spawn(cfg)?;
//! let events = session.events();
//! session.send_text("hello")?; // bracketed paste, then Enter after 400ms
//! while let Ok(ev) = events.recv() {
//!     match ev {
//!         PtyEvent::Output(bytes) => { /* forward to xterm.js */ let _ = bytes; }
//!         PtyEvent::Exit(_) => break,
//!         _ => {}
//!     }
//! }
//! # Ok::<(), patchroom_pty::Error>(())
//! ```
//!
//! Behaviour taken from the claude TUI spikes:
//! - inherited `CLAUDE*` variables are removed (they disable transcripts);
//! - the stream is drained continuously;
//! - text is injected as a bracketed paste with a separate delayed Enter;
//! - OSC 0/1/2, OSC 9 and OSC 9;4 are parsed into events without touching the
//!   bytes forwarded to the terminal.

mod config;
mod error;
mod event;
mod keys;
mod parser;
mod session;

pub use config::{
    build_env, is_stripped_env, shell_quote, Command, SpawnConfig, DEFAULT_ENTER_DELAY,
};
pub use error::{Error, Result};
pub use event::{ExitInfo, ProgressState, PtyEvent, TerminalQuery, TitleKind};
pub use keys::{bracketed_paste, Key, PASTE_END, PASTE_START};
pub use parser::{Scanned, Scanner};
pub use session::Session;
