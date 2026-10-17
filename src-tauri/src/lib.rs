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
//! # Sound packs
//! The `plugins/sounds` tree ships as the `sounds` Tauri resource (`generated-packs.json` plus one
//! folder per CC0 file pack). Commands: `sound_packs`, `sound_file {packId, event}`,
//! `sound_import_file {path}`, `sound_custom_list`, `sound_custom_file {id}`,
//! `sound_custom_remove {id}`, `sound_claude_profiles`, `sound_import_claude_profile {id}`.
//! `sound_import_file` and `sound_custom_list` rows carry `norm`, and `sound_packs` rows of file
//! packs carry `norm` per event: the normalizing gain measured on import (mean -22 dBFS, peak at
//! most -3 dBFS). `sound.mix` picks carry an optional `gain` (0 to 1.5, default 1).
//! Custom files live in `<data dir>/sounds/<ULID>.<ext>` (0600) and are pruned at start-up when no
//! prefs reference them; imported Claude profiles become packs under `<data dir>/sounds/packs/`.
//! The Claude sound folder is only ever read. See [`manager`] (`sound` module) and
//! `patchroom-sounds`. `PATCHROOM_SOUNDS_DIR` overrides the bundled folder.
//!
//! # Folder sections (P3 addendum)
//! Commands: `section_create_from_folder`, `section_set_archive_days`, `folder_sessions`,
//! `folder_session_open`, `folder_session_hide`. Event: `folder:changed {sectionId}`.
//! `SectionInfo` gains `folder` and `archiveDays`; `SessionInfo` gains `folderChip`. A folder
//! section lists the resumable Claude sessions found read only under its folder; opening one
//! creates its DM and runs `claude --resume`. See [`manager`] (`folder` module).
//!
//! # Sidebar organization
//! Command: `section_set_emoji {id, emoji|null}`; `section_create {name, kind?, emoji?}` takes
//! `kind` `section` (default) or `divider` (a rule with an optional label, no DMs).
//! `SectionInfo` gains `kind` and `emoji`; `folder_sessions` rows gain `folderBranch`, the
//! branch checked out in the section's folder (read only), so the UI draws a branch chip only
//! when a session's branch differs.
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
pub mod capture;
pub mod commands;
#[cfg(debug_assertions)]
pub mod e2e;
pub mod events;
pub mod hook_path;
pub mod manager;
pub mod notifier;
pub mod steer;
pub mod viewer;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
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

/// Menu id of the app menu's Settings item.
const SETTINGS_MENU_ID: &str = "settings";
/// Menu id of Edit > Comment on Selection (Cmd+Shift+M).
const COMMENT_MENU_ID: &str = "comment-selection";
/// Menu id of Edit > Screenshot to Steer (Cmd+Shift+2).
const SHOT_MENU_ID: &str = "screenshot-steer";

/// The default menu bar, plus "Settings..." (Cmd+,) under About in the macOS app menu.
fn app_menu<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(handle)?;
    #[cfg(target_os = "macos")]
    if let Some(MenuItemKind::Submenu(app)) = menu.items()?.into_iter().next() {
        let settings = MenuItem::with_id(
            handle,
            SETTINGS_MENU_ID,
            "Settings\u{2026}",
            true,
            Some("CmdOrCtrl+,"),
        )?;
        app.insert_items(&[&PredefinedMenuItem::separator(handle)?, &settings], 1)?;
    }
    // Steering lives in Edit. Menu accelerators fire even while the side-pane viewer has focus,
    // which a page keydown listener never sees.
    let edit = menu.items()?.into_iter().find_map(|i| match i {
        MenuItemKind::Submenu(s) if s.text().is_ok_and(|t| t == "Edit") => Some(s),
        _ => None,
    });
    if let Some(edit) = edit {
        let comment = MenuItem::with_id(
            handle,
            COMMENT_MENU_ID,
            "Comment on Selection",
            true,
            Some("CmdOrCtrl+Shift+M"),
        )?;
        let shot = MenuItem::with_id(
            handle,
            SHOT_MENU_ID,
            "Screenshot to Steer",
            true,
            Some("CmdOrCtrl+Shift+2"),
        )?;
        edit.append_items(&[&PredefinedMenuItem::separator(handle)?, &comment, &shot])?;
    }
    Ok(menu)
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

