//! Read-only discovery of resumable Claude Code sessions for a folder section.
//!
//! A folder section lists every session whose launch folder is the section's home folder or
//! inside it, plus the linked git worktrees of the folder that live outside it. Claude files a
//! session's transcript under `<config dir>/projects/<encoded launch folder>/<session id>.jsonl`.
//! This crate finds those directories, reads each transcript cheaply (head for the first prompt,
//! the whole file once for counts, the tail for titles and the newest timestamp, cached by size
//! and mtime and extended incrementally when a transcript grows), names the session by a fixed
//! precedence and reports it. It never writes anything: not under the Claude config dir, not
//! anywhere else.
//!
//! Layout: [`encode`] (path encoding), [`scan`] (one transcript), [`names`] (the session-naming
//! registry), [`worktrees`] (`git worktree list`), [`discover`] (the listing) and the
//! [`signature`] change detector the app polls once a second.

pub mod discover;
pub mod encode;
pub mod names;
pub mod scan;
pub mod worktrees;

pub use discover::{signature, Discovery, FolderSession, Listing, LiveState, NameSource, Query};
pub use scan::FileScan;
