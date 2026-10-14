//! Debug-only end-to-end hooks. This whole module is compiled only with
//! `debug_assertions` (see `lib.rs`), so a release build has no code path for it.
//!
//! `patchroom --e2e-script <path.js> [--e2e-report <dir>]` loads a scenario script into the
//! main webview once the page has loaded. The UI side lives in `ui/src/e2e/` and drives the
//! real controls with DOM events. This module only provides what a webview cannot do alone:
//!
//! - `e2e_report {name, body}`: write a report file (JSON or a DOM snapshot) into the report dir;
//! - `e2e_pgrep {pattern}`: pids of processes whose command line matches `pattern`;
//! - `e2e_sleep {ms}`: a timer that does not depend on webview timers (a locked or occluded
//!   WKWebView may throttle `setTimeout`, but an IPC reply still arrives);
//! - `e2e_param {name}`: a scenario parameter from the environment (`PATCHROOM_E2E_<NAME>`);
//! - `e2e_quit`: exit through the normal quit path, so the manager's shutdown runs;
//! - `e2e_restart {phase}`: quit the same way and ask `scripts/e2e-live.sh` to start the app
//!   again on the same data dir with `PATCHROOM_E2E_PHASE=<phase>` (the scenario reads it with
//!   `e2e_param("phase")`), so one run can check what survives a restart;
//! - `e2e_outside_session {dir}`: start an interactive `claude --model haiku` in a pty, as a
//!   terminal outside Patchroom would, in a folder named by a `PATCHROOM_E2E_DIR_*` variable.
//!   Returns the epoch ms when its prompt was sent; the session ends on its own
//!   (`e2e_outside_done` says when);
//! - `e2e_decision_log`: the notification decision log (`notify-decisions.log` in the data
//!   dir): event, DM id, decision and reason per line, never a message body;
//! - `e2e_window_state -> {nativeFocused, webviewFocused, visible, minimized, forced, active}`:
//!   what the focus probe sees right now. `active` is what focus suppression uses;
//! - `e2e_force_active {active: bool | null}`: pin the focus probe (`true` looks focused,
//!   `false` looks blurred, `null` goes back to the real window and webview state). Use
//!   `false` to make an unfocused needs-you step deterministic, and always release it;
//! - `e2e_focus_window`: show, unminimize and focus the main window, as a click on it would.
//!   Whether it becomes the key window depends on the machine (a locked screen refuses);
//! - `e2e_outside_stop`: stop every helper `e2e_outside_session` started (driver and its
//!   claude child), TERM then KILL. Resolves when none is left. The app also does this on exit,
//!   so a failed scenario leaves nothing behind;
//!
//! The 250 ms heartbeat also reports `document.hasFocus()` to the focus probe, so a window
//! driven by a script (often not the key window) still counts as focused while the page has
//! focus. Focus is native key window OR a fresh webview report, and the window must be visible.
//!
//! There is no network listener: everything goes over Tauri's own IPC.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, Manager as _};

/// Parsed `--e2e-*` flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct E2eArgs {
    /// Scenario script: JS that sets `window.__PR_E2E_SCENARIO__` to an async function of the runner.
    pub script: PathBuf,
    /// Directory the report and snapshots are written to.
    pub report_dir: PathBuf,
}

/// Parse `--e2e-script <path>` and `--e2e-report <dir>`. No script means no e2e run.
#[must_use]
pub fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Option<E2eArgs> {
    let mut it = args.into_iter();
    let mut script = None;
    let mut report = None;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--e2e-script" => script = it.next(),
            "--e2e-report" => report = it.next(),
            _ => {}
        }
    }
    script.map(|s| E2eArgs {
        script: PathBuf::from(s),
        report_dir: report.map_or_else(
            || std::env::temp_dir().join("patchroom-e2e-report"),
            PathBuf::from,
        ),
    })
}

/// Managed state present only when `--e2e-script` was given.
pub struct E2eState {
    args: E2eArgs,
}

impl E2eState {
    /// Wrap the parsed flags and create the report dir.
    ///
    /// # Errors
    /// Fails when the report dir cannot be created.
    pub fn new(args: E2eArgs) -> std::io::Result<Self> {
        std::fs::create_dir_all(&args.report_dir)?;
        Ok(Self { args })
    }
}

