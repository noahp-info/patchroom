//! Preferences and the notification decision, free of any UI framework so it is easy to test.
//!
//! * [`prefs`]: the `Prefs` shape of the IPC contract, defaults and patching.
//! * [`dnd`]: Do Not Disturb, manual and scheduled, in local wall-clock time.
//! * [`hooks`]: read-only detection of the user's own sound hooks in Claude settings files.
//! * [`decision`]: whether an event notifies, and the line written to the decision log.

pub mod decision;
pub mod dnd;
pub mod hooks;
pub mod prefs;

pub use decision::{decide, log_line, Decision, Event, Facts, Reason};
pub use dnd::{parse_hhmm, Dnd, Schedule};
pub use hooks::{detect_sound_hooks, DetectedHook};
pub use prefs::{
    valid_sound_id, DmMix, DmSound, HookPolicy, Level, Pick, Prefs, DEFAULT_PACK, SOUND_EVENTS,
};
