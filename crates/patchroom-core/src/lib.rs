//! Patchroom core. UI-agnostic logic shared by the Tauri shell and tests.
//!
//! Patchroom wraps real AI coding CLIs in real PTYs and layers a chat UI on top.
//! See `docs/SPEC.md` for the design. Every module below is an empty placeholder
//! until its phase lands. The session host, hook bridge and store live in
//! their own crates: `patchroom-pty`, `patchroom-bridge`, `patchroom-store`.

pub mod adapters;
pub mod plugins;