/// JS that loads the scenario script, then waits for the UI runner (`window.__PR_E2E__`) and
/// hands it the scenario. The script must assign an async function of the runner to
/// `window.__PR_E2E_SCENARIO__`. Evaluated through the webview's own eval, so the page CSP does
/// not apply.
fn boot_js(script: &str) -> String {
    format!(
        "{script}\n;(function boot(n){{var r=window.__PR_E2E__;\
if(!r){{if(n>600){{console.error('e2e: runner missing');return;}}\
setTimeout(function(){{boot(n+1);}},100);return;}}\
r.start(function(t){{{PIN_WIDGETS}return window.__PR_E2E_SCENARIO__(t);}});}})(0);"
    )
}

/// Presses "Needs you below" for the scenario, as a user would. With the window unfocused or
/// occluded WebKit throttles rendering, the log loses its pin to the bottom after a view
/// switch or a new row, and the virtualized log does not render rows below the viewport. A
/// scenario that polls for a pending widget (a `settle` loop that clicks Allow) or for the
/// newest message would then wait for something that is not in the DOM while the TUI waits
/// for the answer. The wrapper jumps to the latest before each poll of `waitFor` and each
/// `widget()` miss. It changes what the page shows, never what the scenario checks.
const PIN_WIDGETS: &str = "try{var jump=function(){var j=document.querySelector(\
'[data-testid=\"chat\"]:not(.chat--hidden) [data-testid=\"jump-latest\"]');if(j)j.click();};\
var w0=t.widget.bind(t);t.widget=function(k,s){var w=w0(k,s);\
if(!w&&(!s||s==='pending'))jump();return w;};\
var f0=t.waitFor.bind(t);t.waitFor=function(a,fn,ms){return f0(a,function(){jump();return fn();},ms);};}\
catch(e){}";

/// Inject the scenario into the webview. Called once per page load.
pub fn inject(webview: &tauri::Webview) {
    let Some(state) = webview.try_state::<E2eState>() else {
        return;
    };
    match std::fs::read_to_string(&state.args.script) {
        Ok(src) => {
            if let Err(e) = webview.eval(boot_js(&src)) {
                eprintln!("patchroom: e2e script eval failed: {e}");
            }
        }
        Err(e) => eprintln!(
            "patchroom: cannot read e2e script {}: {e}",
            state.args.script.display()
        ),
    }
}

/// The heartbeat script: report the page's own focus to the native focus probe.
const HEARTBEAT_JS: &str = "try{window.__TAURI_INTERNALS__.invoke('e2e_webview_focus',\
{focused:document.hasFocus()}).catch(function(){});}catch(e){}";

/// Evaluate a small script in the main webview every 250 ms for the life of the app.
///
/// With the screen locked the window is occluded, and WebKit suspends the web content process
/// shortly after load: page timers, `requestAnimationFrame` and pending IPC replies all stop.
/// A UI-process `evaluateJavaScript` is a foreground activity for the web process, so a steady
/// stream of them keeps the page running. Debug e2e runs only.
pub fn start_heartbeat(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("patchroom-e2e-beat".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval(HEARTBEAT_JS);
            }
        });
    if let Err(e) = spawned {
        eprintln!("patchroom: e2e heartbeat failed to start: {e}");
    }
}

fn state(app: &AppHandle) -> Result<tauri::State<'_, E2eState>, String> {
    app.try_state::<E2eState>()
        .ok_or_else(|| "e2e is not enabled (no --e2e-script)".to_owned())
}

