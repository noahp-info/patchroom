//! Tauri commands: the IPC contract with the frontend.
//!
//! Every command is `async` so it runs on the async runtime, not the main
//! thread. Calls that can block (spawning, killing) go through
//! `spawn_blocking`. Writes only enqueue, so they are cheap and ordered.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::manager::{CreateRequest, SectionInfo, SessionInfo, SessionManager};

type CmdResult<T> = std::result::Result<T, String>;

/// Result of `session_create` and `section_create`.
#[derive(Serialize)]
pub struct Created {
    id: String,
}

async fn blocking<T, F>(f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> crate::manager::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// `session_create {cwd, command?, args?, name?, cols?, rows?} -> {id}`.
#[tauri::command]
pub async fn session_create(
    state: State<'_, SessionManager>,
    cwd: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    name: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> CmdResult<Created> {
    let m = state.inner().clone();
    let req = CreateRequest {
        cwd,
        command,
        args,
        name,
        cols,
        rows,
    };
    let id = blocking(move || m.create(&req)).await?;
    Ok(Created { id })
}

/// `session_write {id, data}`: `data` is base64.
#[tauri::command]
pub async fn session_write(
    state: State<'_, SessionManager>,
    id: String,
    data: String,
) -> CmdResult<()> {
    let bytes = B64.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    state.write(&id, bytes).map_err(|e| e.to_string())
}

/// `session_send_text {id, text}`.
#[tauri::command]
pub async fn session_send_text(
    state: State<'_, SessionManager>,
    id: String,
    text: String,
) -> CmdResult<()> {
    state.send_text(&id, text).map_err(|e| e.to_string())
}

/// `session_resize {id, cols, rows}`.
#[tauri::command]
pub async fn session_resize(
    state: State<'_, SessionManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    state.resize(&id, cols, rows).map_err(|e| e.to_string())
}

/// `session_kill {id}`.
#[tauri::command]
pub async fn session_kill(state: State<'_, SessionManager>, id: String) -> CmdResult<()> {
    let m = state.inner().clone();
    blocking(move || m.kill(&id)).await
}

/// `session_list -> [{id, name, cwd, title, status, ...}]`.
#[tauri::command]
pub async fn session_list(state: State<'_, SessionManager>) -> CmdResult<Vec<SessionInfo>> {
    let m = state.inner().clone();
    blocking(move || m.list()).await
}

/// `session_resume {id, cols?, rows?}`: restart an exited DM.
/// Claude DMs run `claude --resume <stored session id>`.
#[tauri::command]
pub async fn session_resume(
    state: State<'_, SessionManager>,
    id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> CmdResult<()> {
    let m = state.inner().clone();
    blocking(move || m.resume(&id, cols, rows)).await
}

/// `session_rename {id, name}`.
#[tauri::command]
pub async fn session_rename(
    state: State<'_, SessionManager>,
    id: String,
    name: String,
) -> CmdResult<()> {
    state.rename(&id, &name).map_err(|e| e.to_string())
}

/// `session_delete {id}`: kill and forget the DM.
#[tauri::command]
pub async fn session_delete(state: State<'_, SessionManager>, id: String) -> CmdResult<()> {
    let m = state.inner().clone();
    blocking(move || m.delete(&id)).await
}

/// `session_set_section {id, section_id?}`.
#[tauri::command]
pub async fn session_set_section(
    state: State<'_, SessionManager>,
    id: String,
    section_id: Option<String>,
) -> CmdResult<()> {
    state
        .set_section(&id, section_id.as_deref())
        .map_err(|e| e.to_string())
}

/// `section_list -> [{id, name, position, collapsed}]`.
#[tauri::command]
pub async fn section_list(state: State<'_, SessionManager>) -> CmdResult<Vec<SectionInfo>> {
    state.sections().map_err(|e| e.to_string())
}

/// `section_create {name} -> {id}`.
#[tauri::command]
pub async fn section_create(state: State<'_, SessionManager>, name: String) -> CmdResult<Created> {
    let id = state.create_section(&name).map_err(|e| e.to_string())?;
    Ok(Created { id })
}

/// `section_set_collapsed {id, collapsed}`.
#[tauri::command]
pub async fn section_set_collapsed(
    state: State<'_, SessionManager>,
    id: String,
    collapsed: bool,
) -> CmdResult<()> {
    state
        .set_section_collapsed(&id, collapsed)
        .map_err(|e| e.to_string())
}

/// `pick_folder {default_path?} -> string | null`: native folder picker for
/// the New DM action.
#[tauri::command]
pub async fn pick_folder(
    app: AppHandle,
    default_path: Option<String>,
) -> CmdResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        if let Some(p) = default_path.filter(|p| std::path::Path::new(p).is_dir()) {
            dialog = dialog.set_directory(p);
        }
        dialog
            .blocking_pick_folder()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())
}
