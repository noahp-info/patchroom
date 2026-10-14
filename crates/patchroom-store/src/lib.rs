//! Patchroom store: the SQLite persistence layer.
//!
//! Open a [`Store`] on a data directory the caller owns, then use the typed
//! methods for workspaces, sections, conversations, memberships, messages,
//! comments (anchored to message text ranges), tasks, claims, reactions, pins,
//! drafts, plugins and settings.
//!
//! Design rules:
//! - Every row has a ULID `id`, an [`Author`], `created_at` and `updated_at`
//!   (unix milliseconds), so rows can be merged by a future sync layer.
//! - The database runs in WAL mode with foreign keys on.
//! - Schema changes ship as numbered, forward-only migrations in `migrations/`.
//! - Nothing here stores secrets. Credential-like setting keys are refused and
//!   attachments hold paths, never file contents.
//!
//! A [`Store`] wraps one connection and is not `Sync`. Open one per thread or
//! guard it with a mutex.

#![warn(missing_docs)]

mod error;
pub mod migrate;
mod repo_badge;
mod repo_board;
mod repo_chat;
mod repo_misc;
mod repo_slack;
mod repo_workspace;
mod store;
mod types;

pub use error::{Error, Result};
pub use repo_board::{normalize_claim_path, paths_overlap, ClaimConflict};
pub use repo_misc::is_secret_like_key;
pub use repo_slack::DM_SECTION;
pub use store::{Store, DB_FILE};
pub use types::*;
