//! Native notifications and the window focus probe.
//!
//! The notification decision lives in `patchroom-prefs` and the manager. This module only
//! posts what was decided: [`TauriNotifier`] uses `tauri-plugin-notification`, and a click on
//! the notification shows the DM (it focuses the main window and emits `notify:open`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicI32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use tauri::{AppHandle, Manager as _};
use tauri_plugin_notification::NotificationExt;

use crate::events::{EventSink, UiEvent};

/// Posts a native notification for a DM.
pub trait Notifier: Send + Sync + 'static {
    /// Show `title` and `body`. `dm` is the DM a click opens (empty for the test notification).
    fn post(&self, dm: &str, title: &str, body: &str);
}

/// Says whether the user can see the app right now.
pub trait FocusProbe: Send + Sync + 'static {
    /// The main window is focused and visible.
    fn window_active(&self) -> bool;
}

/// Native notifications through the Tauri notification plugin.
pub struct TauriNotifier {
    app: AppHandle,
    next: AtomicI32,
    /// Notification id to DM id, for click handling.
    posted: Arc<Mutex<HashMap<i32, String>>>,
}

impl TauriNotifier {
    /// Create the notifier and register the click handler. Clicking a notification focuses
    /// the main window and emits `notify:open {id}` through `sink`.
    pub fn new(app: AppHandle, sink: Arc<dyn EventSink>) -> Arc<Self> {
        let posted: Arc<Mutex<HashMap<i32, String>>> = Arc::default();
        let map = Arc::clone(&posted);
        let handle = app.clone();
        let registered = app.notification().on_action(move |performed| {
            if performed.action_id() != "tap" {
                return;
            }
            let Some(n) = performed.notification() else {
                return;
            };
            let dm = map
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&n.id())
                .cloned();
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(id) = dm.filter(|d| !d.is_empty()) {
                sink.emit(UiEvent::NotifyOpen { id });
            }
        });
        if let Err(e) = registered {
            eprintln!("patchroom: notification click handler failed: {e}");
        }
        Arc::new(Self {
            app,
            next: AtomicI32::new(1),
            posted,
        })
    }
}

impl Notifier for TauriNotifier {
    fn post(&self, dm: &str, title: &str, body: &str) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        {
            let mut posted = self.posted.lock().unwrap_or_else(PoisonError::into_inner);
            // Keep the click map bounded; old notifications are long gone from the screen.
            if posted.len() > 256 {
                posted.clear();
            }
            posted.insert(id, dm.to_owned());
        }
        let shown = self
            .app
            .notification()
            .builder()
            .id(id)
            .title(title)
            .body(body)
            .show();
        if let Err(e) = shown {
            eprintln!("patchroom: native notification failed: {e}");
        }
    }
}

/// Longest a webview focus report is believed, in milliseconds. The e2e heartbeat reports
/// every 250 ms; a stale report counts as no report.
const WEBVIEW_REPORT_TTL_MS: u64 = 2_000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// What the webview says about itself (`document.hasFocus()`), plus a forced answer for tests.
///
/// A window driven by a script is often not the key window: `is_focused` is false while the
/// page has focus and is on screen. The probe therefore also believes a fresh webview report.
/// Only debug e2e runs set either value; a release build has no command that writes them.
#[derive(Default)]
pub struct ActivityHints {
    /// 0 none, 1 focused, 2 blurred.
    webview: AtomicU8,
    reported_at: AtomicU64,
    /// 0 none, 1 force active, 2 force inactive.
    forced: AtomicU8,
}

impl ActivityHints {
    /// Record `document.hasFocus()` as the webview reports it.
    pub fn report_webview(&self, focused: bool) {
        self.webview
            .store(if focused { 1 } else { 2 }, Ordering::SeqCst);
        self.reported_at.store(now_ms(), Ordering::SeqCst);
    }

    /// Pin the answer (`Some`) or go back to the real window state (`None`).
    pub fn force(&self, active: Option<bool>) {
        let v = match active {
            None => 0,
            Some(true) => 1,
            Some(false) => 2,
        };
        self.forced.store(v, Ordering::SeqCst);
    }

    fn forced(&self) -> Option<bool> {
        match self.forced.load(Ordering::SeqCst) {
            1 => Some(true),
            2 => Some(false),
            _ => None,
        }
    }

    /// The forced answer as JSON-friendly text: `true`, `false` or null.
    #[must_use]
    pub fn forced_state(&self) -> Option<bool> {
        self.forced()
    }

    /// Does a fresh webview report say the page has focus?
    #[must_use]
    pub fn webview_focused(&self) -> bool {
        self.webview.load(Ordering::SeqCst) == 1
            && now_ms().saturating_sub(self.reported_at.load(Ordering::SeqCst))
                < WEBVIEW_REPORT_TTL_MS
    }
}

/// The shared hints, written by the e2e commands and read by [`WindowProbe`].
pub fn hints() -> &'static ActivityHints {
    static HINTS: std::sync::OnceLock<ActivityHints> = std::sync::OnceLock::new();
    HINTS.get_or_init(ActivityHints::default)
}

/// Is the app on screen and being looked at? Focus is the native key window or a fresh webview
/// focus report; the window must also be visible and not minimized.
#[must_use]
pub fn active_from(
    native_focused: bool,
    webview_focused: bool,
    visible: bool,
    minimized: bool,
) -> bool {
    (native_focused || webview_focused) && visible && !minimized
}

/// The main window's focus and visibility, read from Tauri and the webview's own report.
pub struct WindowProbe(pub AppHandle);

impl FocusProbe for WindowProbe {
    fn window_active(&self) -> bool {
        if let Some(f) = hints().forced() {
            return f;
        }
        self.0.get_webview_window("main").is_some_and(|w| {
            active_from(
                w.is_focused().unwrap_or(false),
                hints().webview_focused(),
                w.is_visible().unwrap_or(false),
                w.is_minimized().unwrap_or(false),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_needs_focus_from_either_source_and_a_visible_window() {
        assert!(active_from(true, false, true, false));
        assert!(active_from(false, true, true, false));
        assert!(!active_from(false, false, true, false));
        assert!(!active_from(true, true, false, false));
        assert!(!active_from(true, true, true, true));
    }

    #[test]
    fn hints_report_and_force() {
        let h = ActivityHints::default();
        assert!(!h.webview_focused());
        h.report_webview(true);
        assert!(h.webview_focused());
        h.report_webview(false);
        assert!(!h.webview_focused());
        assert_eq!(h.forced(), None);
        h.force(Some(false));
        assert_eq!(h.forced(), Some(false));
        h.force(None);
        assert_eq!(h.forced(), None);
    }

    #[test]
    fn a_stale_webview_report_is_ignored() {
        let h = ActivityHints::default();
        h.report_webview(true);
        h.reported_at
            .store(now_ms() - WEBVIEW_REPORT_TTL_MS - 1, Ordering::SeqCst);
        assert!(!h.webview_focused());
    }
}
