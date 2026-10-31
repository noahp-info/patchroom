//! Error type for the PTY host.

use std::io;

/// Errors returned by [`crate::Session`] operations.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The PTY could not be opened or the child could not be spawned.
    #[error("failed to spawn pty child: {0}")]
    Spawn(String),
    /// Resizing the PTY failed.
    #[error("failed to resize pty: {0}")]
    Resize(String),
    /// Writing to the PTY failed, usually because the child already exited.
    #[error("pty write failed: {0}")]
    Write(#[source] io::Error),
    /// A [`crate::Key::Digit`] value was greater than 9.
    #[error("digit key out of range: {0}")]
    InvalidDigit(u8),
    /// Sending a signal to the child process group failed.
    #[error("signal failed: {0}")]
    Signal(String),
}

/// Convenience alias.
pub type Result<T> = std::result::Result<T, Error>;
