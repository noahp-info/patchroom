//! statusLine support: resolve the user's own `statusLine` the way Claude Code does, and
//! read structured chips from the statusLine stdin JSON.
//!
//! Patchroom adds a statusLine wrapper to the per-launch `--settings`. Because
//! `--settings` outranks the user's files, claude runs the wrapper instead of the user's
//! command. The wrapper (`patchroom-statusline`) finds the user's command with
//! [`resolve_user_status_line`], runs it unchanged with the same stdin, passes its output
//! through and tees stdin and output to the bridge.
//!
//! Resolution order, highest first (the order claude merges settings; a managed policy
//! `statusLine` would outrank `--settings`, so claude would never call the wrapper):
//!
//! 1. `<project>/.claude/settings.local.json`
//! 2. `<project>/.claude/settings.json`
//! 3. `<config dir>/settings.json` (`$CLAUDE_CONFIG_DIR`, else `~/.claude`)
//!
//! Files are only ever read. Nothing in this module writes any file.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A resolved user `statusLine` of type `command`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusLineSpec {
    /// Shell command line, exactly as in the settings file.
    pub command: String,
    /// `padding` from the settings, copied into the wrapper's own `statusLine` so the TUI
    /// layout stays the same.
    pub padding: Option<i64>,
    /// Settings file the command came from.
    pub source: PathBuf,
}

fn read_status_line(path: &Path) -> Option<StatusLineSpec> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let sl = v.get("statusLine")?;
    if sl.get("type").and_then(Value::as_str) != Some("command") {
        return None;
    }
    let command = sl.get("command").and_then(Value::as_str)?.trim();
    if command.is_empty() {
        return None;
    }
    Some(StatusLineSpec {
        command: command.to_owned(),
        padding: sl.get("padding").and_then(Value::as_i64),
        source: path.to_owned(),
    })
}

/// Claude's config dir: `$CLAUDE_CONFIG_DIR`, else `<home>/.claude`.
#[must_use]
pub fn config_dir(env_config_dir: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    match env_config_dir.filter(|s| !s.is_empty()) {
        Some(d) => Some(PathBuf::from(d)),
        None => home.map(|h| h.join(".claude")),
    }
}

/// Find the user's statusLine. `project_dirs` are tried in order, each checking its local
/// then shared settings; the user settings file is the last resort.
#[must_use]
pub fn resolve_user_status_line(
    project_dirs: &[PathBuf],
    config_dir: Option<&Path>,
) -> Option<StatusLineSpec> {
    for dir in project_dirs {
        for file in ["settings.local.json", "settings.json"] {
            if let Some(spec) = read_status_line(&dir.join(".claude").join(file)) {
                return Some(spec);
            }
        }
    }
    read_status_line(&config_dir?.join("settings.json"))
}

