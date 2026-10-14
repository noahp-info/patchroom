//! Per-launch `--settings` JSON that registers `patchroom-hook`.
//!
//! The generator is pure: it returns a JSON value or string and never reads or writes any
//! settings file. It registers the hooks and, optionally, the statusLine wrapper. Pass the result to the CLI as `--settings <json>`. Combined with
//! `--setting-sources`, the user's own settings files stay untouched.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

/// Extra time the hook waits beyond the bridge's own bound, so the bridge always speaks first.
pub const HOOK_SLACK: Duration = Duration::from_secs(3);

/// Everything needed to register the hook binary for one launch.
#[derive(Debug, Clone)]
pub struct HookSettings {
    /// Absolute path of the `patchroom-hook` binary.
    pub hook_binary: PathBuf,
    /// Bridge socket path.
    pub socket_path: PathBuf,
    /// Patchroom's key for the session, passed to every hook.
    pub session_key: Option<String>,
    /// Bridge-side bound for PermissionRequest. Must match `BridgeConfig::permission_wait`.
    pub permission_wait: Duration,
    /// Bridge-side bound for AskUserQuestion. Must match `BridgeConfig::ask_wait`.
    pub ask_wait: Duration,
    /// The statusLine wrapper, when the launch should tee the status line to the bridge.
    pub statusline: Option<StatuslineWrap>,
}

/// The statusLine wrapper registered through `--settings`.
///
/// `--settings` outranks the user's settings files, so claude runs the wrapper in place
/// of the user's `statusLine`. The wrapper looks the user's command up itself on every
/// render (see [`crate::statusline`]) and runs it unchanged.
#[derive(Debug, Clone)]
pub struct StatuslineWrap {
    /// Absolute path of the `patchroom-statusline` binary.
    pub binary: PathBuf,
    /// `padding` copied from the user's own `statusLine`, so the TUI layout is unchanged.
    pub padding: Option<i64>,
}

