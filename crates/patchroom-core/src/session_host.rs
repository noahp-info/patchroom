//! Session host: one `portable-pty` per DM, spawned as `$SHELL -l -c '<cli> <args>'`.
//!
//! Inherits the user's login-shell env, PATH and config. Never spawns an alias.
//! Planned for phase P1 (spec section 2).
