//! Sound packs for Patchroom, free of any UI framework so it is easy to test.
//!
//! * [`media`]: file types, and the duration read from a file's header.
//! * [`packs`]: the registry (generated packs, bundled file packs, imported packs) and file
//!   serving as data URLs.
//! * [`custom`]: the user's own sound files: import with limits, list, remove, prune.
//! * [`loudness`]: RMS and peak measurement, and the normalizing gain stored for imports.
//! * [`claude`]: read-only discovery and import of the user's Claude Code sound profiles.
//!
//! Nothing here opens a socket, and nothing writes outside the app data dir.

pub mod claude;
pub mod custom;
pub mod loudness;
pub mod media;
pub mod packs;

use std::fmt;

/// Why a sound request was refused. The message is shown to the user as is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SoundError(pub String);

impl SoundError {
    pub(crate) fn new(msg: impl Into<String>) -> Self {
        Self(msg.into())
    }
}

impl fmt::Display for SoundError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SoundError {}

impl From<std::io::Error> for SoundError {
    fn from(e: std::io::Error) -> Self {
        Self(format!("file error: {e}"))
    }
}

/// Result alias for this crate.
pub type Result<T> = std::result::Result<T, SoundError>;

/// Directory under the app data dir that holds custom sounds and imported packs.
pub const SOUNDS_DIR: &str = "sounds";
