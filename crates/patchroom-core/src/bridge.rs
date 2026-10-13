//! Hook bridge: a user-owned (`0600`) unix socket that the `patchroom-hook` binary
//! forwards CLI hook JSON to, and through which decisions flow back.
//!
//! No TCP listeners, ever. Timeouts fail open to the CLI's own TUI.
//! Planned for phase P1 (spec sections 2 and 4).
