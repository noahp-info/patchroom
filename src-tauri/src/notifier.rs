//! Native notifications and the window focus probe.
//!
//! The notification decision lives in `patchroom-prefs` and the manager. This module only
//! posts what was decided: [`TauriNotifier`] uses `tauri-plugin-notification`, and a click on
//! the notification shows the DM (it focuses the main window and emits `notify:open`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicI32, Ordering};
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

/// The main window's focus and visibility, read from Tauri.
pub struct WindowProbe(pub AppHandle);

impl FocusProbe for WindowProbe {
    fn window_active(&self) -> bool {
        self.0.get_webview_window("main").is_some_and(|w| {
            w.is_focused().unwrap_or(false)
                && w.is_visible().unwrap_or(false)
                && !w.is_minimized().unwrap_or(false)
        })
    }
}
