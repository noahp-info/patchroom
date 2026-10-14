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

use crate::manager::{
    ActivityRow, CreateRequest, ImageData, Located, MarkInfo, PromptAnswer, Reindexed, SectionInfo,
    SessionInfo, SessionManager,
};
use patchroom_claude::{ChatItem, Cursor, Page};
use patchroom_prefs::{DetectedHook, Prefs};
use patchroom_search::SearchResult;
use serde::Deserialize;
use serde_json::Value;

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
    state.inner().write(&id, bytes).map_err(|e| e.to_string())
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

/// `chat_history {id, before?, limit?} -> {items, hasMore, cursor}`: newest page first,
/// oldest first within the page. `before` is the key of the oldest item the caller has, or
/// the `cursor` of the previous page.
#[tauri::command]
pub async fn chat_history(
    state: State<'_, SessionManager>,
    id: String,
    before: Option<Cursor>,
    limit: Option<usize>,
) -> CmdResult<Page> {
    let m = state.inner().clone();
    blocking(move || m.chat_history(&id, before, limit)).await
}

/// `chat_thread {id, toolUseId} -> {items}`: the items of a subagent.
#[tauri::command]
pub async fn chat_thread(
    state: State<'_, SessionManager>,
    id: String,
    tool_use_id: String,
) -> CmdResult<ChatThread> {
    let m = state.inner().clone();
    let items = blocking(move || m.chat_thread(&id, &tool_use_id)).await?;
    Ok(ChatThread { items })
}

/// Result of `chat_thread`.
#[derive(Serialize)]
pub struct ChatThread {
    items: Vec<ChatItem>,
}

