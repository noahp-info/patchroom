//! Preferences and the notification decision, free of any UI framework so it is easy to test.
//!
//! * [`prefs`]: the `Prefs` shape of the IPC contract, defaults and patching.
//! * [`dnd`]: Do Not Disturb, manual and scheduled, in local wall-clock time.
//! * [`fonts`]: font choices per area and per item, and the installed-family list.
//! * [`hooks`]: read-only detection of the user's own sound hooks in Claude settings files.
//! * [`dictation`]: Settings > Dictation (language, shortcut, silence timeout).
//! * [`decision`]: whether an event notifies, and the line written to the decision log.

pub mod decision;
pub mod dictation;
pub mod dnd;
pub mod fonts;
pub mod hooks;
pub mod models;
pub mod prefs;

pub use decision::{decide, log_line, Decision, Event, Facts, Reason};
pub use dictation::DictationPrefs;
pub use dnd::{parse_hhmm, Dnd, Schedule};
pub use fonts::{families_from_faces, FontChoice, FontFamily, Fonts};
pub use hooks::{detect_sound_hooks, DetectedHook};
pub use models::{valid_model_id, Flavor, Models, Updates};
pub use prefs::{
    valid_sound_id, Artifacts, DmMix, DmSound, HookPolicy, Level, LinkTarget, Links, Pick, Prefs,
    StatusBar, DEFAULT_PACK, MAX_GAIN, SOUND_EVENTS,
};
