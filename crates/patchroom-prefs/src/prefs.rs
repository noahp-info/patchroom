//! The `Prefs` of the IPC contract (camelCase JSON), its defaults and patching.
//!
//! A patch replaces whole top-level keys, as `Partial<Prefs>` does in TypeScript. After a
//! patch, missing nested fields are filled from the defaults, so a client that sends a partial
//! group never leaves the stored prefs malformed.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::dnd::{parse_hhmm, Dnd};

/// Largest serialized prefs the backend stores, in bytes.
const MAX_PREFS_BYTES: usize = 1024 * 1024;

/// Patchroom events that can notify or sound.
pub const EVENTS: [&str; 5] = ["needs", "done", "message", "error", "bell"];

/// How much a DM may notify.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// Every event.
    All,
    /// Only needs-you.
    Needs,
    /// Nothing.
    Mute,
}

/// What to do about an event that one of the user's own sound hooks already covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookPolicy {
    /// Keep the user's hook; Patchroom stays silent for that event.
    Keep,
    /// Play both.
    Both,
}

/// Per-DM sound override.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DmSound {
    /// Follow the global sound settings.
    Default,
    /// No sound for this DM.
    Mute,
}

/// Notification settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Notify {
    /// Level for DMs without their own.
    pub default: Level,
    /// Level per DM id.
    #[serde(rename = "perDm")]
    pub per_dm: BTreeMap<String, Level>,
}

impl Default for Notify {
    fn default() -> Self {
        Self {
            default: Level::All,
            per_dm: BTreeMap::new(),
        }
    }
}

/// One event's sound.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventSound {
    /// Play it.
    pub on: bool,
    /// Which sound.
    pub sound: String,
}

/// Sound settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Sound {
    /// Master switch.
    pub enabled: bool,
    /// 0.0 to 1.0.
    pub volume: f64,
    /// Settings per Patchroom event.
    pub per_event: BTreeMap<String, EventSound>,
    /// Override per DM id.
    pub per_dm: BTreeMap<String, DmSound>,
    /// Policy per event, keyed by Patchroom event or by Claude hook event name.
    pub hook_policy: BTreeMap<String, HookPolicy>,
}

impl Default for Sound {
    fn default() -> Self {
        let on = |e: &str, on: bool| {
            (
                e.to_owned(),
                EventSound {
                    on,
                    sound: e.to_owned(),
                },
            )
        };
        Self {
            enabled: true,
            volume: 0.6,
            per_event: BTreeMap::from([
                on("needs", true),
                on("done", true),
                on("message", false),
                on("error", true),
                on("bell", true),
            ]),
            per_dm: BTreeMap::new(),
            hook_policy: BTreeMap::new(),
        }
    }
}

/// Light, dark or follow the system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Light.
    Light,
    /// Dark.
    Dark,
    /// Follow the system.
    System,
}

/// A DM's terminal palette and font.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermStyle {
    /// Theme id for the terminal palette.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_id: Option<String>,
    /// Font family.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    /// Font size in px.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
}

/// All preferences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Prefs {
    /// Selected theme.
    pub theme_id: String,
    /// Light, dark or system.
    pub mode: Mode,
    /// Themes the user made or imported. The shape belongs to the UI's theme engine.
    pub custom_themes: Vec<Value>,
    /// Notification levels.
    pub notify: Notify,
    /// Sounds.
    pub sound: Sound,
    /// Do Not Disturb.
    pub dnd: Dnd,
    /// Terminal style per DM id (`*` is the default for every DM).
    pub term_per_dm: BTreeMap<String, TermStyle>,
    /// Search other Claude Code sessions too. Off by default.
    pub search_all_sessions: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            theme_id: "homeroom".into(),
            mode: Mode::System,
            custom_themes: Vec::new(),
            notify: Notify::default(),
            sound: Sound::default(),
            dnd: Dnd::default(),
            term_per_dm: BTreeMap::new(),
            search_all_sessions: false,
        }
    }
}

/// Why a stored value or a patch was refused.
#[derive(Debug)]
pub struct PrefsError(pub String);

impl std::error::Error for PrefsError {}

impl std::fmt::Display for PrefsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid preferences: {}", self.0)
    }
}

impl Prefs {
    /// Parse stored JSON. Anything unreadable gives the defaults, so a damaged setting never
    /// stops the app.
    #[must_use]
    pub fn from_stored(raw: &str) -> Self {
        serde_json::from_str::<Self>(raw)
            .ok()
            .and_then(|p| p.validated().ok())
            .unwrap_or_default()
    }

    /// Apply `patch` (an object of top-level keys) and return the result.
    ///
    /// # Errors
    /// The patch is not an object, a value has the wrong type, or a value is out of range.
    pub fn patched(&self, patch: &Value) -> Result<Self, PrefsError> {
        let Value::Object(map) = patch else {
            return Err(PrefsError("the patch must be an object".into()));
        };
        let mut cur = serde_json::to_value(self).map_err(|e| PrefsError(e.to_string()))?;
        if let Value::Object(cur_map) = &mut cur {
            for (k, v) in map {
                if !cur_map.contains_key(k) {
                    return Err(PrefsError(format!("unknown preference {k:?}")));
                }
                cur_map.insert(k.clone(), v.clone());
            }
        }
        serde_json::from_value::<Self>(cur)
            .map_err(|e| PrefsError(e.to_string()))?
            .validated()
    }