/// `chat_image {id, ref} -> {dataUrl}`.
#[tauri::command]
pub async fn chat_image(
    state: State<'_, SessionManager>,
    id: String,
    r#ref: String,
) -> CmdResult<ImageData> {
    let m = state.inner().clone();
    blocking(move || m.chat_image(&id, &r#ref)).await
}

/// `prompt_answer {id, promptId, answer}`. `answer` is
/// `{kind:"allow"} | {kind:"allow_always"} | {kind:"deny", message?} |
/// {kind:"questions", answers:{[questionText]: string}} | {kind:"terminal"}`.
#[tauri::command]
pub async fn prompt_answer(
    state: State<'_, SessionManager>,
    id: String,
    prompt_id: String,
    answer: PromptAnswer,
) -> CmdResult<()> {
    // A plan answer waits for the TUI dialog to draw, so keep it off the async runtime.
    let m = state.inner().clone();
    blocking(move || m.prompt_answer(&id, &prompt_id, answer)).await
}

/// `session_mark_read {id}`: clears the unread count, never the needs-you badge.
#[tauri::command]
pub async fn session_mark_read(state: State<'_, SessionManager>, id: String) -> CmdResult<()> {
    state.mark_read(&id).map_err(|e| e.to_string())
}

/// `prompt_list {id}`: the DM's announced, unresolved prompts as `prompt:pending` payloads.
#[tauri::command]
pub async fn prompt_list(
    state: State<'_, SessionManager>,
    id: String,
) -> CmdResult<Vec<serde_json::Value>> {
    state.prompt_list(&id).map_err(|e| e.to_string())
}

/// `statusline_cycle_mode {id}`: writes Shift+Tab to the PTY.
#[tauri::command]
pub async fn statusline_cycle_mode(state: State<'_, SessionManager>, id: String) -> CmdResult<()> {
    state.inner().cycle_mode(&id).map_err(|e| e.to_string())
}

/// `session_view {id, view}`: `view` is `"chat"` or `"terminal"`. Optional hint: while the
/// terminal is shown, a hidden AskUserQuestion picker is handed to the TUI at once.
#[tauri::command]
pub async fn session_view(
    state: State<'_, SessionManager>,
    id: String,
    view: String,
) -> CmdResult<()> {
    state
        .set_view(&id, view == "terminal")
        .map_err(|e| e.to_string())
}

/// Result of `paste_image`.
#[derive(Serialize)]
pub struct PastedImage {
    path: String,
}

/// `paste_image {id, data, mediaType} -> {path}`: `data` is base64. Writes a 0600 file
/// under `<data_dir>/pastes/` and returns its absolute path. Nothing goes to the PTY.
#[tauri::command]
pub async fn paste_image(
    state: State<'_, SessionManager>,
    id: String,
    data: String,
    media_type: String,
) -> CmdResult<PastedImage> {
    let m = state.inner().clone();
    let path = blocking(move || m.paste_image(&id, &data, &media_type)).await?;
    Ok(PastedImage { path })
}

// ---- P3: the Slack layer ----

/// `section_rename {id, name}`.
#[tauri::command]
pub async fn section_rename(
    state: State<'_, SessionManager>,
    id: String,
    name: String,
) -> CmdResult<()> {
    state.section_rename(&id, &name).map_err(|e| e.to_string())
}

/// `section_delete {id}`: the section's DMs fall back to "Direct messages".
#[tauri::command]
pub async fn section_delete(state: State<'_, SessionManager>, id: String) -> CmdResult<()> {
    state.section_delete(&id).map_err(|e| e.to_string())
}

/// `section_reorder {ids}`: listed sections first in that order, the rest after them.
#[tauri::command]
pub async fn section_reorder(state: State<'_, SessionManager>, ids: Vec<String>) -> CmdResult<()> {
    state.section_reorder(&ids).map_err(|e| e.to_string())
}

/// `session_reorder {sectionId, ids}`: move the DMs into the section (null: unplaced) and
/// order them, in one call.
#[tauri::command]
pub async fn session_reorder(
    state: State<'_, SessionManager>,
    section_id: Option<String>,
    ids: Vec<String>,
) -> CmdResult<()> {
    state
        .session_reorder(section_id.as_deref(), &ids)
        .map_err(|e| e.to_string())
}

/// `session_set_flags {id, starred?, archived?}`.
#[tauri::command]
pub async fn session_set_flags(
    state: State<'_, SessionManager>,
    id: String,
    starred: Option<bool>,
    archived: Option<bool>,
) -> CmdResult<()> {
    state
        .set_flags(&id, starred, archived)
        .map_err(|e| e.to_string())
}

/// Result of `draft_get`.
#[derive(Serialize)]
pub struct DraftBody {
    body: String,
}

/// `draft_get {id} -> {body}`.
#[tauri::command]
pub async fn draft_get(state: State<'_, SessionManager>, id: String) -> CmdResult<DraftBody> {
    let body = state.draft_get(&id).map_err(|e| e.to_string())?;
    Ok(DraftBody { body })
}

/// `draft_set {id, body}`: an empty body deletes the draft.
#[tauri::command]
pub async fn draft_set(
    state: State<'_, SessionManager>,
    id: String,
    body: String,
) -> CmdResult<()> {
    state.draft_set(&id, &body).map_err(|e| e.to_string())
}

/// `mark_add {id, itemKey, kind, emoji?} -> MarkInfo`: pin, save or react. Never reaches the PTY.
#[tauri::command]
pub async fn mark_add(
    state: State<'_, SessionManager>,
    id: String,
    item_key: String,
    kind: String,
    emoji: Option<String>,
) -> CmdResult<MarkInfo> {
    let m = state.inner().clone();
    blocking(move || m.mark_add(&id, &item_key, &kind, emoji.as_deref())).await
}

/// `mark_remove {id, itemKey, kind, emoji?}`.
#[tauri::command]
pub async fn mark_remove(
    state: State<'_, SessionManager>,
    id: String,
    item_key: String,
    kind: String,
    emoji: Option<String>,
) -> CmdResult<()> {
    state
        .mark_remove(&id, &item_key, &kind, emoji.as_deref())
        .map_err(|e| e.to_string())
}

/// `mark_list {id?, kind?} -> MarkInfo[]`: no id lists across DMs.
#[tauri::command]
pub async fn mark_list(
    state: State<'_, SessionManager>,
    id: Option<String>,
    kind: Option<String>,
) -> CmdResult<Vec<MarkInfo>> {
    state
        .mark_list(id.as_deref(), kind.as_deref())
        .map_err(|e| e.to_string())
}

/// The `scope` of `search`.
#[derive(Debug, Default, Deserialize)]
pub struct SearchScope {
    id: Option<String>,
}

/// `search {query, scope?: {id?}, limit?} -> {hits, tookMs}`.
#[tauri::command]
pub async fn search(
    state: State<'_, SessionManager>,
    query: String,
    scope: Option<SearchScope>,
    limit: Option<usize>,
) -> CmdResult<SearchResult> {
    let m = state.inner().clone();
    let scope_id = scope.and_then(|s| s.id);
    blocking(move || m.search(&query, scope_id.as_deref(), limit)).await
}

/// `search_reindex {} -> {docs, tookMs}`.
#[tauri::command]
pub async fn search_reindex(state: State<'_, SessionManager>) -> CmdResult<Reindexed> {
    let m = state.inner().clone();
    blocking(move || m.search_reindex()).await
}

/// `chat_locate {id, itemKey} -> {before}`: a `chat_history` cursor whose page holds the item.
#[tauri::command]
pub async fn chat_locate(
    state: State<'_, SessionManager>,
    id: String,
    item_key: String,
) -> CmdResult<Located> {
    let m = state.inner().clone();
    blocking(move || m.chat_locate(&id, &item_key)).await
}

/// `activity_list {} -> [{id, kind, ts, promptId?, itemKey?, summary}]`, oldest first.
#[tauri::command]
pub async fn activity_list(state: State<'_, SessionManager>) -> CmdResult<Vec<ActivityRow>> {
    state.activity_list().map_err(|e| e.to_string())
}

/// `prefs_get {} -> Prefs`.
#[tauri::command]
pub async fn prefs_get(state: State<'_, SessionManager>) -> CmdResult<Prefs> {
    Ok(state.prefs_get())
}

/// `prefs_set {patch} -> Prefs`: the patch replaces whole top-level keys.
#[tauri::command]
pub async fn prefs_set(state: State<'_, SessionManager>, patch: Value) -> CmdResult<Prefs> {
    let m = state.inner().clone();
    blocking(move || m.prefs_set(&patch)).await
}

/// `sound_hooks_detect {} -> [{event, command, source}]`: the user's audio hooks, read only.
#[tauri::command]
pub async fn sound_hooks_detect(state: State<'_, SessionManager>) -> CmdResult<Vec<DetectedHook>> {
    let m = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || m.sound_hooks_detect())
        .await
        .map_err(|e| e.to_string())
}

/// `notify_test {}`: post a test notification and emit `notify:fire` for it.
#[tauri::command]
pub async fn notify_test(state: State<'_, SessionManager>) -> CmdResult<()> {
    state.notify_test();
    Ok(())
}

/// `session_focus {id?}`: the DM the user is looking at (null: none), so that DM does not
/// notify while the window is focused. Call it whenever the shown DM changes.
#[tauri::command]
pub async fn session_focus(state: State<'_, SessionManager>, id: Option<String>) -> CmdResult<()> {
    state.session_focus(id.as_deref());
    Ok(())
}