/// Quote a string for a POSIX shell with single quotes.
pub fn shell_quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+=:,@%".contains(c))
    {
        return s.to_owned();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

impl HookSettings {
    /// Settings with the bridge defaults for the two waits.
    pub fn new(hook_binary: impl Into<PathBuf>, socket_path: impl Into<PathBuf>) -> Self {
        let defaults = crate::BridgeConfig::default();
        Self {
            hook_binary: hook_binary.into(),
            socket_path: socket_path.into(),
            session_key: None,
            permission_wait: defaults.permission_wait,
            ask_wait: defaults.ask_wait,
            statusline: None,
        }
    }

    /// Also register the statusLine wrapper.
    pub fn with_statusline(mut self, binary: impl Into<PathBuf>, padding: Option<i64>) -> Self {
        self.statusline = Some(StatuslineWrap {
            binary: binary.into(),
            padding,
        });
        self
    }

    /// Set the Patchroom session key.
    pub fn with_session_key(mut self, key: impl Into<String>) -> Self {
        self.session_key = Some(key.into());
        self
    }

    fn command(&self, wait: Duration) -> String {
        let mut cmd = format!(
            "{} --socket {} --wait-ms {}",
            shell_quote(&path_str(&self.hook_binary)),
            shell_quote(&path_str(&self.socket_path)),
            wait.as_millis()
        );
        if let Some(k) = &self.session_key {
            cmd.push_str(" --session-key ");
            cmd.push_str(&shell_quote(k));
        }
        cmd
    }

    fn statusline_value(&self) -> Option<Value> {
        let wrap = self.statusline.as_ref()?;
        let mut cmd = format!(
            "{} --socket {}",
            shell_quote(&path_str(&wrap.binary)),
            shell_quote(&path_str(&self.socket_path)),
        );
        if let Some(k) = &self.session_key {
            cmd.push_str(" --session-key ");
            cmd.push_str(&shell_quote(k));
        }
        let mut v = json!({"type": "command", "command": cmd});
        if let Some(p) = wrap.padding {
            v["padding"] = json!(p);
        }
        Some(v)
    }

    fn entry(&self, matcher: Option<&str>, wait: Duration, timeout: Duration) -> Value {
        let mut e = json!({
            "hooks": [{
                "type": "command",
                "command": self.command(wait),
                "timeout": timeout.as_secs().max(1),
            }]
        });
        if let Some(m) = matcher {
            e["matcher"] = json!(m);
        }
        e
    }

    /// The settings object: `{"hooks": {...}}`.
    pub fn to_value(&self) -> Value {
        let quick = Duration::from_secs(2);
        let quick_timeout = Duration::from_secs(10);
        let perm_timeout = self.permission_wait + HOOK_SLACK + Duration::from_secs(5);
        let ask_timeout = self.ask_wait + HOOK_SLACK + Duration::from_secs(5);
        let mut settings = json!({
            "hooks": {
                "PermissionRequest": [self.entry(None, self.permission_wait + HOOK_SLACK, perm_timeout)],
                "PreToolUse": [self.entry(Some("AskUserQuestion|ExitPlanMode"), self.ask_wait + HOOK_SLACK, ask_timeout)],
                "PostToolUse": [self.entry(None, quick, quick_timeout)],
                "Notification": [self.entry(None, quick, quick_timeout)],
                "Stop": [self.entry(None, quick, quick_timeout)],
                "UserPromptSubmit": [self.entry(None, quick, quick_timeout)],
                "SessionStart": [self.entry(None, quick, quick_timeout)],
            }
        });
        if let Some(sl) = self.statusline_value() {
            settings["statusLine"] = sl;
        }
        settings
    }

    /// The settings as a compact JSON string.
    pub fn to_json_string(&self) -> String {
        self.to_value().to_string()
    }

    /// CLI arguments to append: `["--settings", "<json>"]`.
    pub fn cli_args(&self) -> Vec<String> {
        vec!["--settings".into(), self.to_json_string()]
    }
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_every_required_event() {
        let s = HookSettings::new("/opt/pr/patchroom-hook", "/tmp/b.sock").with_session_key("dm-1");
        let v = s.to_value();
        let hooks = v["hooks"].as_object().unwrap();
        for ev in [
            "PermissionRequest",
            "PreToolUse",
            "PostToolUse",
            "Notification",
            "Stop",
            "UserPromptSubmit",
            "SessionStart",
        ] {
            assert!(hooks.contains_key(ev), "missing {ev}");
        }
        assert_eq!(hooks.len(), 7);
        assert_eq!(
            hooks["PreToolUse"][0]["matcher"],
            "AskUserQuestion|ExitPlanMode"
        );
        let cmd = hooks["PermissionRequest"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(cmd.starts_with("/opt/pr/patchroom-hook --socket /tmp/b.sock --wait-ms "));
        assert!(cmd.ends_with("--session-key dm-1"));
        // Only hooks: no permissions, no statusLine, nothing that overrides user config.
        assert_eq!(v.as_object().unwrap().len(), 1);
    }

    #[test]
    fn statusline_wrapper_is_registered_only_when_asked() {
        let plain = HookSettings::new("/h", "/s");
        assert!(plain.to_value().get("statusLine").is_none());
        let s = HookSettings::new("/h", "/my sock")
            .with_session_key("dm-1")
            .with_statusline("/opt/pr/patchroom-statusline", Some(3));
        let v = s.to_value();
        assert_eq!(v["statusLine"]["type"], "command");
        assert_eq!(v["statusLine"]["padding"], 3);
        assert_eq!(
            v["statusLine"]["command"],
            "/opt/pr/patchroom-statusline --socket '/my sock' --session-key dm-1"
        );
        let v = HookSettings::new("/h", "/s")
            .with_statusline("/w", None)
            .to_value();
        assert!(v["statusLine"].get("padding").is_none());
    }

    #[test]
    fn quotes_awkward_paths() {
        assert_eq!(shell_quote("/a b/it's"), r"'/a b/it'\''s'");
        assert_eq!(shell_quote("plain-1_2/x"), "plain-1_2/x");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn cli_args_carry_valid_json() {
        let s = HookSettings::new("/h", "/s");
        let args = s.cli_args();
        assert_eq!(args[0], "--settings");
        serde_json::from_str::<Value>(&args[1]).unwrap();
    }
}
