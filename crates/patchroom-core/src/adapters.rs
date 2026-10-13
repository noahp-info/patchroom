//! Adapters: one per CLI. Backend A is PTY + hooks + transcript tail (Claude Code, Codex).
//! Backend B is ACP/HTTP structured events plus a PTY view (Cursor, Gemini, Copilot, opencode).
//!
//! Planned for phase P2 (Claude Code) and P6 (the rest). See spec section 2.
