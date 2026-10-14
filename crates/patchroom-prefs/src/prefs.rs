//! The `Prefs` of the IPC contract (camelCase JSON), its defaults and patching.
//!
//! A patch replaces whole top-level keys, as `Partial<Prefs>` does in TypeScript. After a
//! patch, missing nested fields are filled from the defaults, so a client that sends a partial
//! group never leaves the stored prefs malformed.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::dnd::{parse_hhmm, Dnd};

/// Layout bases the UI can render.
pub const BASES: [&str; 4] = ["homeroom", "patchbay", "scrollback", "bluepencil"];

/// Largest serialized prefs the backend stores, in bytes.
const MAX_PREFS_BYTES: usize = 1024 * 1024;

/// Patchroom events that can notify or sound.
pub const EVENTS: [&str; 5] = ["needs", "done", "message", "error", "bell"];

/// Every event a sound can be chosen for. `decision`, `due` and `session` are fired by later
/// phases; they are selectable and testable now.
pub const SOUND_EVENTS: [&str; 8] = [
    "needs", "done", "message", "error", "bell", "decision", "due", "session",
];

/// The pack every event uses until the user mixes.
pub const DEFAULT_PACK: &str = "patchtones";

/// Longest pack or custom sound id accepted in prefs.
const MAX_ID_LEN: usize = 64;

/// Is this a safe id for a pack or a custom sound? Letters, digits, `-` and `_` only.
#[must_use]
pub fn valid_sound_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

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

/// Largest per-sound gain: 150 percent.
pub const MAX_GAIN: f64 = 1.5;

fn one() -> f64 {
    1.0
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_one(g: &f64) -> bool {
    (*g - 1.0).abs() < 1e-9
}

/// What one event plays: a pack's sound, one of the user's own files, or nothing.
///
/// JSON: `{"pack": "<id>", "gain"?: 0..1.5}`, `{"custom": "<id>", "gain"?: 0..1.5}` or `"off"`.
/// `gain` is the user's own volume for that sound (default 1); it multiplies the sound's
/// normalizing gain and the master volume.
#[derive(Debug, Clone, PartialEq)]
pub enum Pick {
    /// The event's sound from this pack.
    Pack {
        /// Pack id.
        id: String,
        /// Per-sound volume multiplier, 0 to 1.5.
        gain: f64,
    },
    /// A custom sound the user added.
    Custom {
        /// Custom sound id (ULID).
        id: String,
        /// Per-sound volume multiplier, 0 to 1.5.
        gain: f64,
    },
    /// No sound for the event.
    Off,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum PickRepr {
    Word(String),
    Pack {
        pack: String,
        #[serde(default = "one", skip_serializing_if = "is_one")]
        gain: f64,
    },
    Custom {
        custom: String,
        #[serde(default = "one", skip_serializing_if = "is_one")]
        gain: f64,
    },
}

impl Serialize for Pick {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Pack { id, gain } => PickRepr::Pack {
                pack: id.clone(),
                gain: *gain,
            },
            Self::Custom { id, gain } => PickRepr::Custom {
                custom: id.clone(),
                gain: *gain,
            },
            Self::Off => PickRepr::Word("off".into()),
        }
        .serialize(s)
    }
}

impl<'de> Deserialize<'de> for Pick {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match PickRepr::deserialize(d)? {
            PickRepr::Word(w) if w == "off" => Ok(Self::Off),
            PickRepr::Word(w) => Err(serde::de::Error::custom(format!(
                "a sound choice is {{pack}}, {{custom}} or \"off\", not {w:?}"
            ))),
            PickRepr::Pack { pack, gain } => Ok(Self::Pack { id: pack, gain }),
            PickRepr::Custom { custom, gain } => Ok(Self::Custom { id: custom, gain }),
        }
    }
}

impl Pick {
    /// A pack sound at the default gain.
    #[must_use]
    pub fn pack(id: impl Into<String>) -> Self {
        Self::Pack {
            id: id.into(),
            gain: 1.0,
        }
    }

    /// A custom sound at the default gain.
    #[must_use]
    pub fn custom(id: impl Into<String>) -> Self {
        Self::Custom {
            id: id.into(),
            gain: 1.0,
        }
    }

    /// The per-sound gain (1 for `Off`).
    #[must_use]
    pub fn gain(&self) -> f64 {
        match self {
            Self::Pack { gain, .. } | Self::Custom { gain, .. } => *gain,
            Self::Off => 1.0,
        }
    }