/// A file name that stays inside the report dir.
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn write_report(dir: &Path, name: &str, body: &str) -> Result<PathBuf, String> {
    if !safe_name(name) {
        return Err(format!("bad report name: {name}"));
    }
    let path = dir.join(name);
    // Write then rename so a reader never sees half a file.
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

/// `e2e_report {name, body}`: write `body` to `<report dir>/<name>`. Returns the path.
#[tauri::command]
pub async fn e2e_report(app: AppHandle, name: String, body: String) -> Result<String, String> {
    let dir = state(&app)?.args.report_dir.clone();
    write_report(&dir, &name, &body).map(|p| p.to_string_lossy().into_owned())
}

/// Pids whose full command line matches `pattern`, never counting this process or `pgrep`.
/// With `scope`, only processes whose command line also contains it (the run's own data
/// dir: hook and claude command lines carry it through `--socket` and `--settings`), so a
/// second app instance or a test run on the same machine never counts.
fn pgrep(pattern: &str, scope: Option<&str>) -> Vec<u32> {
    let me = std::process::id();
    // `--` first: BSD pgrep reads a pattern that starts with `-` (`--resume <id>`) as an option.
    let out = Command::new("/usr/bin/pgrep")
        .args(["-f", "--", pattern])
        .output();
    let Ok(out) = out else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .filter(|p| *p != me)
        .filter(|p| scope.is_none_or(|sc| command_line(*p).contains(sc)))
        .collect()
}

fn command_line(pid: u32) -> String {
    Command::new("/bin/ps")
        .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// The data dir of this run: `PATCHROOM_DATA_DIR`, else the app data dir.
fn run_scope(app: &AppHandle) -> Option<String> {
    std::env::var("PATCHROOM_DATA_DIR")
        .ok()
        .filter(|d| !d.is_empty())
        .or_else(|| {
            app.path()
                .app_data_dir()
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        })
}

/// `e2e_pgrep {pattern} -> [pid]`: `pgrep -f pattern` limited to this run's processes,
/// empty when nothing matches.
#[tauri::command]
pub async fn e2e_pgrep(app: AppHandle, pattern: String) -> Result<Vec<u32>, String> {
    state(&app)?;
    if pattern.is_empty()
        || !pattern
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ' '))
    {
        return Err("bad pgrep pattern".into());
    }
    let scope = run_scope(&app);
    tauri::async_runtime::spawn_blocking(move || pgrep(&pattern, scope.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// `e2e_sleep {ms}`: resolves after `ms` (at most 60 s) on a native timer.
#[tauri::command]
pub async fn e2e_sleep(app: AppHandle, ms: u64) -> Result<(), String> {
    state(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(ms.min(60_000)));
    })
    .await
    .map_err(|e| e.to_string())
}

/// `e2e_param {name} -> string | null`: `PATCHROOM_E2E_<NAME>` from the environment.
#[tauri::command]
pub async fn e2e_param(app: AppHandle, name: String) -> Result<Option<String>, String> {
    state(&app)?;
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("bad parameter name".into());
    }
    Ok(std::env::var(format!("PATCHROOM_E2E_{}", name.to_ascii_uppercase())).ok())
}

/// `e2e_quit`: exit the app through the normal path (`RunEvent::Exit` runs the shutdown).
#[tauri::command]
pub async fn e2e_quit(app: AppHandle) -> Result<(), String> {
    state(&app)?;
    app.exit(0);
    Ok(())
}

/// Name of the file `e2e_restart` leaves in the report dir for the driving script.
pub const RESTART_REQUEST: &str = "restart-request";

/// Write the restart request: the phase name, on one line. Phases are short identifiers.
fn write_restart_request(dir: &Path, phase: &str) -> Result<PathBuf, String> {
    if !safe_name(phase) || phase.contains('.') {
        return Err(format!("bad phase name: {phase}"));
    }
    write_report(dir, RESTART_REQUEST, &format!("{phase}\n"))
}

/// `e2e_restart {phase}`: ask `scripts/e2e-live.sh` for a relaunch on the same data dir, then
/// exit through the normal quit path. Without the script the app simply quits.
#[tauri::command]
pub async fn e2e_restart(app: AppHandle, phase: String) -> Result<(), String> {
    let dir = state(&app)?.args.report_dir.clone();
    write_restart_request(&dir, &phase)?;
    app.exit(0);
    Ok(())
}

/// Environment variables whose value names a folder the scenario may use.
fn e2e_dirs() -> Vec<PathBuf> {
    std::env::vars()
        .filter(|(k, v)| k.starts_with("PATCHROOM_E2E_DIR_") && Path::new(v).is_absolute())
        .map(|(_, v)| PathBuf::from(v))
        .collect()
}

/// Is `dir` one of the scenario's folders (or inside one)? Never a path outside them.
fn is_scenario_dir(dir: &str, allowed: &[PathBuf]) -> bool {
    let p = Path::new(dir);
    p.is_absolute()
        && !p
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        && allowed.iter().any(|a| p.starts_with(a))
}

/// Pids of outside-session drivers started by `e2e_outside_session` that have not exited yet.
static OUTSIDE_PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

