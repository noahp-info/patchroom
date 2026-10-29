//! Dictation commands: the app side of the on-device speech helper (`patchroom-dictation`).
//!
//! Commands:
//! - `dictation_start {locale?, silenceSecs?} -> {sid}`: spawn the helper for one run. A run
//!   already going is killed first. Permission prompts happen in the helper, on this first
//!   use, never at launch.
//! - `dictation_stop {sid}`: ask the run for its final text, then it exits.
//! - `dictation_locales {} -> {locales, current, speech, mic}`: languages with their
//!   on-device state, and the two permission states, read without asking.
//! - `dictation_open_settings {pane}`: `microphone`, `speech` or `dictation` (Keyboard >
//!   Dictation, where macOS downloads on-device languages). No other URL opens.
//!
//! Event `dictation:event {sid, type, ...}`: the helper's lines (`ready`, `partial`, `final`,
//! `error`) and `ended {reason}` last.
//!
//! Data handling: transcripts travel to the webview in memory only. Nothing here writes them
//! to disk or logs them. The helper is killed on quit (`shutdown`) and also leaves by itself
//! when its stdin closes.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use patchroom_dictation::{
    dictate_args, list_args, settings_url, valid_locale, ErrorCode, HelperEvent, Options, Output,
    Session,
};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager as _, State};

/// File name of the helper next to the app executable.
pub const HELPER_NAME: &str = "patchroom-dictation";

/// Shortest and longest silence timeout accepted, in seconds.
pub const SILENCE_RANGE: (u64, u64) = (2, 60);

/// How long the helper gets after `stop` to send its final text.
const GRACE: Duration = Duration::from_millis(2500);

/// The one dictation run, if any.
#[derive(Default)]
pub struct DictationState {
    current: Mutex<Option<(u64, Session)>>,
    next: AtomicU64,
}

impl DictationState {
    fn take(&self) -> Option<(u64, Session)> {
        self.current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    /// Kill any run at once. The quit path calls this.
    pub fn shutdown(&self) {
        if let Some((_, s)) = self.take() {
            s.kill();
            s.wait(Duration::from_millis(500));
        }
    }
}

/// The helper beside the app executable (`Contents/MacOS/` in the bundle, `target/<profile>/`
/// in dev), or its parent for test binaries. `PATCHROOM_DICTATION_BIN` overrides it.
#[must_use]
pub fn helper_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("PATCHROOM_DICTATION_BIN").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    [dir.join(HELPER_NAME), dir.parent()?.join(HELPER_NAME)]
        .into_iter()
        .find(|p| p.is_file())
}

/// The webview payload for one helper output. Pure, so it is tested without a window.
#[must_use]
pub fn event_payload(sid: u64, out: &Output) -> Value {
    match out {
        Output::Event(e) => {
            let mut v = serde_json::to_value(e).unwrap_or(Value::Null);
            if let Value::Object(m) = &mut v {
                m.insert("sid".into(), json!(sid));
            }
            v
        }
        Output::Ended(reason) => json!({"sid": sid, "type": "ended", "reason": reason}),
    }
}

/// `{sid}` of a started run.
#[derive(Serialize)]
pub struct Started {
    sid: u64,
}

fn missing(app: &AppHandle, sid: u64) {
    let err = HelperEvent::Error {
        code: ErrorCode::HelperMissing,
        message: "Dictation isn't part of this build.".into(),
        locale: String::new(),
        language: String::new(),
    };
    let _ = app.emit("dictation:event", event_payload(sid, &Output::Event(err)));
    let _ = app.emit(
        "dictation:event",
        event_payload(sid, &Output::Ended(patchroom_dictation::EndReason::Error)),
    );
}

