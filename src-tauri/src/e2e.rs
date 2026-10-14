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
//! - `e2e_quit`: exit through the normal quit path, so the manager's shutdown runs.
//!
//! There is no network listener: everything goes over Tauri's own IPC.

use std::path::{Path, PathBuf};
use std::process::Command;
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
r.start(window.__PR_E2E_SCENARIO__);}})(0);"
    )
}

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

/// Evaluate a no-op in the main webview every 250 ms for the life of the app.
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
                let _ = w.eval("void 0");
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
    let out = Command::new("/usr/bin/pgrep")
        .args(["-f", pattern])
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn boot_runs_the_script_then_starts_the_runner() {
        let js = boot_js("window.__PR_E2E_SCENARIO__ = async (t) => {};");
        assert!(js.starts_with("window.__PR_E2E_SCENARIO__"));
        assert!(js.contains("r.start(window.__PR_E2E_SCENARIO__)"));
    }

    #[test]
    fn pgrep_finds_nothing_for_an_unlikely_pattern() {
        assert!(pgrep("patchroom-no-such-process-zz9", None).is_empty());
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
