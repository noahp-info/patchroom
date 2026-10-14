//! Tauri app shell: window setup, the IPC commands and the quit path. The
//! session logic lives in [`manager`].
//!
//! # Hook binary
//! `patchroom-hook` is bundled as a Tauri sidecar (see `build.rs` and
//! [`hook_path`]). It is resolved at runtime next to the app executable in
//! dev, in the debug build and inside the `.app`. `PATCHROOM_HOOK_BIN`
//! overrides it.
//!
//! # Data
//! The store (`patchroom.db`) and the bridge socket (`bridge.sock`, mode 0600)
//! live in the Tauri app data dir. `PATCHROOM_DATA_DIR` overrides it for
//! scripted checks.
//!
//! # Chat layer
//! Claude DMs also get a chat view built from the session transcript
//! (`patchroom-claude`). Commands added to the P1b set: `chat_history`, `chat_thread`,
//! `chat_image`, `prompt_answer`, `session_mark_read`, `statusline_cycle_mode`, and the
//! optional `session_view {id, view: "chat"|"terminal"}` hint. Events added:
//! `chat:items`, `prompt:pending`, `prompt:resolved`, `session:badges`,
//! `statusline:update`. See [`manager`] and [`events`] for the payloads.
//!
//! Per launch, claude gets `--settings <file>`: a Patchroom-owned file in the data dir
//! (`bridge.sock.d/<id>.json`) that registers the hooks and the `patchroom-statusline`
//! wrapper. User settings files are never written. The file keeps claude's own command
//! line free of the hook binary's name, so `pgrep -f patchroom-hook` finds hook
//! processes only.
//!
//! # Dev flags (debug builds only)
//! `--e2e-script <path.js> [--e2e-report <dir>]` runs a scenario script in the webview through
//! the runner in `ui/src/e2e/` and writes a report. See [`e2e`]. Release builds compile none of it.
//!
//! # Dev flag
//! In debug builds, `--open-dm <cwd>` opens a DM in `<cwd>` when the frontend
//! first lists sessions. Repeat `--open-dm-arg <arg>` to pass arguments to
//! claude (for example `--open-dm-arg --model --open-dm-arg haiku`).

pub mod agents;
pub mod commands;
#[cfg(debug_assertions)]
pub mod e2e;
pub mod events;
pub mod hook_path;
pub mod manager;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Emitter, Manager as _, RunEvent};

use crate::events::{EventSink, UiEvent};
use crate::manager::{Manager, ManagerConfig, OpenDm};

/// Delivers [`UiEvent`]s to the webview.
struct TauriSink(tauri::AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, event: UiEvent) {
        let _ = self.0.emit(event.name(), event.payload());
    }
}

/// Parse `--open-dm <cwd>` and its `--open-dm-arg <arg>` companions.
#[must_use]
pub fn parse_open_dm<I: IntoIterator<Item = String>>(args: I) -> Option<OpenDm> {
    let mut it = args.into_iter();
    let mut cwd = None;
    let mut extra = Vec::new();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--open-dm" => cwd = it.next(),
            "--open-dm-arg" => extra.extend(it.next()),
            _ => {}
        }
    }
    cwd.map(|cwd| OpenDm { cwd, args: extra })
}

fn data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    match std::env::var("PATCHROOM_DATA_DIR") {
        Ok(p) if !p.is_empty() => Ok(PathBuf::from(p)),
        _ => Ok(app.path().app_data_dir()?),
    }
}

/// The IPC handler. Debug builds add the e2e commands; release builds register none of them.
#[cfg(debug_assertions)]
macro_rules! app_handler {
    () => {
        tauri::generate_handler![
            commands::session_create,
            commands::session_write,
            commands::session_send_text,
            commands::session_resize,
            commands::session_kill,
            commands::session_list,
            commands::session_resume,
            commands::session_rename,
            commands::session_delete,
            commands::session_set_section,
            commands::section_list,
            commands::section_create,
            commands::section_set_collapsed,
            commands::pick_folder,
            commands::chat_history,
            commands::chat_thread,
            commands::chat_image,
            commands::prompt_answer,
            commands::session_mark_read,
            commands::statusline_cycle_mode,
            commands::session_view,
            e2e::e2e_report,
            e2e::e2e_pgrep,
            e2e::e2e_sleep,
            e2e::e2e_param,
            e2e::e2e_quit,
        ]
    };
}
#[cfg(not(debug_assertions))]
macro_rules! app_handler {
    () => {
        tauri::generate_handler![
            commands::session_create,
            commands::session_write,
            commands::session_send_text,
            commands::session_resize,
            commands::session_kill,
            commands::session_list,
            commands::session_resume,
            commands::session_rename,
            commands::session_delete,
            commands::session_set_section,
            commands::section_list,
            commands::section_create,
            commands::section_set_collapsed,
            commands::pick_folder,
            commands::chat_history,
            commands::chat_thread,
            commands::chat_image,
            commands::prompt_answer,
            commands::session_mark_read,
            commands::statusline_cycle_mode,
            commands::session_view,
        ]
    };
}

/// Build and run the Tauri application.
///
/// # Panics
/// Panics if the Tauri runtime fails to start.
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    // Debug builds only: hand the loaded page to the e2e scenario, when one was requested.
    #[cfg(debug_assertions)]
    let builder = builder.on_page_load(|webview, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            e2e::inject(webview);
        }
    });
    let app = builder
        .setup(|app| {
            let mut cfg = ManagerConfig::new(data_dir(app)?, hook_path::resolve_hook_binary());
            cfg.reconcile = true;
            let manager = Manager::new(cfg, Arc::new(TauriSink(app.handle().clone())))?;
            if cfg!(debug_assertions) {
                if let Some(req) = parse_open_dm(std::env::args().skip(1)) {
                    manager.queue_open_dm(req);
                }
            }
            #[cfg(debug_assertions)]
            if let Some(args) = e2e::parse_args(std::env::args().skip(1)) {
                app.manage(e2e::E2eState::new(args)?);
                e2e::start_heartbeat(app.handle().clone());
            }
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(app_handler!())
        .build(tauri::generate_context!())
        .expect("error while building Patchroom");

    app.run(|handle, event| {
        // Quit path: kill every child and hook before the process ends.
        if let RunEvent::Exit = event {
            if let Some(m) = handle.try_state::<Arc<Manager>>() {
                m.shutdown();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn open_dm_flag_parses() {
        assert_eq!(parse_open_dm(v(&[])), None);
        let r = parse_open_dm(v(&[
            "--open-dm",
            "/tmp/x",
            "--open-dm-arg",
            "--model",
            "--open-dm-arg",
            "haiku",
        ]));
        assert_eq!(
            r,
            Some(OpenDm {
                cwd: "/tmp/x".into(),
                args: v(&["--model", "haiku"])
            })
        );
    }
}
