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
//! # Slack layer (P3)
//! Commands: `section_rename`, `section_delete`, `section_reorder`, `session_reorder`,
//! `session_set_flags`, `draft_get`, `draft_set`, `mark_add`, `mark_remove`, `mark_list`,
//! `search`, `search_reindex`, `chat_locate`, `activity_list`, `prefs_get`, `prefs_set`,
//! `sound_hooks_detect`, `notify_test`, plus `session_focus {id?}` (the DM on screen, so it does
//! not notify). Events: `notify:fire`, `notify:open {id}` (a native notification was clicked),
//! `prefs:changed`, `activity:changed`, and `session:title` for OSC 0/2. Prefs live in the
//! `setting` table; the search index is `search.db` and the notification decision log is
//! `notify-decisions.log`, both in the data dir. See [`manager`] (`slack` module).
//!
//! # Folder sections (P3 addendum)
//! Commands: `section_create_from_folder`, `section_set_archive_days`, `folder_sessions`,
//! `folder_session_open`, `folder_session_hide`. Event: `folder:changed {sectionId}`.
//! `SectionInfo` gains `folder` and `archiveDays`; `SessionInfo` gains `folderChip`. A folder
//! section lists the resumable Claude sessions found read only under its folder; opening one
//! creates its DM and runs `claude --resume`. See [`manager`] (`folder` module).
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
pub mod notifier;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Emitter, Manager as _, RunEvent};

use crate::events::{EventSink, UiEvent};
use crate::manager::{Manager, ManagerConfig, OpenDm};
use crate::notifier::{TauriNotifier, WindowProbe};

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
            commands::paste_image,
            commands::prompt_list,
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
            commands::section_rename,
            commands::section_delete,
            commands::section_reorder,
            commands::session_reorder,
            commands::session_set_flags,
            commands::draft_get,
            commands::draft_set,
            commands::mark_add,
            commands::mark_remove,
            commands::mark_list,
            commands::search,
            commands::search_reindex,
            commands::chat_locate,
            commands::activity_list,
            commands::prefs_get,
            commands::prefs_set,
            commands::sound_hooks_detect,
            commands::notify_test,
            commands::session_focus,
            commands::section_create_from_folder,
            commands::section_set_archive_days,
            commands::folder_sessions,
            commands::folder_session_open,
            commands::folder_session_hide,
            commands::session_takeover,
            commands::session_mirror_takeover_when_closed,
            e2e::e2e_report,
            e2e::e2e_pgrep,
            e2e::e2e_sleep,
            e2e::e2e_param,
            e2e::e2e_quit,
            e2e::e2e_restart,
            e2e::e2e_decision_log,
            e2e::e2e_outside_session,
            e2e::e2e_outside_done,
            e2e::e2e_outside_stop,
            e2e::e2e_webview_focus,
            e2e::e2e_focus_window,
            e2e::e2e_force_active,
            e2e::e2e_window_state,
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
            commands::paste_image,
            commands::prompt_list,
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
            commands::section_rename,
            commands::section_delete,
            commands::section_reorder,
            commands::session_reorder,
            commands::session_set_flags,
            commands::draft_get,
            commands::draft_set,
            commands::mark_add,
            commands::mark_remove,
            commands::mark_list,
            commands::search,
            commands::search_reindex,
            commands::chat_locate,
            commands::activity_list,
            commands::prefs_get,
            commands::prefs_set,
            commands::sound_hooks_detect,
            commands::notify_test,
            commands::session_focus,
            commands::section_create_from_folder,
            commands::section_set_archive_days,
            commands::folder_sessions,
            commands::folder_session_open,
            commands::folder_session_hide,
            commands::session_takeover,
            commands::session_mirror_takeover_when_closed,
        ]
    };
}

/// Build and run the Tauri application.
///
/// # Panics
/// Panics if the Tauri runtime fails to start.
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());
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
            if cfg!(debug_assertions) {
                if let Some(extra) = std::env::var_os("PATCHROOM_E2E_EXTRA_PROJECTS") {
                    cfg.extra_projects_dirs = std::env::split_paths(&extra).collect();
                }
            }
            let sink: Arc<dyn EventSink> = Arc::new(TauriSink(app.handle().clone()));
            let manager = Manager::new(cfg, Arc::clone(&sink))?;
            manager.set_notifier(TauriNotifier::new(app.handle().clone(), sink));
            manager.set_focus_probe(Arc::new(WindowProbe(app.handle().clone())));
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
            #[cfg(debug_assertions)]
            e2e::stop_outside();
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

    /// Every P3 command of the IPC contract is registered in both handler lists (debug and
    /// release), and the two lists name the same commands apart from the `e2e::` ones.
    #[test]
    fn p3_commands_are_registered_in_both_handler_lists() {
        const SRC: &str = include_str!("lib.rs");
        const P3: [&str; 25] = [
            "section_rename",
            "section_delete",
            "section_reorder",
            "session_reorder",
            "session_set_flags",
            "draft_get",
            "draft_set",
            "mark_add",
            "mark_remove",
            "mark_list",
            "search",
            "search_reindex",
            "chat_locate",
            "activity_list",
            "prefs_get",
            "prefs_set",
            "sound_hooks_detect",
            "notify_test",
            "session_focus",
            "session_view",
            "section_create_from_folder",
            "section_set_archive_days",
            "folder_sessions",
            "folder_session_open",
            "folder_session_hide",
        ];
        let bodies: Vec<&str> = SRC
            .split("generate_handler![\n")
            .skip(1)
            .map(|rest| rest.split(']').next().unwrap_or(""))
            .collect();
        assert_eq!(bodies.len(), 2, "a debug and a release handler list");
        let names = |body: &str| -> Vec<String> {
            body.lines()
                .filter_map(|l| l.trim().strip_prefix("commands::"))
                .map(|l| l.trim_end_matches(',').to_owned())
                .collect()
        };
        let (debug, release) = (names(bodies[0]), names(bodies[1]));
        assert_eq!(debug, release);
        for c in P3 {
            assert!(debug.iter().any(|d| d == c), "{c} is not registered");
        }
        assert!(bodies[0].contains("e2e::e2e_restart") && !bodies[1].contains("e2e::"));
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