    fn valid(&self) -> bool {
        match self {
            Self::Pack { id, gain } | Self::Custom { id, gain } => {
                valid_sound_id(id) && gain.is_finite() && (0.0..=MAX_GAIN).contains(gain)
            }
            Self::Off => true,
        }
    }
}

/// A DM's own sound mix: the whole pack, or single events.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DmMix {
    /// Pack that every event of this DM uses, unless `mix` names the event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<String>,
    /// Single events that differ.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mix: BTreeMap<String, Pick>,
}

/// Per-DM sound override.
///
/// JSON: `"default"`, `"mute"`, or `{pack?, mix?}` (P3 stored only the two words).
#[derive(Debug, Clone, PartialEq)]
pub enum DmSound {
    /// Follow the global sound settings.
    Default,
    /// No sound for this DM.
    Mute,
    /// This DM's own pack or mix.
    Mix(DmMix),
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum DmSoundRepr {
    Word(String),
    Mix(DmMix),
}

impl Serialize for DmSound {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Default => DmSoundRepr::Word("default".into()),
            Self::Mute => DmSoundRepr::Word("mute".into()),
            Self::Mix(m) => DmSoundRepr::Mix(m.clone()),
        }
        .serialize(s)
    }
}

impl<'de> Deserialize<'de> for DmSound {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match DmSoundRepr::deserialize(d)? {
            DmSoundRepr::Word(w) if w == "default" => Ok(Self::Default),
            DmSoundRepr::Word(w) if w == "mute" => Ok(Self::Mute),
            DmSoundRepr::Word(w) => Err(serde::de::Error::custom(format!(
                "a DM sound is \"default\", \"mute\" or {{pack, mix}}, not {w:?}"
            ))),
            DmSoundRepr::Mix(m) => Ok(Self::Mix(m)),
        }
    }
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
    /// Override per DM id: mute, or the DM's own pack or mix.
    pub per_dm: BTreeMap<String, DmSound>,
    /// What each of the 8 events plays. Missing events play Patch Tones.
    pub mix: BTreeMap<String, Pick>,
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
                on("decision", true),
                on("due", true),
                on("session", true),
            ]),
            per_dm: BTreeMap::new(),
            mix: SOUND_EVENTS
                .iter()
                .map(|e| ((*e).to_owned(), Pick::pack(DEFAULT_PACK)))
                .collect(),
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
    /// Layout base: `homeroom` (Slack-faithful) or `patchbay` (hardware panel).
    pub base: String,
    /// Patch Bay cable and plug preset id, or `theme` to follow the theme's own tokens.
    pub cable_preset: String,
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
    /// Sidebar width in px. Clamped to `SIDEBAR_MIN..=SIDEBAR_MAX`; a blob without it gets 264.
    pub sidebar_width: u32,
}

/// Narrowest sidebar the UI lets the user drag to.
pub const SIDEBAR_MIN: u32 = 220;
/// Widest sidebar the UI lets the user drag to.
pub const SIDEBAR_MAX: u32 = 420;
/// Sidebar width when nothing is stored, and what a double-click on the handle resets to.
pub const SIDEBAR_DEFAULT: u32 = 264;