/// The main window's WebKit data store when `PATCHROOM_DATA_DIR` is set: an id derived from the
/// data dir, so a test or e2e run keeps its own `localStorage` (and the same one across its
/// restarts) and never reads or writes the installed app's. `None` uses the default store.
fn webview_store_id(data_dir_override: Option<&str>) -> Option<[u8; 16]> {
    let raw = data_dir_override.filter(|p| !p.is_empty())?;
    let path = std::fs::canonicalize(raw).unwrap_or_else(|_| PathBuf::from(raw));
    // FNV-1a, 128 bit: stable across builds and platforms, unlike `DefaultHasher`.
    let mut h: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
    for b in path.to_string_lossy().bytes() {
        h ^= u128::from(b);
        h = h.wrapping_mul(0x0000_0000_0100_0000_0000_0000_0000_013b);
    }
    // A well-formed UUID (version and variant bits set), as WKWebsiteDataStore expects.
    Some(
        *uuid::Builder::from_random_bytes(h.to_be_bytes())
            .as_uuid()
            .as_bytes(),
    )
}

/// The side-pane viewer's own WebKit data store: derived from the data dir, so the installed
/// app, each private run and the app's own storage never share claude.ai sign-ins. Sign out
/// clears this store only.
fn viewer_store_id(data_dir: &std::path::Path) -> Option<[u8; 16]> {
    webview_store_id(Some(&format!("{}#viewer", data_dir.display())))
}

/// Opens the main window from its config (`create: false` there, so this is the only one).
/// With `PATCHROOM_DATA_DIR` set the webview gets its own data store (macOS 14+) or data
/// directory (other platforms), so private runs stay out of the installed app's storage.
fn open_main_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(conf) = app.config().app.windows.first() else {
        return Ok(());
    };
    let mut b = tauri::WebviewWindowBuilder::from_config(app.handle(), conf)?;
    let over = std::env::var("PATCHROOM_DATA_DIR").ok();
    if let Some(id) = webview_store_id(over.as_deref()) {
        if cfg!(target_os = "macos") {
            b = b.data_store_identifier(id);
        } else if let Some(dir) = over.as_deref() {
            b = b.data_directory(PathBuf::from(dir).join("webview"));
        }
    }
    b.build()?;
    Ok(())
}

/// The first candidate that holds `generated-packs.json`, the mark of the bundled sounds.
fn first_sounds_dir(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates
        .into_iter()
        .find(|d| d.join("generated-packs.json").is_file())
}

