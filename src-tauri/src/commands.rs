//! Tauri commands: the IPC contract with the frontend.
//!
//! Every command is `async` so it runs on the async runtime, not the main
//! thread. Calls that can block (spawning, killing) go through
//! `spawn_blocking`. Writes only enqueue, so they are cheap and ordered.
//!
//! # Session parity contract (never two processes, mirrors, terminal-only dialogs)
//!
//! Commands:
//! - `session_resume {id, cols?, rows?, openAnyway?}` and
//!   `folder_session_open {sectionId, sessionId, openAnyway?}` re-check
//!   `claude agents --json` synchronously (3 s per attempt, one retry, claude run directly,
//!   an answer under 2 s old is reused) right before spawning. A session that
//!   runs in another terminal is not spawned: the DM becomes a read-only mirror. A re-check
//!   that cannot finish fails the call with a message starting `check_failed:` (a guess could
//!   start a second process). The UI asks the user, then repeats the call with
//!   `openAnyway: true`, which skips the check.
//! - `session_send_text {id, text} -> {outcome: "sent" | "queued" | "blocked_dialog" |
//!   "mirror_readonly", reason?, where?, pid?}`. The two refusals write nothing.
//! - `session_takeover {id, cols?, rows?} -> SessionInfo`: resume a mirror now; fails with
//!   "still running in <where> (pid N)" while the other process lives.
//! - `session_mirror_takeover_when_closed {id, enabled}`: resume by itself when it exits.
//! - `session_mirror_reveal {id}`: bring the other terminal's window and tab to the front.
//! - `session_mirror_end {id, cols?, rows?} -> SessionInfo`: the user confirmed "End it
//!   there": SIGTERM the other copy (only while it is idle and still claude), then resume here.
//! - `session_kill {id}` on a mirror stops mirroring only. `session_resize` on a mirror is a no-op.
//!   `session_write` on a mirror fails.
//!
//! Data:
//! - `SessionInfo.mirror: {where, pid, takeoverWhenClosed} | null` and
//!   `SessionInfo.terminalWait: {reason, since} | null` (both default null).
//! - `folder_sessions` rows carry `liveState: "checking" | "live" | "free"` next to
//!   `liveElsewhere`. `checking` shows until the first `claude agents --json` answer and again
//!   when the last one is older than 30 s. A row is never `free` from an empty cache.
//!
//! Events:
//! - `session:mirror {id, mirror}`: the DM became a mirror, its `pid`/`where`/
//!   `takeoverWhenClosed` changed, or it stopped being one (`mirror: null`; the DM is then
//!   an exited DM, or running when the takeover resumed it).
//! - `session:terminal_wait {id, reason, since}`: claude waits on something the chat cannot
//!   render (no bridge prompt). `reason` is the CLI's `waitingFor` when known, else
//!   `dialog open`. Sent when it begins within about 0.5 s of the dialog drawing, and again if
//!   `reason` changes. It sets the DM's needs-you flag, so `session:badges`, the sidebar,
//!   notifications and `activity_list` ("Claude is showing something in the terminal")
//!   follow.
//! - `session:terminal_wait_clear {id}`: the wait ended (answered in the terminal, or the
//!   process exited).

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::manager::sound::{ImportedPack, SoundFile};
use crate::manager::{
    ActivityRow, CreateRequest, ImageData, Located, MarkInfo, PromptAnswer, Reindexed, SectionInfo,
    SendOutcome, SessionInfo, SessionManager,
};
use patchroom_claude::{ChatItem, Cursor, Page};
use patchroom_folders::Listing;
use patchroom_prefs::{DetectedHook, Prefs};
use patchroom_search::SearchResult;
use patchroom_sounds::claude::ClaudeProfile;
use patchroom_sounds::custom::CustomSound;
use patchroom_sounds::packs::PackInfo;
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