    /// Fill and check: every event has a sound row, volume is 0 to 1, a schedule is sane.
    fn validated(mut self) -> Result<Self, PrefsError> {
        let size = serde_json::to_string(&self).map_or(usize::MAX, |s| s.len());
        if size > MAX_PREFS_BYTES {
            return Err(PrefsError("the preferences are too large".into()));
        }
        let defaults = Sound::default();
        for e in EVENTS {
            if !self.sound.per_event.contains_key(e) {
                if let Some(d) = defaults.per_event.get(e) {
                    self.sound.per_event.insert(e.to_owned(), d.clone());
                }
            }
        }
        if !self.sound.volume.is_finite() {
            return Err(PrefsError("volume must be a number".into()));
        }
        self.sound.volume = self.sound.volume.clamp(0.0, 1.0);
        if let Some(s) = &self.dnd.schedule {
            if parse_hhmm(&s.start).is_none() || parse_hhmm(&s.end).is_none() {
                return Err(PrefsError("schedule times must be HH:MM".into()));
            }
            if s.days.iter().any(|d| *d > 6) {
                return Err(PrefsError("schedule days must be 0 (Sunday) to 6".into()));
            }
        }
        if self.theme_id.trim().is_empty() {
            return Err(PrefsError("themeId must not be empty".into()));
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_the_contract_shape() {
        let v = serde_json::to_value(Prefs::default()).unwrap();
        assert_eq!(v["themeId"], "homeroom");
        assert_eq!(v["mode"], "system");
        assert_eq!(v["notify"], json!({"default":"all","perDm":{}}));
        assert_eq!(
            v["sound"]["perEvent"]["needs"],
            json!({"on":true,"sound":"needs"})
        );
        assert_eq!(v["sound"]["perEvent"]["message"]["on"], false);
        assert_eq!(v["sound"]["hookPolicy"], json!({}));
        assert_eq!(v["dnd"], json!({"manual":false,"schedule":null}));
        assert_eq!(v["termPerDm"], json!({}));
        assert_eq!(v["searchAllSessions"], false);
        assert_eq!(v["customThemes"], json!([]));
    }

    #[test]
    fn a_patch_replaces_top_level_keys_and_keeps_the_rest() {
        let p = Prefs::default()
            .patched(
                &json!({"themeId":"patchbay","notify":{"default":"needs","perDm":{"a":"mute"}}}),
            )
            .unwrap();
        assert_eq!(p.theme_id, "patchbay");
        assert_eq!(p.notify.default, Level::Needs);
        assert_eq!(p.notify.per_dm["a"], Level::Mute);
        assert!(p.sound.enabled);
        // A second patch of `notify` replaces the group: `a` is gone.
        let p = p
            .patched(&json!({"notify":{"default":"all","perDm":{}}}))
            .unwrap();
        assert!(p.notify.per_dm.is_empty());
    }

    #[test]
    fn partial_groups_are_filled_from_defaults() {
        let p = Prefs::default()
            .patched(&json!({"sound":{"volume":0.2},"notify":{}}))
            .unwrap();
        assert!(p.sound.enabled);
        assert!((p.sound.volume - 0.2).abs() < 1e-9);
        assert_eq!(p.sound.per_event.len(), 5);
        assert_eq!(p.notify, Notify::default());
    }

    #[test]
    fn bad_patches_are_refused_and_change_nothing() {
        let base = Prefs::default();
        for bad in [
            json!("x"),
            json!({"nope":1}),
            json!({"mode":"purple"}),
            json!({"notify":{"default":"loud"}}),
            json!({"sound":{"volume":"high"}}),
            json!({"dnd":{"manual":false,"schedule":{"days":[7],"start":"22:00","end":"07:00"}}}),
            json!({"dnd":{"manual":false,"schedule":{"days":[1],"start":"25:00","end":"07:00"}}}),
            json!({"themeId":"  "}),
        ] {
            assert!(base.patched(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn oversized_prefs_are_refused() {
        let big = "x".repeat(MAX_PREFS_BYTES);
        assert!(Prefs::default()
            .patched(&json!({"customThemes":[{"blob": big}]}))
            .is_err());
    }

    #[test]
    fn volume_is_clamped_and_unreadable_storage_gives_defaults() {
        let p = Prefs::default()
            .patched(&json!({"sound":{"volume":7}}))
            .unwrap();
        assert!((p.sound.volume - 1.0).abs() < 1e-9);
        assert_eq!(Prefs::from_stored("not json"), Prefs::default());
        assert_eq!(
            Prefs::from_stored("{\"mode\":\"purple\"}"),
            Prefs::default()
        );
        let p = Prefs::from_stored("{\"themeId\":\"x\"}");
        assert_eq!(p.theme_id, "x");
        assert!(p.sound.enabled);
    }

    #[test]
    fn json_round_trip_is_stable() {
        let p = Prefs::default()
            .patched(&json!({
                "termPerDm":{"a":{"themeId":"t","fontSize":13.0}},
                "dnd":{"manual":true,"schedule":{"days":[1,2],"start":"22:00","end":"07:00"}},
                "customThemes":[{"id":"mine"}]
            }))
            .unwrap();
        let back = Prefs::from_stored(&serde_json::to_string(&p).unwrap());
        assert_eq!(back, p);
    }
}
