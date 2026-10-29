//! The helper's wire format: one JSON object per line on its stdout, and one command per line
//! on its stdin.
//!
//! Helper to app (stdout):
//!
//! | `type` | Fields | Meaning |
//! | --- | --- | --- |
//! | `ready` | `locale` | Permissions granted, the microphone is open, recognition runs |
//! | `partial` | `text` | The whole utterance so far. Each one replaces the last |
//! | `final` | `text` | The settled utterance. It replaces the partials |
//! | `error` | `code`, `message`, `locale`, `language` | Dictation cannot start or went wrong |
//! | `end` | | The helper is about to exit |
//! | `locales` | `locales`, `current`, `speech`, `mic` | Answer to `--list-locales` |
//!
//! App to helper (stdin): `stop` ends the audio and asks for the final text. End of input
//! (the app quit or crashed) makes the helper exit at once.

use serde::{Deserialize, Serialize};

/// Longest line accepted from the helper, in bytes. A longer line is refused, not parsed.
pub const MAX_LINE: usize = 256 * 1024;

/// Why dictation could not start or stopped with an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Speech recognition permission was denied in System Settings.
    SpeechDenied,
    /// Speech recognition is restricted on this Mac (a profile or parental control).
    SpeechRestricted,
    /// Microphone permission was denied in System Settings.
    MicDenied,
    /// Microphone use is restricted on this Mac.
    MicRestricted,
    /// The language has no on-device model (not downloaded, or not offered on this Mac).
    /// Patchroom never falls back to server recognition.
    OnDeviceUnavailable,
    /// No input device, or the audio engine would not start.
    Audio,
    /// The recognizer reported an error mid-dictation.
    Recognizer,
    /// The helper binary is missing from this build.
    HelperMissing,
    /// Anything a newer helper reports that this app does not know.
    #[serde(other)]
    Unknown,
}

/// A privacy permission's state, read without asking.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    /// Granted.
    Authorized,
    /// Refused by the person.
    Denied,
    /// Blocked by policy on this Mac.
    Restricted,
    /// Never asked. The first dictation asks.
    #[default]
    NotDetermined,
    /// A state this app does not know.
    #[serde(other)]
    Unknown,
}

/// One language the recognizer offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleInfo {
    /// BCP 47 id, `en-US`.
    pub id: String,
    /// Display name in the person's language, `English (United States)`.
    #[serde(default)]
    pub name: String,
    /// The on-device model is installed and usable now.
    #[serde(default)]
    pub on_device: bool,
}

/// One line from the helper.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HelperEvent {
    /// Listening.
    Ready {
        /// The locale in use.
        #[serde(default)]
        locale: String,
    },
    /// The utterance so far.
    Partial {
        /// Text to show in place of the previous partial.
        text: String,
    },
    /// The settled utterance.
    Final {
        /// Text that replaces the partials.
        text: String,
    },
    /// Dictation failed.
    Error {
        /// What went wrong.
        code: ErrorCode,
        /// A short reason for the person. Never transcript text.
        #[serde(default)]
        message: String,
        /// The locale id asked for.
        #[serde(default)]
        locale: String,
        /// The locale's display name, for "isn't available for <language>".
        #[serde(default)]
        language: String,
    },
    /// The helper exits next.
    End,
    /// The languages on offer and the permission states (`--list-locales`).
    #[serde(rename_all = "camelCase")]
    Locales {
        /// Every supported language.
        locales: Vec<LocaleInfo>,
        /// The system language's id.
        #[serde(default)]
        current: String,
        /// Speech recognition permission.
        #[serde(default)]
        speech: Permission,
        /// Microphone permission.
        #[serde(default)]
        mic: Permission,
    },
}

/// Why a helper line was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Longer than [`MAX_LINE`].
    TooLong(usize),
    /// Not one of the known objects.
    Invalid(String),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLong(n) => write!(f, "helper line of {n} bytes is too long"),
            // The serde message can quote the input; keep only its position, never the text.
            Self::Invalid(_) => f.write_str("helper line is not a known event"),
        }
    }
}

impl std::error::Error for ParseError {}

/// Parse one stdout line. A blank line gives `Ok(None)`.
///
/// # Errors
/// The line is too long or is not a known event.
pub fn parse_line(line: &str) -> Result<Option<HelperEvent>, ParseError> {
    if line.len() > MAX_LINE {
        return Err(ParseError::TooLong(line.len()));
    }
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    serde_json::from_str(line)
        .map(Some)
        .map_err(|e| ParseError::Invalid(format!("line {} column {}", e.line(), e.column())))
}

/// The stdin command that asks the helper to finish.
pub const STOP: &str = "stop\n";

/// Arguments for a dictation run in `locale` (empty: the system language).
#[must_use]
pub fn dictate_args(locale: &str) -> Vec<String> {
    let mut a = vec!["--dictate".to_owned()];
    if valid_locale(locale) && !locale.is_empty() {
        a.push("--locale".to_owned());
        a.push(locale.to_owned());
    }
    a
}

/// Arguments that list the languages and permission states.
#[must_use]
pub fn list_args() -> Vec<String> {
    vec!["--list-locales".to_owned()]
}

