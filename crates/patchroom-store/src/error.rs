//! Error type for the store.

use std::fmt;

/// Result alias used across the crate.
pub type Result<T> = std::result::Result<T, Error>;

/// Everything that can go wrong in the store.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The underlying SQLite call failed.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// Filesystem failure while preparing the data directory.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// A row the caller named does not exist.
    #[error("{entity} not found: {id}")]
    NotFound {
        /// Entity kind, e.g. `message`.
        entity: &'static str,
        /// The id or key that was looked up.
        id: String,
    },
    /// The input violates a rule the store enforces.
    #[error("invalid input: {0}")]
    Invalid(String),
    /// The write conflicts with existing state (for example an already owned task).
    #[error("conflict: {0}")]
    Conflict(String),
    /// The database was written by a newer build.
    #[error("database schema version {found} is newer than supported {supported}")]
    SchemaTooNew {
        /// Version found in the file.
        found: u32,
        /// Highest version this build knows.
        supported: u32,
    },
}

impl Error {
    pub(crate) fn not_found(entity: &'static str, id: impl fmt::Display) -> Self {
        Error::NotFound {
            entity,
            id: id.to_string(),
        }
    }

    pub(crate) fn invalid(msg: impl Into<String>) -> Self {
        Error::Invalid(msg.into())
    }
}
