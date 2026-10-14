//! Read-only detection of the user's own sound hooks.
//!
//! Claude Code runs command hooks from three settings files: the user's
//! (`<config dir>/settings.json`), the project's (`<project>/.claude/settings.json`) and the
//! project's local one (`<project>/.claude/settings.local.json`). This module reads them,
//! never writes them, and reports every command hook that plays audio (`afplay`, `say`,
//! `paplay`, `osascript ... beep`, and a few relatives) per hook event.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// Programs that play a sound when run.
const AUDIO_PROGRAMS: [&str; 12] = [
    "afplay",
    "say",
    "paplay",
    "aplay",
    "play",
    "ffplay",
    "mpg123",
    "mpv",
    "canberra-gtk-play",
    "spd-say",
    "espeak",
    "pw-play",
];

/// Words that may precede the real program in a command.
const PREFIXES: [&str; 8] = [
    "nohup", "sudo", "exec", "command", "time", "nice", "env", "setsid",
];

/// Largest wrapper script that is scanned, in bytes.
const MAX_SCRIPT_BYTES: u64 = 256 * 1024;

/// How deep wrapper scripts and `sh -c` strings nest before the scan stops.
const MAX_DEPTH: u8 = 3;

/// Longest command text reported.
const MAX_COMMAND_CHARS: usize = 300;

/// One audio hook found in a settings file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DetectedHook {
    /// Claude hook event name, for example `Stop`.
    pub event: String,
    /// The command, trimmed.
    pub command: String,
    /// Which file: `user`, `project` or `local`.
    pub source: String,
    /// The settings file it came from.
    pub path: String,
}

/// Does this shell command play audio?
#[must_use]
pub fn plays_audio(command: &str) -> bool {
    plays_audio_depth(command, 0)
}

fn plays_audio_depth(command: &str, depth: u8) -> bool {
    // `${HOME}` would be cut apart at the braces below.
    command
        .replace("${HOME}", "$HOME")
        .split([';', '&', '|', '\n', '(', ')', '{', '}', '`'])
        .any(|segment| segment_plays_audio(segment, depth))
}

fn unquote(w: &str) -> &str {
    w.trim_matches(|c| c == '"' || c == '\'')
}

fn segment_plays_audio(segment: &str, depth: u8) -> bool {
    let mut words = segment.split_whitespace().map(unquote).peekable();
    // Skip `VAR=value` assignments, `nohup`, `sudo` and its flags, and so on.
    while let Some(w) = words.peek().copied() {
        let assignment = w.contains('=') && !w.contains('/') && !w.starts_with('-');
        let flag = w.starts_with('-');
        if assignment || flag || PREFIXES.contains(&w) {
            words.next();
        } else {
            break;
        }
    }
    let Some(first) = words.next() else {
        return false;
    };
    let program = first.rsplit('/').next().unwrap_or(first);
    if AUDIO_PROGRAMS.contains(&program) {
        return true;
    }
    let rest: Vec<&str> = words.collect();
    if depth < MAX_DEPTH && script_plays_audio(first, depth) {
        return true;
    }
    match program {
        "osascript" => rest.iter().any(|w| {
            let w = w.to_lowercase();
            w.contains("beep") || w.contains("sound")
        }),
        "terminal-notifier" => rest.iter().any(|w| w.eq_ignore_ascii_case("-sound")),
        "sh" | "bash" | "zsh" | "dash" if depth < MAX_DEPTH => {
            if let Some(i) = rest.iter().position(|w| *w == "-c") {
                plays_audio_depth(&rest[i + 1..].join(" "), depth + 1)
            } else {
                // `bash /path/script.sh args`: the first non-flag word is the script.
                rest.iter()
                    .find(|w| !w.starts_with('-'))
                    .is_some_and(|w| script_plays_audio(w, depth))
            }
        }
        _ => false,
    }
}

/// Expand a leading `~`, `$HOME` or `${HOME}` using the process environment.
fn expand_home(word: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    for prefix in ["~/", "$HOME/"] {
        if let Some(rest) = word.strip_prefix(prefix) {
            return home.map(|h| h.join(rest));
        }
    }
    if word.starts_with('/') {
        return Some(PathBuf::from(word));
    }
    None
}

