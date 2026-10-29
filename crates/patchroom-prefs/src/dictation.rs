//! Dictation preferences (Settings > Dictation).

use serde::{Deserialize, Serialize};

use crate::prefs::PrefsError;

/// Shortcuts the composer offers for dictation. None clash with the app's bindings, and Fn Fn
/// stays macOS system dictation.
pub const SHORTCUTS: [&str; 4] = ["cmd-shift-d", "ctrl-cmd-d", "cmd-shift-period", "off"];

/// Shortest and longest silence timeout, in seconds.
pub const SILENCE_MIN: u32 = 2;
/// See [`SILENCE_MIN`].
pub const SILENCE_MAX: u32 = 60;

/// On-device dictation in the composer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DictationPrefs {
    /// Show the mic button and take the shortcut. On by default; nothing records until the
    /// button or the shortcut is pressed.
    pub enabled: bool,
    /// Locale id, or empty for the system language.
    pub locale: String,
    /// One of [`SHORTCUTS`].
    pub shortcut: String,
    /// Stop after this many seconds with no new words.
    pub silence_secs: u32,
}

impl Default for DictationPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            locale: String::new(),
            shortcut: SHORTCUTS[0].into(),
            silence_secs: 8,
        }
    }
}

impl DictationPrefs {
    /// Check the locale and shortcut, and clamp the timeout.
    ///
    /// # Errors
    /// The locale or the shortcut is not one Patchroom accepts.
    pub fn validate(&mut self) -> Result<(), PrefsError> {
        if self.locale.len() > 35
            || !self
                .locale
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(PrefsError("bad dictation locale".into()));
        }
        if !SHORTCUTS.contains(&self.shortcut.as_str()) {
            return Err(PrefsError(format!(
                "unknown dictation shortcut {:?}",
                self.shortcut
            )));
        }
        self.silence_secs = self.silence_secs.clamp(SILENCE_MIN, SILENCE_MAX);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Prefs;
    use serde_json::json;

    #[test]
    fn dictation_defaults_on_with_the_system_language() {
        let p = Prefs::from_stored(r#"{"themeId":"x"}"#);
        assert!(p.dictation.enabled);
        assert_eq!(p.dictation.locale, "");
        assert_eq!(p.dictation.shortcut, "cmd-shift-d");
        assert_eq!(p.dictation.silence_secs, 8);
    }

    #[test]
    fn dictation_patches_validate_and_clamp() {
        let p = Prefs::default()
            .patched(&json!({"dictation": {"enabled": false, "locale": "fr-FR",
                "shortcut": "ctrl-cmd-d", "silenceSecs": 500}}))
            .unwrap();
        assert!(!p.dictation.enabled);
        assert_eq!(p.dictation.locale, "fr-FR");
        assert_eq!(p.dictation.silence_secs, 60);
        let p = Prefs::default()
            .patched(&json!({"dictation": {"silenceSecs": 0}}))
            .unwrap();
        assert_eq!(p.dictation.silence_secs, 2);
        assert!(p.dictation.enabled, "a partial group fills from defaults");
        for bad in [
            json!({"dictation": {"shortcut": "fn-fn"}}),
            json!({"dictation": {"locale": "en; rm -rf ~"}}),
            json!({"dictation": {"silenceSecs": "long"}}),
        ] {
            assert!(Prefs::default().patched(&bad).is_err(), "{bad}");
        }
    }
}