/// Where the bundled sound packs live: `PATCHROOM_SOUNDS_DIR`, the `sounds` Tauri resource,
/// and, in debug builds, the source tree (`plugins/sounds`) as a last resort.
fn sounds_dir(app: &tauri::App) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(p) = std::env::var_os("PATCHROOM_SOUNDS_DIR").filter(|p| !p.is_empty()) {
        candidates.push(PathBuf::from(p));
    }
    if let Ok(p) = app
        .path()
        .resolve("sounds", tauri::path::BaseDirectory::Resource)
    {
        candidates.push(p);
    }
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/sounds"));
    }
    first_sounds_dir(candidates)
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
            commands::section_set_emoji,
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
            commands::session_mirror_reveal,
            commands::session_mirror_end,
            commands::link_open_external,
            commands::viewer_show,
            commands::viewer_place,
            commands::viewer_hide,
            commands::viewer_go,
            commands::sound_packs,
            commands::sound_file,
            commands::sound_import_file,
            commands::sound_custom_list,
            commands::sound_custom_file,
            commands::sound_custom_remove,
            commands::sound_claude_profiles,
            commands::sound_import_claude_profile,
            steer::shot_begin,
            steer::shot_commit,
            steer::shot_cancel,
            steer::viewer_snapshot,
            steer::viewer_reveal,
            steer::viewer_selection,
            steer::viewer_find,
            steer::viewer_sign_out,
            e2e::e2e_report,
            e2e::e2e_pgrep,
            e2e::e2e_sleep,
            e2e::e2e_param,
            e2e::e2e_quit,
            e2e::e2e_restart,
            e2e::e2e_decision_log,
            e2e::e2e_needs_trace,
            e2e::e2e_screen_text,
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
            commands::section_set_emoji,
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
            commands::session_mirror_reveal,
            commands::session_mirror_end,
            commands::link_open_external,
            commands::viewer_show,
            commands::viewer_place,
            commands::viewer_hide,
            commands::viewer_go,
            commands::sound_packs,
            commands::sound_file,
            commands::sound_import_file,
            commands::sound_custom_list,
            commands::sound_custom_file,
            commands::sound_custom_remove,
            commands::sound_claude_profiles,
            commands::sound_import_claude_profile,
            steer::shot_begin,
            steer::shot_commit,
            steer::shot_cancel,
            steer::viewer_snapshot,
            steer::viewer_reveal,
            steer::viewer_selection,
            steer::viewer_find,
            steer::viewer_sign_out,
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
        .menu(app_menu)
        .on_menu_event(|handle, event| {
            if event.id() == SETTINGS_MENU_ID {
                TauriSink(handle.clone()).emit(UiEvent::OpenSettings);
            } else if event.id() == COMMENT_MENU_ID {
                let _ = handle.emit("menu:comment", ());
            } else if event.id() == SHOT_MENU_ID {
                let _ = handle.emit("menu:screenshot", ());
            }
        })
        .setup(|app| {
            let mut cfg = ManagerConfig::new(data_dir(app)?, hook_path::resolve_hook_binary());
            cfg.reconcile = true;
            cfg.sounds_dir = sounds_dir(app);
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
            app.manage(steer::ShotState::default());
            app.manage(viewer::ViewerShared::new(viewer_store_id(&data_dir(app)?)));
            open_main_window(app)?;
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
        const P3: [&str; 34] = [
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
            "section_set_emoji",
            "sound_packs",
            "sound_file",
            "sound_import_file",
            "sound_custom_list",
            "sound_custom_file",
            "sound_custom_remove",
            "sound_claude_profiles",
            "sound_import_claude_profile",
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
    fn the_bundled_sounds_dir_is_found_by_its_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let empty = tmp.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/sounds");
        assert_eq!(
            first_sounds_dir([tmp.path().join("missing"), empty, src.clone()]),
            Some(src)
        );
        assert_eq!(first_sounds_dir([tmp.path().join("missing")]), None);
    }

    #[test]
    fn a_private_data_dir_gets_its_own_stable_webview_store() {
        assert_eq!(webview_store_id(None), None);
        assert_eq!(webview_store_id(Some("")), None);
        let a = webview_store_id(Some("/tmp/pr-e2e-1/s1/data")).unwrap();
        assert_eq!(webview_store_id(Some("/tmp/pr-e2e-1/s1/data")), Some(a));
        assert_ne!(webview_store_id(Some("/tmp/pr-e2e-1/s2/data")), Some(a));
        let u = uuid::Uuid::from_bytes(a);
        assert_eq!(u.get_variant(), uuid::Variant::RFC4122);
    }

    #[test]
    fn the_viewer_store_is_its_own_and_stable() {
        let d = std::path::Path::new("/tmp/pr-e2e-1/s1/data");
        let v = viewer_store_id(d).unwrap();
        assert_eq!(viewer_store_id(d), Some(v));
        assert_ne!(webview_store_id(Some("/tmp/pr-e2e-1/s1/data")), Some(v));
        assert_ne!(viewer_store_id(std::path::Path::new("/tmp/other")), Some(v));
    }

    #[test]
    fn steer_commands_are_in_both_handler_lists() {
        const SRC: &str = include_str!("lib.rs");
        for c in [
            "shot_begin",
            "shot_commit",
            "shot_cancel",
            "viewer_snapshot",
            "viewer_reveal",
            "viewer_selection",
            "viewer_find",
            "viewer_sign_out",
        ] {
            assert_eq!(SRC.matches(&format!("steer::{c},")).count(), 2, "{c}");
        }
    }

    #[test]
    fn the_main_window_is_built_in_setup_not_from_config() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = conf["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["create"], serde_json::json!(false));
        assert!(include_str!("lib.rs").contains("open_main_window(app)?"));
    }

    /// The page CSP must let `<audio>` play the data URLs `sound_file` returns. Without
    /// `media-src ... data:` it falls back to `default-src 'self'`, every file sound is refused,
    /// and the player falls back to the default pack.
    #[test]
    fn the_csp_lets_file_sounds_play_from_data_urls() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        let media = csp
            .split(';')
            .map(str::trim)
            .find(|d| d.starts_with("media-src "))
            .expect("the CSP has a media-src directive");
        assert!(media.split_whitespace().any(|s| s == "data:"), "{media}");
    }

    #[test]
    fn tauri_bundles_the_sounds_tree_as_a_resource() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["bundle"]["resources"]["../plugins/sounds/"],
            serde_json::json!("sounds/")
        );
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