impl Default for Prefs {
    fn default() -> Self {
        Self {
            theme_id: "homeroom".into(),
            mode: Mode::System,
            base: "homeroom".into(),
            cable_preset: "theme".into(),
            custom_themes: Vec::new(),
            notify: Notify::default(),
            sound: Sound::default(),
            dnd: Dnd::default(),
            term_per_dm: BTreeMap::new(),
            search_all_sessions: false,
            sidebar_width: SIDEBAR_DEFAULT,
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
        Self::from_stored_with(raw, false)
    }

    /// Does `raw` parse and validate as stored prefs? When it does not, [`Prefs::from_stored`]
    /// falls back to the defaults, and a caller must not act on the defaults as if they were
    /// the user's choices (for example by deleting files nothing seems to reference).
    #[must_use]
    pub fn is_readable(raw: &str) -> bool {
        serde_json::from_str::<Self>(raw).is_ok_and(|p| p.validated().is_ok())
    }

    /// Like [`Prefs::from_stored`]. `session_hook` says the user already has a SessionStart
    /// audio hook: when the stored prefs have no `session` sound row yet (first run, or P3-era
    /// prefs), that row starts off so the app never doubles the user's own start sound.
    #[must_use]
    pub fn from_stored_with(raw: &str, session_hook: bool) -> Self {
        let fresh = serde_json::from_str::<Value>(raw).map_or(true, |v| {
            v.pointer("/sound/perEvent/session")
                .is_none_or(Value::is_null)
        });
        let mut p = serde_json::from_str::<Self>(raw)
            .ok()
            .and_then(|p| p.validated().ok())
            .unwrap_or_default();
        if fresh {
            p.apply_session_default(session_hook);
        }
        p
    }

    /// Set the `session` sound row for a user who has (or has not) a SessionStart audio hook.
    pub fn apply_session_default(&mut self, session_hook: bool) {
        if let Some(row) = self.sound.per_event.get_mut("session") {
            row.on = !session_hook;
        }
    }

    /// Ids of the custom sounds that this mix or any DM mix points at.
    #[must_use]
    pub fn custom_sound_ids(&self) -> std::collections::HashSet<String> {
        let mut ids = std::collections::HashSet::new();
        let mut take = |m: &BTreeMap<String, Pick>| {
            for p in m.values() {
                if let Pick::Custom { id, .. } = p {
                    ids.insert(id.clone());
                }
            }
        };
        take(&self.sound.mix);
        for d in self.sound.per_dm.values() {
            if let DmSound::Mix(m) = d {
                take(&m.mix);
            }
        }
        ids
    }

    /// Replace every pick of custom sound `id` with Patch Tones for that event, so removing a
    /// custom file falls back to a pack sound. Returns whether anything changed.
    pub fn drop_custom_sound(&mut self, id: &str) -> bool {
        let mut changed = false;
        let mut fix = |m: &mut BTreeMap<String, Pick>| {
            for p in m.values_mut() {
                if matches!(p, Pick::Custom { id: c, .. } if c == id) {
                    *p = Pick::pack(DEFAULT_PACK);
                    changed = true;
                }
            }
        };
        fix(&mut self.sound.mix);
        for d in self.sound.per_dm.values_mut() {
            if let DmSound::Mix(m) = d {
                fix(&mut m.mix);
            }
        }
        changed
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
        for e in SOUND_EVENTS {
            if !self.sound.per_event.contains_key(e) {
                if let Some(d) = defaults.per_event.get(e) {
                    self.sound.per_event.insert(e.to_owned(), d.clone());
                }
            }
            if !self.sound.mix.contains_key(e) {
                if let Some(d) = defaults.mix.get(e) {
                    self.sound.mix.insert(e.to_owned(), d.clone());
                }
            }
        }
        let check_mix = |m: &BTreeMap<String, Pick>| -> Result<(), PrefsError> {
            for (e, p) in m {
                if !SOUND_EVENTS.contains(&e.as_str()) {
                    return Err(PrefsError(format!("unknown sound event {e:?}")));
                }
                if !p.valid() {
                    return Err(PrefsError(format!(
                        "bad sound id or gain (0 to 1.5) for {e:?}"
                    )));
                }
            }
            Ok(())
        };
        check_mix(&self.sound.mix)?;
        for d in self.sound.per_dm.values() {
            if let DmSound::Mix(m) = d {
                check_mix(&m.mix)?;
                if m.pack.as_deref().is_some_and(|p| !valid_sound_id(p)) {
                    return Err(PrefsError("bad pack id in a DM sound".into()));
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
        if !BASES.contains(&self.base.as_str()) {
            return Err(PrefsError(format!("unknown base {:?}", self.base)));
        }
        if self.cable_preset.trim().is_empty() {
            return Err(PrefsError("cablePreset must not be empty".into()));
        }
        self.sidebar_width = self.sidebar_width.clamp(SIDEBAR_MIN, SIDEBAR_MAX);
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
        assert_eq!(v["base"], "homeroom");
        assert_eq!(v["cablePreset"], "theme");
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
        assert_eq!(p.sound.per_event.len(), 8);
        assert_eq!(p.sound.mix.len(), 8);
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
            json!({"base":"neon"}),
            json!({"cablePreset":""}),
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
    fn prefs_stored_before_base_and_cable_preset_load_with_defaults() {
        // A P3-era blob: no `base`, no `cablePreset`. Everything else must survive.
        let old = r#"{"themeId":"mine","mode":"dark","customThemes":[{"id":"mine"}],
            "sound":{"enabled":true,"volume":0.4,"perEvent":{},"perDm":{},"hookPolicy":{}},
            "searchAllSessions":true}"#;
        let p = Prefs::from_stored(old);
        assert_eq!(p.theme_id, "mine");
        assert_eq!(p.mode, Mode::Dark);
        assert_eq!(p.base, "homeroom");
        assert_eq!(p.cable_preset, "theme");
        assert!(p.search_all_sessions);
        assert_eq!(p.custom_themes.len(), 1);
        assert!((p.sound.volume - 0.4).abs() < 1e-9);
        let p = p
            .patched(&json!({"base":"patchbay","cablePreset":"copper"}))
            .unwrap();
        assert_eq!(
            (p.base.as_str(), p.cable_preset.as_str()),
            ("patchbay", "copper")
        );
    }

    #[test]
    fn p3_prefs_load_as_patch_tones_with_all_eight_events() {
        let old = r#"{"sound":{"enabled":true,"volume":0.4,
            "perEvent":{"needs":{"on":true,"sound":"needs"},"done":{"on":false,"sound":"done"}},
            "perDm":{"a":"mute","b":"default"},"hookPolicy":{}}}"#;
        let p = Prefs::from_stored(old);
        assert_eq!(p.sound.per_event.len(), 8);
        assert!(!p.sound.per_event["done"].on, "stored choices survive");
        for e in SOUND_EVENTS {
            assert_eq!(p.sound.mix[e], Pick::pack("patchtones"), "{e}");
        }
        assert_eq!(p.sound.per_dm["a"], DmSound::Mute);
        assert_eq!(p.sound.per_dm["b"], DmSound::Default);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["sound"]["perDm"], json!({"a":"mute","b":"default"}));
        assert_eq!(v["sound"]["mix"]["done"], json!({"pack":"patchtones"}));
    }

    #[test]
    fn mix_and_per_dm_overrides_round_trip() {
        let p = Prefs::default()
            .patched(&json!({"sound":{"mix":{
                "done":{"pack":"lab-glass"},"error":{"custom":"01J0000000000000000000000A"},
                "bell":"off"},
              "perDm":{"x":{"pack":"telegraph","mix":{"needs":"off","done":{"pack":"modular"}}},
                       "y":"mute"}}}))
            .unwrap();
        assert_eq!(p.sound.mix["done"], Pick::pack("lab-glass"));
        assert_eq!(p.sound.mix["bell"], Pick::Off);
        assert_eq!(p.sound.mix["needs"], Pick::pack("patchtones"));
        let DmSound::Mix(m) = &p.sound.per_dm["x"] else {
            panic!("override expected");
        };
        assert_eq!(m.pack.as_deref(), Some("telegraph"));
        assert_eq!(m.mix["needs"], Pick::Off);
        assert_eq!(p.sound.per_dm["y"], DmSound::Mute);
        let back = Prefs::from_stored(&serde_json::to_string(&p).unwrap());
        assert_eq!(back, p);
        assert_eq!(p.custom_sound_ids().len(), 1);
    }

    #[test]
    fn gain_round_trips_defaults_to_one_and_is_validated() {
        let id = "01J0000000000000000000000A";
        let p = Prefs::default()
            .patched(&json!({"sound":{"mix":{
                "done":{"pack":"lab-glass","gain":0.5},
                "bell":{"custom":id,"gain":1.5},
                "error":{"pack":"cartridge","gain":0}},
              "perDm":{"x":{"mix":{"needs":{"pack":"modular","gain":1.2},
                                   "done":{"custom":id,"gain":0.25}}}}}}))
            .unwrap();
        assert!((p.sound.mix["done"].gain() - 0.5).abs() < 1e-9);
        assert!((p.sound.mix["bell"].gain() - 1.5).abs() < 1e-9);
        assert!(p.sound.mix["error"].gain().abs() < 1e-9);
        assert!((p.sound.mix["needs"].gain() - 1.0).abs() < 1e-9, "default");
        let DmSound::Mix(m) = &p.sound.per_dm["x"] else {
            panic!("override expected");
        };
        assert!((m.mix["needs"].gain() - 1.2).abs() < 1e-9);
        assert!((m.mix["done"].gain() - 0.25).abs() < 1e-9);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v["sound"]["mix"]["done"],
            json!({"pack":"lab-glass","gain":0.5})
        );
        assert_eq!(v["sound"]["mix"]["needs"], json!({"pack":"patchtones"}));
        assert_eq!(v["sound"]["perDm"]["x"]["mix"]["done"]["gain"], json!(0.25));
        assert_eq!(Prefs::from_stored(&serde_json::to_string(&p).unwrap()), p);
        for bad in [
            json!({"sound":{"mix":{"done":{"pack":"lab-glass","gain":1.6}}}}),
            json!({"sound":{"mix":{"done":{"pack":"lab-glass","gain":-0.1}}}}),
            json!({"sound":{"mix":{"done":{"custom":id,"gain":"loud"}}}}),
            json!({"sound":{"perDm":{"x":{"mix":{"done":{"pack":"a","gain":2}}}}}}),
        ] {
            assert!(Prefs::default().patched(&bad).is_err(), "{bad}");
        }
        // Gain survives a custom sound being dropped only as the default pack sound.
        let mut p = p;
        assert!(p.drop_custom_sound(id));
        assert_eq!(p.sound.mix["bell"], Pick::pack("patchtones"));
    }