/// `dictation_start {locale?, silenceSecs?} -> {sid}`.
#[tauri::command]
pub async fn dictation_start(
    app: AppHandle,
    state: State<'_, DictationState>,
    locale: Option<String>,
    silence_secs: Option<u64>,
) -> Result<Started, String> {
    let locale = locale.unwrap_or_default();
    if !valid_locale(&locale) {
        return Err("bad locale".into());
    }
    if let Some((_, old)) = state.take() {
        old.kill();
    }
    let sid = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let Some(program) = helper_path() else {
        missing(&app, sid);
        return Ok(Started { sid });
    };
    let silence = silence_secs
        .filter(|s| *s > 0)
        .map(|s| Duration::from_secs(s.clamp(SILENCE_RANGE.0, SILENCE_RANGE.1)));
    let handle = app.clone();
    let spawned = tauri::async_runtime::spawn_blocking(move || {
        Session::spawn(
            Options {
                program,
                args: dictate_args(&locale),
                silence,
                grace: GRACE,
            },
            move |out| {
                let _ = handle.emit("dictation:event", event_payload(sid, &out));
                if matches!(out, Output::Ended(_)) {
                    if let Some(st) = handle.try_state::<DictationState>() {
                        let mut cur = st
                            .current
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if cur.as_ref().is_some_and(|(id, _)| *id == sid) {
                            *cur = None;
                        }
                    }
                }
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    match spawned {
        Ok(session) => {
            *state
                .current
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((sid, session));
        }
        Err(_) => missing(&app, sid),
    }
    Ok(Started { sid })
}

/// `dictation_stop {sid}`: the person stopped (button, Esc, blur). Unknown ids are ignored.
#[tauri::command]
pub async fn dictation_stop(state: State<'_, DictationState>, sid: u64) -> Result<(), String> {
    let cur = state
        .current
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((id, s)) = cur.as_ref() {
        if *id == sid {
            s.stop();
        }
    }
    Ok(())
}

/// `dictation_locales {}`: the helper's `--list-locales` answer, or an empty list without it.
#[tauri::command]
pub async fn dictation_locales() -> Result<Value, String> {
    let Some(program) = helper_path() else {
        return Ok(
            json!({"locales": [], "current": "", "speech": "unknown", "mic": "unknown", "available": false}),
        );
    };
    let got = tauri::async_runtime::spawn_blocking(move || {
        patchroom_dictation::query(program, list_args(), Duration::from_secs(5))
    })
    .await
    .map_err(|e| e.to_string())?;
    match got {
        Ok(HelperEvent::Locales {
            locales,
            current,
            speech,
            mic,
        }) => Ok(
            json!({"locales": locales, "current": current, "speech": speech, "mic": mic, "available": true}),
        ),
        _ => Ok(
            json!({"locales": [], "current": "", "speech": "unknown", "mic": "unknown", "available": false}),
        ),
    }
}

/// `dictation_open_settings {pane}`: open the System Settings pane for a dictation problem.
#[tauri::command]
pub async fn dictation_open_settings(pane: String) -> Result<(), String> {
    let url = settings_url(&pane).ok_or("unknown settings pane")?;
    tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .map_err(|e| e.to_string())
            .and_then(|s| {
                if s.success() {
                    Ok(())
                } else {
                    Err("System Settings did not open".into())
                }
            })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use patchroom_dictation::EndReason;

    #[test]
    fn payloads_carry_the_run_id_and_the_helper_fields() {
        let v = event_payload(
            7,
            &Output::Event(HelperEvent::Partial { text: "hi".into() }),
        );
        assert_eq!(v, json!({"sid": 7, "type": "partial", "text": "hi"}));
        let v = event_payload(
            7,
            &Output::Event(HelperEvent::Error {
                code: ErrorCode::OnDeviceUnavailable,
                message: String::new(),
                locale: "fr-FR".into(),
                language: "French (France)".into(),
            }),
        );
        assert_eq!(v["code"], "on_device_unavailable");
        assert_eq!(v["language"], "French (France)");
        let v = event_payload(2, &Output::Ended(EndReason::Silence));
        assert_eq!(v, json!({"sid": 2, "type": "ended", "reason": "silence"}));
    }

    #[test]
    fn the_helper_is_bundled_as_a_sidecar() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let bins = conf["bundle"]["externalBin"].as_array().unwrap();
        assert!(bins.iter().any(|b| b == "binaries/patchroom-dictation"));
    }

    #[test]
    fn the_app_and_the_helper_declare_why_they_listen() {
        for plist in [
            include_str!("../Info.plist"),
            include_str!("../../crates/patchroom-dictation/helper/Info.plist"),
        ] {
            assert!(plist.contains("NSMicrophoneUsageDescription"));
            assert!(plist.contains("NSSpeechRecognitionUsageDescription"));
        }
        assert!(
            include_str!("../Entitlements.plist").contains("com.apple.security.device.audio-input")
        );
        assert!(
            include_str!("../../crates/patchroom-dictation/helper/Entitlements.plist")
                .contains("com.apple.security.device.audio-input")
        );
    }

    #[test]
    fn the_helper_never_uses_server_recognition() {
        let src = include_str!("../../crates/patchroom-dictation/helper/PatchroomDictation.swift");
        assert!(src.contains("requiresOnDeviceRecognition = true"));
        assert!(!src.contains("requiresOnDeviceRecognition = false"));
        // No file writes and no logging of what was heard.
        for banned in [
            "write(toFile",
            "FileManager",
            "NSLog(",
            "print(",
            "os_log",
            "Logger(",
        ] {
            assert!(!src.contains(banned), "{banned}");
        }
    }
}