/// `session_send_text {id, text} -> SendOutcome`: bracketed paste, then Enter. Never swallows
/// text: `{outcome: "sent"}`, `{outcome: "queued"}` (claude is busy, it reads it after the
/// turn), `{outcome: "blocked_dialog", reason}` (a dialog only the terminal can answer is up;
/// nothing was written, keep the draft) or `{outcome: "mirror_readonly", where, pid}` (the
/// session runs in another terminal; nothing was written).
#[tauri::command]
pub async fn session_send_text(
    state: State<'_, SessionManager>,
    id: String,
    text: String,
) -> CmdResult<SendOutcome> {
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

/// `session_kill {id}`. On a mirror it only stops mirroring; Patchroom never signals a
/// process it did not start.
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
/// Claude DMs run `claude --resume <stored session id>` after a synchronous re-check of
/// `claude agents --json` (3 s bound). When another terminal runs the session nothing is
/// spawned: the DM becomes a read-only mirror (`session:mirror`, `SessionInfo.mirror`) and
/// the call returns normally. If the re-check cannot finish (after one retry), the call fails
/// with a message starting `check_failed:`; the UI asks, then calls again with
/// `openAnyway: true`, which skips the check.
#[tauri::command]
pub async fn session_resume(
    state: State<'_, SessionManager>,
    id: String,
    cols: Option<u16>,
    rows: Option<u16>,
    open_anyway: Option<bool>,
) -> CmdResult<()> {
    let m = state.inner().clone();
    if open_anyway == Some(true) {
        return blocking(move || m.resume_anyway(&id, cols, rows)).await;
    }
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

/// `section_create {name, kind?, emoji?} -> {id}`. `kind` is `section` (default) or `divider`.
#[tauri::command]
pub async fn section_create(
    state: State<'_, SessionManager>,
    name: String,
    kind: Option<String>,
    emoji: Option<String>,
) -> CmdResult<Created> {
    let id = state
        .create_section_of(&name, kind.as_deref(), emoji.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(Created { id })
}

/// `section_set_emoji {id, emoji|null}`.
/// With `flavor` (`apple` or `noto`) the pair is stored as one `{char, flavor}`.
#[tauri::command]
pub async fn section_set_emoji(
    state: State<'_, SessionManager>,
    id: String,
    emoji: Option<String>,
    flavor: Option<String>,
) -> CmdResult<()> {
    match flavor {
        Some(f) => state.set_section_emoji_flavor(&id, emoji.as_deref(), Some(&f)),
        None => state.set_section_emoji(&id, emoji.as_deref()),
    }
    .map_err(|e| e.to_string())
}

/// `session_set_emoji {id, emoji?, flavor?}`: a session row's emoji as `{char, flavor}`.
#[tauri::command]
pub async fn session_set_emoji(
    state: State<'_, SessionManager>,
    id: String,
    emoji: Option<String>,
    flavor: Option<String>,
) -> CmdResult<()> {
    state
        .set_session_emoji(&id, emoji.as_deref(), flavor.as_deref())
        .map_err(|e| e.to_string())
}

/// `session_set_model {id, model}`: after a confirmed `/model` switch, the DM resumes on it.
#[tauri::command]
pub async fn session_set_model(
    state: State<'_, SessionManager>,
    id: String,
    model: String,
) -> CmdResult<()> {
    state.set_model(&id, &model).map_err(|e| e.to_string())
}

/// `catalog_get -> catalog | null`: the signed catalog fetched earlier, verified again.
#[tauri::command]
pub async fn catalog_get(state: State<'_, SessionManager>) -> CmdResult<Option<Value>> {
    let m = state.inner().clone();
    blocking(move || Ok(m.catalog_cached())).await
}

/// `catalog_refresh -> catalog`: download and verify it. Fails while the setting is off.
#[tauri::command]
pub async fn catalog_refresh(state: State<'_, SessionManager>) -> CmdResult<Value> {
    let m = state.inner().clone();
    blocking(move || m.catalog_refresh()).await
}

/// `update_check -> {current, latest, url, newer}`. Fails while the setting is off.
#[tauri::command]
pub async fn update_check(
    state: State<'_, SessionManager>,
) -> CmdResult<crate::manager::UpdateInfo> {
    let m = state.inner().clone();
    blocking(move || m.update_check()).await
}

/// `app_restart {ids}`: remember the DMs to reopen, then quit and relaunch. Sessions end
/// through the normal quit path first.
#[tauri::command]
pub async fn app_restart(
    app: AppHandle,
    state: State<'_, SessionManager>,
    ids: Vec<String>,
) -> CmdResult<()> {
    let m = state.inner().clone();
    blocking(move || m.prepare_restart(&ids)).await?;
    app.request_restart();
    Ok(())
}

/// `app_restart_pending -> [id]`: the DMs the last restart asked to reopen, once.
#[tauri::command]
pub async fn app_restart_pending(state: State<'_, SessionManager>) -> CmdResult<Vec<String>> {
    let m = state.inner().clone();
    blocking(move || Ok(m.take_restart())).await
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

/// `section_delete {id}`: the section's sessions fall back to "Sessions".
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

/// `sound_packs {} -> [{id, name, description, kind, license, author, events, norm?}]` (plus `source`
/// and, for generated packs, `notes`).
#[tauri::command]
pub async fn sound_packs(state: State<'_, SessionManager>) -> CmdResult<Vec<PackInfo>> {
    let m = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || m.sound_packs())
        .await
        .map_err(|e| e.to_string())
}

/// `sound_file {packId, event} -> {dataUrl}`: a file pack's sound, fetched on demand.
#[tauri::command]
pub async fn sound_file(
    state: State<'_, SessionManager>,
    pack_id: String,
    event: String,
) -> CmdResult<SoundFile> {
    let m = state.inner().clone();
    blocking(move || m.sound_file(&pack_id, &event)).await
}

/// `sound_import_file {path} -> {id, name, durationMs, norm}`: copy the user's file into the data
/// dir after the type, size and duration checks.
#[tauri::command]
pub async fn sound_import_file(
    state: State<'_, SessionManager>,
    path: String,
) -> CmdResult<CustomSound> {
    let m = state.inner().clone();
    blocking(move || m.sound_import_file(&path)).await
}

/// `sound_custom_list {} -> [{id, name, durationMs, norm}]`: the user's own sounds, newest first.
#[tauri::command]
pub async fn sound_custom_list(state: State<'_, SessionManager>) -> CmdResult<Vec<CustomSound>> {
    let m = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || m.sound_custom_list())
        .await
        .map_err(|e| e.to_string())
}

/// `sound_custom_file {id} -> {dataUrl}`: one of the user's own sounds.
#[tauri::command]
pub async fn sound_custom_file(
    state: State<'_, SessionManager>,
    id: String,
) -> CmdResult<SoundFile> {
    let m = state.inner().clone();
    blocking(move || m.sound_custom_file(&id)).await
}

/// `sound_custom_remove {id}`: delete a custom sound; mixes that used it fall back.
#[tauri::command]
pub async fn sound_custom_remove(state: State<'_, SessionManager>, id: String) -> CmdResult<()> {
    let m = state.inner().clone();
    blocking(move || m.sound_custom_remove(&id)).await
}

/// `sound_claude_profiles {} -> [{id, name, events}]`: the user's Claude sound profiles, read
/// only.
#[tauri::command]
pub async fn sound_claude_profiles(
    state: State<'_, SessionManager>,
) -> CmdResult<Vec<ClaudeProfile>> {
    let m = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || m.sound_claude_profiles())
        .await
        .map_err(|e| e.to_string())
}

/// `sound_import_claude_profile {id} -> {packId}`: copy a profile's sounds into a pack.
#[tauri::command]
pub async fn sound_import_claude_profile(
    state: State<'_, SessionManager>,
    id: String,
) -> CmdResult<ImportedPack> {
    let m = state.inner().clone();
    blocking(move || m.sound_import_claude_profile(&id)).await
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

// ---- P3: folder sections ----

/// `section_create_from_folder {path, name?} -> {id}`: a section with a home folder.
#[tauri::command]
pub async fn section_create_from_folder(
    state: State<'_, SessionManager>,
    path: String,
    name: Option<String>,
) -> CmdResult<Created> {
    let id = state
        .section_create_from_folder(&path, name.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(Created { id })
}

/// `section_set_archive_days {id, days}`: the "Older than X days" threshold.
#[tauri::command]
pub async fn section_set_archive_days(
    state: State<'_, SessionManager>,
    id: String,
    days: i64,
) -> CmdResult<()> {
    state
        .section_set_archive_days(&id, days)
        .map_err(|e| e.to_string())
}

/// `folder_sessions {sectionId} -> {sessions, hiddenCount}`: the resumable sessions found
/// under the section's folder. Read only; nothing starts.
#[tauri::command]
pub async fn folder_sessions(
    state: State<'_, SessionManager>,
    section_id: String,
) -> CmdResult<Listing> {
    let m = state.inner().clone();
    blocking(move || m.folder_sessions(&section_id)).await
}

/// `folder_session_open {sectionId, sessionId} -> SessionInfo`: create the DM row and run
/// `claude --resume <sessionId>` from the session's launch folder.
#[tauri::command]
pub async fn folder_session_open(
    state: State<'_, SessionManager>,
    section_id: String,
    session_id: String,
    open_anyway: Option<bool>,
) -> CmdResult<SessionInfo> {
    let m = state.inner().clone();
    let anyway = open_anyway == Some(true);
    blocking(move || m.folder_session_open_with(&section_id, &session_id, anyway)).await
}

/// `folder_session_hide {sectionId, sessionId, hidden}`: hide a row from the list; the
/// transcript is untouched.
#[tauri::command]
pub async fn folder_session_hide(
    state: State<'_, SessionManager>,
    section_id: String,
    session_id: String,
    hidden: bool,
) -> CmdResult<()> {
    state
        .folder_session_hide(&section_id, &session_id, hidden)
        .map_err(|e| e.to_string())
}

// ---- session parity: mirrors and terminal-only dialogs ----

/// `session_takeover {id, cols?, rows?} -> SessionInfo`: resume a mirrored DM now. Fails while
/// the other process still runs (it is never killed).
#[tauri::command]
pub async fn session_takeover(
    state: State<'_, SessionManager>,
    id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> CmdResult<SessionInfo> {
    let m = state.inner().clone();
    blocking(move || m.takeover(&id, cols, rows)).await
}

/// `session_mirror_takeover_when_closed {id, enabled}`: resume the mirrored DM by itself when
/// the other process exits ("Take over when it closes"). Emits `session:mirror`.
#[tauri::command]
pub async fn session_mirror_takeover_when_closed(
    state: State<'_, SessionManager>,
    id: String,
    enabled: bool,
) -> CmdResult<()> {
    state
        .set_mirror_takeover(&id, enabled)
        .map_err(|e| e.to_string())
}

/// `session_mirror_reveal {id}`: bring the terminal that runs a mirrored DM to the front.
#[tauri::command]
pub async fn session_mirror_reveal(state: State<'_, SessionManager>, id: String) -> CmdResult<()> {
    let m = state.inner().clone();
    blocking(move || m.mirror_reveal(&id)).await
}

/// `session_mirror_end {id, cols?, rows?} -> SessionInfo`: stop the idle copy in the other
/// terminal (the user confirmed it) and resume the session here.
#[tauri::command]
pub async fn session_mirror_end(
    state: State<'_, SessionManager>,
    id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> CmdResult<SessionInfo> {
    let m = state.inner().clone();
    blocking(move || m.mirror_end(&id, cols, rows)).await
}

// ---- links: the in-app viewer and the system browser ----

/// `link_open_external {url}`: open an http(s) link in the system default browser.
#[tauri::command]
pub async fn link_open_external(url: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::viewer::open_external(&url))
        .await
        .map_err(|e| e.to_string())?
}

/// `viewer_show {url, rect}`: show an http(s) link in the in-app viewer over `rect`.
#[tauri::command]
pub async fn viewer_show(app: AppHandle, url: String, rect: crate::viewer::Rect) -> CmdResult<()> {
    crate::viewer::show(&app, &url, rect)
}

/// `viewer_place {rect}`: move the viewer with its pane.
#[tauri::command]
pub async fn viewer_place(app: AppHandle, rect: crate::viewer::Rect) -> CmdResult<()> {
    crate::viewer::place(&app, rect)
}

/// `viewer_hide {}`: hide the viewer. Emits nothing.
#[tauri::command]
pub async fn viewer_hide(app: AppHandle) -> CmdResult<()> {
    crate::viewer::hide(&app)
}

/// `viewer_go {action}`: `back`, `forward` or `reload`.
#[tauri::command]
pub async fn viewer_go(app: AppHandle, action: String) -> CmdResult<()> {
    crate::viewer::go(&app, &action)
}

// ---- Fonts (read only) ----

/// `fonts_list {} -> [{family, mono}]`: the installed font families from Core Text, sorted,
/// with the fixed-pitch trait. Read only.
#[tauri::command]
pub async fn fonts_list() -> CmdResult<Vec<patchroom_prefs::FontFamily>> {
    tauri::async_runtime::spawn_blocking(crate::fonts::installed)
        .await
        .map_err(|e| e.to_string())
}

// ---- Theme import (read only) ----

/// `theme_import_detect {} -> [{id, name, entries, skipped}]`: the terminal looks the user's
/// installed tools offer (iTerm2, Ghostty, Warp, VS Code, Cursor, Terminal.app). Read only:
/// nothing here writes, renames or locks any of their files.
#[tauri::command]
pub async fn theme_import_detect() -> CmdResult<Vec<patchroom_themeimport::Source>> {
    tauri::async_runtime::spawn_blocking(|| {
        patchroom_themeimport::Env::real()
            .map_or_else(Vec::new, |env| patchroom_themeimport::detect(&env))
    })
    .await
    .map_err(|e| e.to_string())
}

/// `theme_import_file {} -> Imported | null`: pick an `.itermcolors` file and read it, read
/// only. Null when the picker is cancelled.
#[tauri::command]
pub async fn theme_import_file(
    app: AppHandle,
) -> CmdResult<Option<patchroom_themeimport::Imported>> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("iTerm2 color presets", &["itermcolors"])
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
        else {
            return Ok(None);
        };
        patchroom_themeimport::read_itermcolors(&path).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