/// Is `word` a readable script file whose text plays audio? The file is read only. Wrapper
/// scripts such as `play.sh stop` that call `afplay` inside are the common case.
fn script_plays_audio(word: &str, depth: u8) -> bool {
    if !word.contains('/') {
        return false;
    }
    let Some(path) = expand_home(word) else {
        return false;
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > MAX_SCRIPT_BYTES {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    let code: String = text
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    plays_audio_depth(&code, depth + 1)
}

/// Command hooks that play audio in one settings document.
fn hooks_in(doc: &Value, source: &str, path: &Path, out: &mut Vec<DetectedHook>) {
    if doc.get("disableAllHooks").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let Some(events) = doc.get("hooks").and_then(Value::as_object) else {
        return;
    };
    for (event, groups) in events {
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for group in groups {
            // `{matcher, hooks: [..]}` groups, or a flat list of hooks.
            let list = group
                .get("hooks")
                .and_then(Value::as_array)
                .map_or_else(|| std::slice::from_ref(group), Vec::as_slice);
            for hook in list {
                let is_command = hook
                    .get("type")
                    .and_then(Value::as_str)
                    .is_none_or(|t| t == "command");
                let Some(cmd) = hook.get("command").and_then(Value::as_str) else {
                    continue;
                };
                if is_command && plays_audio(cmd) {
                    out.push(DetectedHook {
                        event: event.clone(),
                        command: cmd.trim().chars().take(MAX_COMMAND_CHARS).collect(),
                        source: source.to_owned(),
                        path: path.to_string_lossy().into_owned(),
                    });
                }
            }
        }
    }
}

/// Scan the user's settings in `config_dir` and the project and local settings of each of
/// `project_dirs` for audio command hooks. Unreadable or malformed files are skipped. The
/// same file is read once however many projects name it. Nothing is written.
#[must_use]
pub fn detect_sound_hooks(
    config_dir: Option<&Path>,
    project_dirs: &[PathBuf],
) -> Vec<DetectedHook> {
    let mut files: Vec<(&str, PathBuf)> = Vec::new();
    if let Some(c) = config_dir {
        files.push(("user", c.join("settings.json")));
    }
    for p in project_dirs {
        files.push(("project", p.join(".claude").join("settings.json")));
        files.push(("local", p.join(".claude").join("settings.local.json")));
    }
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut out = Vec::new();
    for (source, path) in files {
        let key = path.canonicalize().unwrap_or_else(|_| path.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(doc) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        hooks_in(&doc, source, &path, &mut out);
    }
    out
}

/// The Claude hook events that Patchroom's `event` duplicates.
#[must_use]
pub fn hook_events_for(event: &str) -> &'static [&'static str] {
    match event {
        "needs" => &["Notification", "PermissionRequest", "Elicitation"],
        "done" => &["Stop", "TaskCompleted"],
        "error" => &["StopFailure"],
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn detect(doc: &Value) -> Vec<DetectedHook> {
        let mut out = Vec::new();
        hooks_in(doc, "user", Path::new("/x/settings.json"), &mut out);
        out
    }

    #[test]
    fn recognises_audio_commands() {
        for yes in [
            "afplay /System/Library/Sounds/Glass.aiff",
            "/usr/bin/afplay -v 0.5 x.aiff &",
            "nohup afplay x.aiff >/dev/null 2>&1 &",
            "say 'done'",
            "paplay /usr/share/sounds/x.oga",
            "osascript -e 'beep'",
            "osascript -e 'beep 2'",
            "osascript -e 'tell app \"System Events\" to beep'",
            "osascript -e 'display notification \"x\" sound name \"Glass\"'",
            "FOO=1 afplay x.aiff",
            "echo hi; afplay x.aiff",
            "test -f x && afplay x.aiff",
            "bash -c 'afplay x.aiff'",
            "sh -c \"say hello\"",
            "terminal-notifier -message hi -sound default",
            "(afplay x.aiff &)",
        ] {
            assert!(plays_audio(yes), "{yes}");
        }
    }

    #[test]
    fn follows_wrapper_scripts_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let play = dir.path().join("play.sh");
        std::fs::write(
            &play,
            "#!/bin/bash\n# afplay in a comment only\nEVENT=\"$1\"\n[ -z \"$EVENT\" ] && exit 0\n/usr/bin/afplay -v 1 \"$SOUND\" 2>/dev/null\nexit 0\n",
        )
        .unwrap();
        let quiet = dir.path().join("quiet.sh");
        std::fs::write(
            &quiet,
            "#!/bin/bash\n# afplay is only named here\necho hi\n",
        )
        .unwrap();
        let outer = dir.path().join("outer.sh");
        std::fs::write(&outer, format!("#!/bin/sh\n{} stop\n", play.display())).unwrap();
        let before = std::fs::read(&play).unwrap();
        let p = play.display();
        assert!(plays_audio(&format!("{p} stop")));
        assert!(plays_audio(&format!("'{p}' task")));
        assert!(plays_audio(&format!("bash {p} session")));
        assert!(plays_audio(&format!("bash -c '{p} stop'")));
        assert!(plays_audio(&format!("{} go", outer.display())), "depth 2");
        assert!(!plays_audio(&format!("{} stop", quiet.display())));
        assert!(!plays_audio(&format!(
            "{}/missing.sh stop",
            dir.path().display()
        )));
        assert_eq!(before, std::fs::read(&play).unwrap());
        // A script that calls itself terminates at the depth limit.
        let looping = dir.path().join("loop.sh");
        std::fs::write(&looping, format!("{} again\n", looping.display())).unwrap();
        assert!(!plays_audio(&looping.display().to_string()));
    }

    #[test]
    fn expands_home_in_wrapper_paths() {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            return;
        };
        let dir = tempfile::Builder::new()
            .prefix("pr-hook-test-")
            .tempdir_in(&home);
        let Ok(dir) = dir else { return };
        std::fs::write(dir.path().join("w.sh"), "afplay x.aiff\n").unwrap();
        let name = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(plays_audio(&format!("$HOME/{name}/w.sh stop")));
        assert!(plays_audio(&format!("~/{name}/w.sh stop")));
        assert!(plays_audio(&format!("${{HOME}}/{name}/w.sh stop")));
    }

    #[test]
    fn ignores_other_commands() {
        for no in [
            "",
            "echo afplay",
            "git commit -m 'say hello'",
            "cat say",
            "./scripts/say-hi.sh",
            "osascript -e 'display notification \"x\"'",
            "terminal-notifier -message hi",
            "prettier --write .",
            "bash -c 'echo hi'",
            "python3 play.py",
        ] {
            assert!(!plays_audio(no), "{no}");
        }
    }

    #[test]
    fn reads_matcher_groups_and_flat_lists_per_event() {
        let doc = json!({
            "hooks": {
                "Stop": [{"hooks": [
                    {"type": "command", "command": "afplay /s/a.aiff"},
                    {"type": "command", "command": "echo logged"}
                ]}],
                "TaskCompleted": [{"matcher": "", "hooks": [{"type": "command", "command": "say done"}]}],
                "Notification": [{"type": "command", "command": "osascript -e 'beep'"}],
                "SessionStart": [{"hooks": [{"type": "command", "command": "afplay /s/b.aiff"}]}],
                "PreToolUse": [{"hooks": [{"type": "command", "command": "./check.sh"}]}],
                "PostToolUse": [{"hooks": [{"type": "prompt", "command": "afplay ignored"}]}]
            }
        });
        let got: Vec<(String, String)> = detect(&doc)
            .into_iter()
            .map(|h| (h.event, h.command))
            .collect();
        for want in [
            ("Stop", "afplay /s/a.aiff"),
            ("TaskCompleted", "say done"),
            ("Notification", "osascript -e 'beep'"),
            ("SessionStart", "afplay /s/b.aiff"),
        ] {
            assert!(
                got.contains(&(want.0.into(), want.1.into())),
                "{want:?} in {got:?}"
            );
        }
        assert_eq!(got.len(), 4, "{got:?}");
    }

    #[test]
    fn disable_all_hooks_and_missing_sections_report_nothing() {
        assert!(detect(&json!({"disableAllHooks": true, "hooks": {"Stop": [{"hooks": [{"type":"command","command":"afplay x"}]}]}})).is_empty());
        assert!(detect(&json!({})).is_empty());
        assert!(detect(&json!({"hooks": []})).is_empty());
        assert!(detect(&json!({"hooks": {"Stop": "afplay x"}})).is_empty());
    }

    fn write(path: &Path, v: &Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, v.to_string()).unwrap();
    }

    fn stop_hook(cmd: &str) -> Value {
        json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": cmd}]}]}})
    }

    #[test]
    fn reads_user_project_and_local_files_without_modifying_them() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("cfg");
        let proj = dir.path().join("proj");
        write(&cfg.join("settings.json"), &stop_hook("afplay user.aiff"));
        write(
            &proj.join(".claude/settings.json"),
            &stop_hook("say project"),
        );
        write(
            &proj.join(".claude/settings.local.json"),
            &json!({"hooks": {"Notification": [{"hooks": [{"type": "command", "command": "paplay local.oga"}]}]}}),
        );
        let before: Vec<Vec<u8>> = [
            cfg.join("settings.json"),
            proj.join(".claude/settings.json"),
            proj.join(".claude/settings.local.json"),
        ]
        .iter()
        .map(|p| std::fs::read(p).unwrap())
        .collect();
        let got = detect_sound_hooks(Some(&cfg), &[proj.clone(), proj.clone()]);
        let sources: Vec<(&str, &str, &str)> = got
            .iter()
            .map(|h| (h.source.as_str(), h.event.as_str(), h.command.as_str()))
            .collect();
        assert_eq!(
            sources,
            vec![
                ("user", "Stop", "afplay user.aiff"),
                ("project", "Stop", "say project"),
                ("local", "Notification", "paplay local.oga"),
            ]
        );
        let after: Vec<Vec<u8>> = [
            cfg.join("settings.json"),
            proj.join(".claude/settings.json"),
            proj.join(".claude/settings.local.json"),
        ]
        .iter()
        .map(|p| std::fs::read(p).unwrap())
        .collect();
        assert_eq!(before, after, "files are only read");
        assert!(got[0].path.ends_with("cfg/settings.json"));
    }

    #[test]
    fn wrapper_script_fixture_detects_stop_task_and_session() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("cfg");
        let sounds = cfg.join("sounds");
        std::fs::create_dir_all(&sounds).unwrap();
        std::fs::write(
            sounds.join("play.sh"),
            "#!/bin/bash\nEVENT=\"$1\"\ncase \"$EVENT\" in\n  stop) SOUND=a ;;\n  *) exit 0 ;;\nesac\n/usr/bin/afplay -v \"$VOLUME\" \"$SOUND\" 2>/dev/null\nexit 0\n",
        )
        .unwrap();
        let cmd = |arg: &str| format!("{}/play.sh {arg}", sounds.display());
        let group = |arg: &str| json!([{"hooks": [{"type": "command", "command": cmd(arg)}]}]);
        write(
            &cfg.join("settings.json"),
            &json!({"hooks": {
                "SessionStart": group("session"),
                "TaskCompleted": group("task"),
                "Stop": group("stop"),
                "PreToolUse": [{"hooks": [{"type": "command", "command": "./check.sh"}]}]
            }}),
        );
        let mut events: Vec<String> = detect_sound_hooks(Some(&cfg), &[])
            .into_iter()
            .map(|h| h.event)
            .collect();
        events.sort();
        assert_eq!(events, ["SessionStart", "Stop", "TaskCompleted"]);
    }

    /// Read-only check against the machine's real settings: `cargo test -- --ignored real_`.
    #[test]
    #[ignore = "reads the real ~/.claude/settings.json"]
    fn real_user_settings_report_hooks() {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            return;
        };
        let found = detect_sound_hooks(Some(&home.join(".claude")), &[]);
        let events: Vec<&str> = found.iter().map(|h| h.event.as_str()).collect();
        eprintln!("detected: {events:?}");
        assert!(
            !events.is_empty(),
            "expected audio hooks in the real settings"
        );
    }

    #[test]
    fn missing_and_malformed_files_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("cfg");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join("settings.json"), "{ not json").unwrap();
        assert!(detect_sound_hooks(Some(&cfg), &[dir.path().join("nope")]).is_empty());
        assert!(detect_sound_hooks(None, &[]).is_empty());
    }

    #[test]
    fn long_commands_are_trimmed() {
        let long = format!("afplay {}", "x".repeat(1000));
        let got = detect(&stop_hook(&long));
        assert_eq!(got[0].command.chars().count(), MAX_COMMAND_CHARS);
    }

    #[test]
    fn patchroom_events_map_to_claude_hook_events() {
        assert!(hook_events_for("done").contains(&"Stop"));
        assert!(hook_events_for("needs").contains(&"Notification"));
        assert!(hook_events_for("bell").is_empty());
    }
}