/// Is `id` a plausible locale id (letters, digits, `-` and `_`, at most 35 bytes)? Empty is
/// valid and means the system language.
#[must_use]
pub fn valid_locale(id: &str) -> bool {
    id.len() <= 35
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The System Settings pane for a dictation problem. Only these URLs are ever opened.
#[must_use]
pub fn settings_url(pane: &str) -> Option<&'static str> {
    match pane {
        "microphone" => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        }
        "speech" => Some(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
        ),
        // Keyboard > Dictation is where macOS downloads on-device languages.
        "dictation" => Some("x-apple.systempreferences:com.apple.Keyboard-Settings.extension"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_event_parses() {
        assert_eq!(
            parse_line(r#"{"type":"ready","locale":"en-US"}"#).unwrap(),
            Some(HelperEvent::Ready {
                locale: "en-US".into()
            })
        );
        assert_eq!(
            parse_line(r#"{"type":"partial","text":"hello wor"}"#).unwrap(),
            Some(HelperEvent::Partial {
                text: "hello wor".into()
            })
        );
        assert_eq!(
            parse_line("{\"type\":\"final\",\"text\":\"Hello world.\"}\r\n").unwrap(),
            Some(HelperEvent::Final {
                text: "Hello world.".into()
            })
        );
        assert_eq!(
            parse_line(r#"{"type":"end"}"#).unwrap(),
            Some(HelperEvent::End)
        );
        assert_eq!(
            parse_line(
                r#"{"type":"error","code":"on_device_unavailable","locale":"fr-FR","language":"French (France)"}"#
            )
            .unwrap(),
            Some(HelperEvent::Error {
                code: ErrorCode::OnDeviceUnavailable,
                message: String::new(),
                locale: "fr-FR".into(),
                language: "French (France)".into(),
            })
        );
    }

    #[test]
    fn locales_parse_with_permissions() {
        let e = parse_line(
            r#"{"type":"locales","current":"en-US","speech":"denied","mic":"not_determined",
                "locales":[{"id":"en-US","name":"English (United States)","onDevice":true},
                           {"id":"fr-FR","name":"French (France)","onDevice":false}]}"#,
        )
        .unwrap()
        .unwrap();
        let HelperEvent::Locales {
            locales,
            current,
            speech,
            mic,
        } = e
        else {
            panic!("not a locales event");
        };
        assert_eq!(current, "en-US");
        assert_eq!(speech, Permission::Denied);
        assert_eq!(mic, Permission::NotDetermined);
        assert_eq!(locales.len(), 2);
        assert!(locales[0].on_device && !locales[1].on_device);
    }

    #[test]
    fn unknown_codes_and_states_do_not_fail() {
        let e = parse_line(r#"{"type":"error","code":"brand_new"}"#).unwrap();
        assert!(matches!(
            e,
            Some(HelperEvent::Error {
                code: ErrorCode::Unknown,
                ..
            })
        ));
        let e = parse_line(r#"{"type":"locales","locales":[],"speech":"provisional"}"#).unwrap();
        assert!(matches!(
            e,
            Some(HelperEvent::Locales {
                speech: Permission::Unknown,
                ..
            })
        ));
    }

    #[test]
    fn blank_lines_are_skipped() {
        assert_eq!(parse_line("").unwrap(), None);
        assert_eq!(parse_line("   \n").unwrap(), None);
    }

    #[test]
    fn bad_lines_are_refused_without_echoing_them() {
        for bad in [
            "hello",
            "{}",
            r#"{"type":"partial"}"#,
            r#"{"type":"partial","text":5}"#,
            r#"{"type":"shout","text":"x"}"#,
            "[1,2]",
        ] {
            let err = parse_line(bad).unwrap_err();
            assert!(matches!(err, ParseError::Invalid(_)), "{bad}");
        }
        // The message for the person never carries the line (it may hold transcript text).
        let err = parse_line(r#"{"type":"partial","text":"secret words"#).unwrap_err();
        assert!(!err.to_string().contains("secret"));
        assert!(!format!("{err:?}").contains("secret"));
    }

    #[test]
    fn overlong_lines_are_refused_before_parsing() {
        let long = format!(r#"{{"type":"partial","text":"{}"}}"#, "a".repeat(MAX_LINE));
        assert_eq!(parse_line(&long), Err(ParseError::TooLong(long.len())));
    }

    #[test]
    fn args_carry_only_safe_locales() {
        assert_eq!(dictate_args(""), vec!["--dictate"]);
        assert_eq!(
            dictate_args("en-GB"),
            vec!["--dictate", "--locale", "en-GB"]
        );
        assert_eq!(
            dictate_args("zh_Hant_TW"),
            vec!["--dictate", "--locale", "zh_Hant_TW"]
        );
        assert_eq!(dictate_args("en; rm -rf ~"), vec!["--dictate"]);
        assert_eq!(dictate_args(&"a".repeat(36)), vec!["--dictate"]);
        assert_eq!(list_args(), vec!["--list-locales"]);
    }

    #[test]
    fn only_known_settings_panes_open() {
        assert!(settings_url("microphone")
            .unwrap()
            .ends_with("Privacy_Microphone"));
        assert!(settings_url("speech")
            .unwrap()
            .ends_with("Privacy_SpeechRecognition"));
        assert!(settings_url("dictation").unwrap().contains("Keyboard"));
        assert_eq!(settings_url("https://example.com"), None);
        assert_eq!(settings_url(""), None);
    }
}