/// The directories to treat as the project, from the statusLine stdin JSON.
#[must_use]
pub fn project_dirs_from_payload(payload: &Value) -> Vec<PathBuf> {
    let ws = payload.get("workspace");
    let pick = |v: Option<&Value>, k: &str| {
        v.and_then(|x| x.get(k))
            .and_then(Value::as_str)
            .map(PathBuf::from)
    };
    let mut out: Vec<PathBuf> = Vec::new();
    for p in [
        pick(ws, "project_dir"),
        pick(Some(payload), "cwd"),
        pick(ws, "current_dir"),
    ]
    .into_iter()
    .flatten()
    {
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// Structured chips for the status strip.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chips {
    /// Model display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Context window used, in percent (0 to 100).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_pct: Option<f64>,
    /// Session cost in USD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    /// Permission mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Worktree name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// PR url.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
}

impl Chips {
    /// Fill the empty fields of `self` from `other`.
    pub fn fill_from(&mut self, other: &Chips) {
        macro_rules! fill {
            ($($f:ident),*) => {$(
                if self.$f.is_none() { self.$f.clone_from(&other.$f); }
            )*};
        }
        fill!(model, context_pct, cost, mode, worktree, pr_url);
    }
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for k in path {
        cur = cur.get(k)?;
    }
    cur.as_str().filter(|s| !s.is_empty())
}

fn num_at(v: &Value, path: &[&str]) -> Option<f64> {
    let mut cur = v;
    for k in path {
        cur = cur.get(k)?;
    }
    cur.as_f64()
}

/// Read chips from the statusLine stdin JSON. Every field is optional and every shape is
/// tolerated; unknown or missing fields give `None`.
#[must_use]
pub fn chips_from_payload(v: &Value) -> Chips {
    let model = str_at(v, &["model", "display_name"])
        .or_else(|| str_at(v, &["model", "id"]))
        .or_else(|| v.get("model").and_then(Value::as_str))
        .map(str::to_owned);
    let context_pct = num_at(v, &["context_window", "used_percentage"])
        .or_else(|| {
            let cw = v.get("context_window")?;
            let size = cw.get("context_window_size")?.as_f64()?;
            let cur = cw.get("current_usage").filter(|c| c.is_object())?;
            let used = [
                "input_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            ]
            .iter()
            .filter_map(|k| cur.get(k).and_then(Value::as_f64))
            .fold(0.0, |a, b| a + b);
            (size > 0.0).then(|| used / size * 100.0)
        })
        .map(|p| (p * 10.0).round() / 10.0);
    let cost = num_at(v, &["cost", "total_cost_usd"]);
    let mode = str_at(v, &["permission_mode"])
        .or_else(|| str_at(v, &["permissionMode"]))
        .map(str::to_owned);
    let worktree = str_at(v, &["worktree", "name"])
        .or_else(|| str_at(v, &["workspace", "git_worktree"]))
        .map(str::to_owned);
    let pr_url = str_at(v, &["pr", "url"])
        .or_else(|| str_at(v, &["pull_request", "url"]))
        .map(str::to_owned);
    Chips {
        model,
        context_pct,
        cost,
        mode,
        worktree,
        pr_url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(path: &Path, v: &Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, v.to_string()).unwrap();
    }

    fn sl(cmd: &str) -> Value {
        json!({"statusLine": {"type": "command", "command": cmd, "padding": 2}})
    }

    #[test]
    fn precedence_is_local_then_project_then_user() {
        let t = tempfile::tempdir().unwrap();
        let proj = t.path().join("proj");
        let cfg = t.path().join("cfg");
        write(&cfg.join("settings.json"), &sl("user-cmd"));
        let dirs = vec![proj.clone()];
        let got = resolve_user_status_line(&dirs, Some(&cfg)).unwrap();
        assert_eq!(got.command, "user-cmd");
        assert_eq!(got.padding, Some(2));
        write(&proj.join(".claude/settings.json"), &sl("project-cmd"));
        assert_eq!(
            resolve_user_status_line(&dirs, Some(&cfg)).unwrap().command,
            "project-cmd"
        );
        write(&proj.join(".claude/settings.local.json"), &sl("local-cmd"));
        assert_eq!(
            resolve_user_status_line(&dirs, Some(&cfg)).unwrap().command,
            "local-cmd"
        );
    }

    #[test]
    fn non_command_empty_and_broken_settings_are_ignored() {
        let t = tempfile::tempdir().unwrap();
        let cfg = t.path().join("cfg");
        write(
            &cfg.join("settings.json"),
            &json!({"statusLine": {"type": "text"}}),
        );
        assert!(resolve_user_status_line(&[], Some(&cfg)).is_none());
        write(&cfg.join("settings.json"), &sl("  "));
        assert!(resolve_user_status_line(&[], Some(&cfg)).is_none());
        std::fs::write(cfg.join("settings.json"), "{ nope").unwrap();
        assert!(resolve_user_status_line(&[], Some(&cfg)).is_none());
        assert!(resolve_user_status_line(&[], None).is_none());
    }

    #[test]
    fn config_dir_prefers_the_env_override() {
        assert_eq!(
            config_dir(Some("/x"), Some(Path::new("/home/u"))),
            Some(PathBuf::from("/x"))
        );
        assert_eq!(
            config_dir(Some(""), Some(Path::new("/home/u"))),
            Some(PathBuf::from("/home/u/.claude"))
        );
        assert_eq!(config_dir(None, None), None);
    }

    #[test]
    fn project_dirs_come_from_workspace_then_cwd() {
        let v = json!({"cwd": "/a", "workspace": {"project_dir": "/p", "current_dir": "/a"}});
        assert_eq!(
            project_dirs_from_payload(&v),
            vec![PathBuf::from("/p"), PathBuf::from("/a")]
        );
        assert!(project_dirs_from_payload(&json!({})).is_empty());
    }

    #[test]
    fn chips_are_read_tolerantly() {
        let v = json!({
            "model": {"id": "claude-haiku-4", "display_name": "Haiku"},
            "cost": {"total_cost_usd": 0.0123},
            "context_window": {"used_percentage": 12.34},
        });
        let c = chips_from_payload(&v);
        assert_eq!(c.model.as_deref(), Some("Haiku"));
        assert_eq!(c.cost, Some(0.0123));
        assert_eq!(c.context_pct, Some(12.3));
        let v = json!({"context_window": {"context_window_size": 200000,
            "current_usage": {"input_tokens": 1000, "cache_read_input_tokens": 19000}}});
        assert_eq!(chips_from_payload(&v).context_pct, Some(10.0));
        assert_eq!(chips_from_payload(&json!(null)), Chips::default());
        // A fresh session reports null usage: no percentage, and never "-0".
        let fresh = json!({"context_window": {"context_window_size": 1000000,
            "current_usage": null, "used_percentage": null}});
        assert_eq!(chips_from_payload(&fresh).context_pct, None);
        assert_eq!(
            chips_from_payload(&json!({"model": "plain"}))
                .model
                .as_deref(),
            Some("plain")
        );
    }

    #[test]
    fn fill_from_keeps_existing_values() {
        let mut a = Chips {
            model: Some("A".into()),
            ..Chips::default()
        };
        let b = Chips {
            model: Some("B".into()),
            mode: Some("plan".into()),
            ..Chips::default()
        };
        a.fill_from(&b);
        assert_eq!(a.model.as_deref(), Some("A"));
        assert_eq!(a.mode.as_deref(), Some("plan"));
    }
}
