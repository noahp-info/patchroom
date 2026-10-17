//! Steering commands: screenshot-to-steer, comment on a viewer selection, the frozen viewer
//! under overlays, and the claude.ai account in the viewer.
//!
//! Contract (all `async`, so none runs on the main thread):
//! - `shot_begin {} -> {dataUrl, width, height}`: capture Patchroom's own window once and keep
//!   it. The UI shows the picture as the drag surface, so the box is drawn on exactly the pixels
//!   that will be cropped. `width`/`height` are CSS pixels.
//! - `shot_commit {id, rect} -> {path, dataUrl}`: crop the kept capture to `rect` (CSS pixels),
//!   save it through the paste-image path (`<data>/pastes/<ulid>.png`, 0600) and drop the
//!   capture. Nothing reaches the session: the UI puts the path in the draft.
//! - `shot_cancel {}`: drop the capture.
//! - `viewer_snapshot {rect} -> dataUrl | null`, `viewer_reveal {rect}`: freeze and restore
//!   the native viewer while an HTML overlay is open.
//! - `viewer_selection {} -> bool`: ask the viewer for its selection; the answer is the
//!   `viewer:selection {text, url}` event.
//! - `viewer_find {text}`: scroll the viewer to `text`.
//! - `viewer_sign_out {} -> "cleared" | "logout"`.
//!
//! Events: `viewer:selection {text, url}`, `viewer:account {service, signedIn, url}`.

use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::capture::{self, Frame};
use crate::manager::SessionManager;
use crate::viewer::{self, Rect};

type CmdResult<T> = std::result::Result<T, String>;

/// The window capture a screenshot is being cut from.
#[derive(Debug, Default)]
pub struct ShotState(Mutex<Option<Frame>>);

/// Result of `shot_begin`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotFrame {
    data_url: String,
    width: f64,
    height: f64,
}

/// Result of `shot_commit`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotSaved {
    path: String,
    data_url: String,
}

async fn off_main<T: Send + 'static>(
    f: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// `shot_begin {}`.
#[tauri::command]
pub async fn shot_begin(app: AppHandle, state: State<'_, ShotState>) -> CmdResult<ShotFrame> {
    let a = app.clone();
    let frame = off_main(move || capture::window_rgba(&a)).await?;
    let png = off_main({
        let f = frame.clone();
        move || capture::encode_png(&f)
    })
    .await?;
    let out = ShotFrame {
        data_url: capture::data_url(&png),
        width: f64::from(frame.width) / frame.scale,
        height: f64::from(frame.height) / frame.scale,
    };
    if let Ok(mut g) = state.0.lock() {
        *g = Some(frame);
    }
    Ok(out)
}

/// `shot_commit {id, rect}`.
#[tauri::command]
pub async fn shot_commit(
    state: State<'_, ShotState>,
    sessions: State<'_, SessionManager>,
    id: String,
    rect: Rect,
) -> CmdResult<ShotSaved> {
    let frame = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("no screenshot is in progress")?;
    let m = sessions.inner().clone();
    off_main(move || {
        let crop = frame.crop(rect).ok_or("the box is empty")?;
        let png = capture::encode_png(&crop)?;
        let path = m
            .paste_image(&id, &B64.encode(&png), "image/png")
            .map_err(|e| e.to_string())?;
        Ok(ShotSaved {
            path,
            data_url: capture::data_url(&png),
        })
    })
    .await
}

/// `shot_cancel {}`.
#[tauri::command]
pub async fn shot_cancel(state: State<'_, ShotState>) -> CmdResult<()> {
    if let Ok(mut g) = state.0.lock() {
        *g = None;
    }
    Ok(())
}

/// `viewer_snapshot {rect}`.
#[tauri::command]
pub async fn viewer_snapshot(app: AppHandle, rect: Rect) -> CmdResult<Option<String>> {
    off_main(move || viewer::snapshot(&app, rect)).await
}

/// `viewer_reveal {rect}`.
#[tauri::command]
pub async fn viewer_reveal(app: AppHandle, rect: Rect) -> CmdResult<()> {
    viewer::reveal(&app, rect)
}

/// `viewer_selection {}`.
#[tauri::command]
pub async fn viewer_selection(app: AppHandle) -> CmdResult<bool> {
    viewer::request_selection(&app)
}

/// `viewer_find {text}`.
#[tauri::command]
pub async fn viewer_find(app: AppHandle, text: String) -> CmdResult<()> {
    viewer::find_text(&app, &text)
}

/// `viewer_sign_out {}`.
#[tauri::command]
pub async fn viewer_sign_out(app: AppHandle) -> CmdResult<String> {
    viewer::sign_out(&app).map(str::to_owned)
}