fn outside_pids() -> Vec<u32> {
    OUTSIDE_PIDS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

fn signal(sig: &str, pid: u32) {
    let _ = Command::new("/bin/kill")
        .args([sig, &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status();
}

/// Stop every outside driver: TERM (the driver kills its claude child), then KILL after 15 s.
/// Blocks until none is left or 20 s passed. Safe to call when nothing runs.
pub fn stop_outside() {
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(20) {
        let pids = outside_pids();
        if pids.is_empty() {
            return;
        }
        let sig = if start.elapsed() < Duration::from_secs(15) {
            "-TERM"
        } else {
            "-KILL"
        };
        for p in pids {
            signal(sig, p);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// `e2e_outside_stop`: stop the outside-session helpers and their claude children.
#[tauri::command]
pub async fn e2e_outside_stop(app: AppHandle) -> Result<(), String> {
    state(&app)?;
    tauri::async_runtime::spawn_blocking(stop_outside)
        .await
        .map_err(|e| e.to_string())
}

/// `e2e_focus_window`: show, unminimize and focus the main window.
#[tauri::command]
pub async fn e2e_focus_window(app: AppHandle) -> Result<(), String> {
    state(&app)?;
    let w = app.get_webview_window("main").ok_or("no main window")?;
    let _ = w.show();
    let _ = w.unminimize();
    w.set_focus().map_err(|e| e.to_string())
}

/// `e2e_webview_focus {focused}`: the heartbeat's report of `document.hasFocus()`.
#[tauri::command]
pub async fn e2e_webview_focus(app: AppHandle, focused: bool) -> Result<(), String> {
    state(&app)?;
    crate::notifier::hints().report_webview(focused);
    Ok(())
}

/// `e2e_force_active {active}`: pin the focus probe, or release it with null.
#[tauri::command]
pub async fn e2e_force_active(app: AppHandle, active: Option<bool>) -> Result<(), String> {
    state(&app)?;
    crate::notifier::hints().force(active);
    Ok(())
}

/// `e2e_window_state`: the probe's inputs and verdict, for reports and assertions.
#[tauri::command]
pub async fn e2e_window_state(app: AppHandle) -> Result<serde_json::Value, String> {
    state(&app)?;
    let w = app.get_webview_window("main").ok_or("no main window")?;
    let native = w.is_focused().unwrap_or(false);
    let visible = w.is_visible().unwrap_or(false);
    let minimized = w.is_minimized().unwrap_or(false);
    let probe = crate::notifier::WindowProbe(app.clone());
    Ok(serde_json::json!({
        "nativeFocused": native,
        "visible": visible,
        "minimized": minimized,
        "webviewFocused": crate::notifier::hints().webview_focused(),
        "forced": crate::notifier::hints().forced_state(),
        "active": crate::notifier::FocusProbe::window_active(&probe),
    }))
}

/// `e2e_outside_done -> bool`: true once every outside session has exited, so a scenario can
/// wait for its helper before it quits (nothing may outlive the app).
#[tauri::command]
pub async fn e2e_outside_done(app: AppHandle) -> Result<bool, String> {
    state(&app)?;
    Ok(outside_pids().is_empty())
}

/// `e2e_outside_session {dir} -> epoch ms`: run `scripts/e2e-outside-session.py` (named by
/// `PATCHROOM_E2E_OUTSIDE_DRIVER`) in `dir`, which must be one of the scenario's folders. It
/// starts an interactive `claude --model haiku` in a pty, as a terminal outside Patchroom
/// would. Returns the time its prompt was sent; the session finishes and exits by itself.
#[tauri::command]
pub async fn e2e_outside_session(app: AppHandle, dir: String) -> Result<i64, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    state(&app)?;
    if !is_scenario_dir(&dir, &e2e_dirs()) {
        return Err(format!("not a scenario folder: {dir}"));
    }
    let driver = std::env::var("PATCHROOM_E2E_OUTSIDE_DRIVER")
        .map_err(|_| "PATCHROOM_E2E_OUTSIDE_DRIVER is not set".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new("/usr/bin/python3")
            .args(["-I", &driver, &dir])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut sent = None;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(ms) = line.strip_prefix("SENT ") {
                sent = ms.trim().parse::<i64>().ok();
                break;
            }
            if line.starts_with("NOT_SENT") {
                break;
            }
        }
        // The driver keeps running until the reply lands; reap it in the background.
        let pid = child.id();
        OUTSIDE_PIDS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(pid);
        std::thread::spawn(move || {
            let _ = child.wait();
            OUTSIDE_PIDS
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .retain(|p| *p != pid);
        });
        sent.ok_or_else(|| "the outside session never sent its prompt".to_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `e2e_decision_log -> string`: the notification decision log of this run's data dir.
#[tauri::command]
pub async fn e2e_decision_log(app: AppHandle) -> Result<String, String> {
    state(&app)?;
    let dir = match std::env::var("PATCHROOM_DATA_DIR") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    Ok(std::fs::read_to_string(dir.join(crate::manager::DECISION_LOG)).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_request_is_a_safe_phase_name_in_the_report_dir() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_restart_request(dir.path(), "after-restart").unwrap();
        assert_eq!(p, dir.path().join(RESTART_REQUEST));
        assert_eq!(std::fs::read_to_string(p).unwrap(), "after-restart\n");
        for bad in ["", "../x", "a b", "a.b", "x/y"] {
            assert!(write_restart_request(dir.path(), bad).is_err(), "{bad:?}");
        }
    }

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn flags_parse() {
        assert_eq!(parse_args(v(&["--open-dm", "/x"])), None);
        let a = parse_args(v(&["--e2e-script", "/s.js", "--e2e-report", "/r"])).unwrap();
        assert_eq!(a.script, PathBuf::from("/s.js"));
        assert_eq!(a.report_dir, PathBuf::from("/r"));
        let d = parse_args(v(&["--e2e-script", "/s.js"])).unwrap();
        assert!(d.report_dir.ends_with("patchroom-e2e-report"));
    }

    #[test]
    fn report_names_stay_inside_the_dir() {
        for bad in ["", "..", ".", "a/b", "../x", "a b", "x\0"] {
            assert!(!safe_name(bad), "{bad:?}");
        }
        assert!(safe_name("report.json"));
        assert!(safe_name("dom-01_step.html"));
        let dir = tempfile::tempdir().unwrap();
        let p = write_report(dir.path(), "r.json", "{}").unwrap();
        assert_eq!(std::fs::read_to_string(p).unwrap(), "{}");
        assert!(write_report(dir.path(), "../r.json", "{}").is_err());
    }

    #[test]
    fn outside_sessions_only_run_in_scenario_folders() {
        let allowed = vec![
            PathBuf::from("/tmp/pr-e2e-1/alpha"),
            PathBuf::from("/tmp/pr-e2e-1/fold"),
        ];
        assert!(is_scenario_dir("/tmp/pr-e2e-1/alpha", &allowed));
        assert!(is_scenario_dir("/tmp/pr-e2e-1/fold/sub", &allowed));
        for bad in [
            "/tmp/pr-e2e-1",
            "/tmp/pr-e2e-1/alphabet",
            "/tmp/pr-e2e-1/alpha/../../etc",
            "relative",
            "/Users/someone",
        ] {
            assert!(!is_scenario_dir(bad, &allowed), "{bad}");
        }
    }

    #[test]
    fn boot_runs_the_script_then_starts_the_runner() {
        let js = boot_js("window.__PR_E2E_SCENARIO__ = async (t) => {};");
        assert!(js.starts_with("window.__PR_E2E_SCENARIO__"));
        assert!(js.contains("window.__PR_E2E_SCENARIO__(t)"));
        assert!(
            js.contains("jump-latest"),
            "the widget poll presses Needs you below"
        );
    }

    #[test]
    fn pgrep_finds_nothing_for_an_unlikely_pattern() {
        assert!(pgrep("patchroom-no-such-process-zz9", None).is_empty());
    }

    #[test]
    fn pgrep_matches_a_pattern_that_starts_with_dashes() {
        let mut a = Command::new("/bin/sh")
            .args(["-c", "sleep 37.5; :", "--resume", "pr-dash-test-9f3"])
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let found = pgrep("--resume pr-dash-test-9f3", None);
        let _ = a.kill();
        let _ = a.wait();
        assert!(found.contains(&a.id()), "{found:?}");
    }

    #[test]
    fn stop_outside_with_nothing_running_returns_at_once() {
        let t = std::time::Instant::now();
        stop_outside();
        assert!(t.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn pgrep_scope_excludes_other_runs() {
        let dir = std::env::temp_dir().join("pr-scope-test-a");
        let mut a = Command::new("/bin/sh")
            .args(["-c", "sleep 37.25; :", &dir.to_string_lossy()])
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let mine = pgrep("sleep 37.25", Some(&dir.to_string_lossy()));
        let other = pgrep("sleep 37.25", Some("/tmp/pr-scope-test-other"));
        let _ = a.kill();
        let _ = a.wait();
        assert!(mine.contains(&a.id()), "{mine:?}");
        assert!(other.is_empty(), "{other:?}");
    }
}