    #[test]
    fn bad_mixes_are_refused() {
        let base = Prefs::default();
        for bad in [
            json!({"sound":{"mix":{"nope":"off"}}}),
            json!({"sound":{"mix":{"done":"loud"}}}),
            json!({"sound":{"mix":{"done":{"pack":"../x"}}}}),
            json!({"sound":{"mix":{"done":{"custom":""}}}}),
            json!({"sound":{"perDm":{"a":"loud"}}}),
            json!({"sound":{"perDm":{"a":{"pack":"a/b"}}}}),
            json!({"sound":{"perDm":{"a":{"mix":{"zzz":"off"}}}}}),
        ] {
            assert!(base.patched(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn session_starts_off_only_with_a_session_start_hook_and_message_is_off() {
        let none = Prefs::from_stored_with("{}", false);
        assert!(none.sound.per_event["session"].on);
        assert!(!none.sound.per_event["message"].on);
        let hooked = Prefs::from_stored_with("{}", true);
        assert!(!hooked.sound.per_event["session"].on);
        // A stored session row is the user's choice and is never overridden.
        let mine = r#"{"sound":{"perEvent":{"session":{"on":true,"sound":"session"}}}}"#;
        assert!(Prefs::from_stored_with(mine, true).sound.per_event["session"].on);
        let mut p = Prefs::default();
        p.apply_session_default(true);
        assert!(!p.sound.per_event["session"].on);
    }

    #[test]
    fn dropping_a_custom_sound_falls_back_to_patch_tones() {
        let id = "01J0000000000000000000000A";
        let mut p = Prefs::default()
            .patched(&json!({"sound":{"mix":{"done":{"custom":id}},
              "perDm":{"x":{"mix":{"needs":{"custom":id}}}}}}))
            .unwrap();
        assert!(p.drop_custom_sound(id));
        assert_eq!(p.sound.mix["done"], Pick::pack("patchtones"));
        assert!(p.custom_sound_ids().is_empty());
        assert!(!p.drop_custom_sound(id));
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

    #[test]
    fn sidebar_width_defaults_persists_and_clamps() {
        assert_eq!(Prefs::default().sidebar_width, 264);
        // A blob stored before the setting existed loads with the default.
        let old = Prefs::from_stored(r#"{"themeId":"mine"}"#);
        assert_eq!(old.sidebar_width, 264);
        let p = Prefs::default()
            .patched(&json!({"sidebarWidth": 300}))
            .unwrap();
        assert_eq!(p.sidebar_width, 300);
        let again = Prefs::from_stored(&serde_json::to_string(&p).unwrap());
        assert_eq!(again.sidebar_width, 300);
        let lo = Prefs::default()
            .patched(&json!({"sidebarWidth": 10}))
            .unwrap();
        assert_eq!(lo.sidebar_width, 220);
        let hi = Prefs::default()
            .patched(&json!({"sidebarWidth": 9000}))
            .unwrap();
        assert_eq!(hi.sidebar_width, 420);
        assert!(Prefs::default()
            .patched(&json!({"sidebarWidth": "wide"}))
            .is_err());
    }
}
