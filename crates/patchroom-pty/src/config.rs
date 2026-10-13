//! Spawn configuration and environment construction.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

/// Default delay between a bracketed paste and the Enter that submits it
/// (spike: a long prompt plus `\r` in one write is taken as paste).
pub const DEFAULT_ENTER_DELAY: Duration = Duration::from_millis(400);

/// What to run inside the login shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// A program and its arguments. Each word is shell-quoted and the shell
    /// `exec`s the program, so the PTY child pid is the program's pid.
    Program {
        /// Program name or path. Resolved with the login shell's `PATH`.
        program: String,
        /// Arguments, passed verbatim.
        args: Vec<String>,
    },
    /// A raw shell command line, run as `$SHELL -l -c "<line>"` with no
    /// quoting applied.
    Shell(String),
}

impl Command {
    /// Build a [`Command::Program`].
    pub fn program<P, I, S>(program: P, args: I) -> Self
    where
        P: Into<String>,
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Command::Program {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }

    /// The script handed to `$SHELL -l -c`.
    #[must_use]
    pub fn script(&self) -> String {
        match self {
            Command::Shell(line) => line.clone(),
            Command::Program { program, args } => {
                let mut s = String::from("exec ");
                s.push_str(&shell_quote(program));
                for a in args {
                    s.push(' ');
                    s.push_str(&shell_quote(a));
                }
                s
            }
        }
    }
}

/// Quote one word for POSIX shells.
#[must_use]
pub fn shell_quote(word: &str) -> String {
    let safe = !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-./=:,+@%".contains(&b));
    if safe {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// Everything needed to start a session.
#[derive(Debug, Clone)]
pub struct SpawnConfig {
    /// What to run.
    pub command: Command,
    /// Working directory. Defaults to the host's current directory.
    pub cwd: Option<PathBuf>,
    /// Extra environment. Applied after inherited env is filtered and may set
    /// `CLAUDE*` names on purpose (for example `CLAUDE_CONFIG_DIR`).
    pub env: BTreeMap<String, String>,
    /// Value of `PATCHROOM_SESSION` for scripts and hooks.
    pub session_id: String,
    /// Initial rows.
    pub rows: u16,
    /// Initial columns.
    pub cols: u16,
    /// Shell used for the login wrapper. Defaults to `$SHELL`, then `/bin/zsh`
    /// on macOS or `/bin/sh` elsewhere.
    pub shell: Option<PathBuf>,
    /// Delay between paste and Enter in [`crate::Session::send_text`].
    pub enter_delay: Duration,
    /// Answer DA1 and XTVERSION queries from the host. Leave `false` when an
    /// emulator such as xterm.js is attached and answers them itself.
    pub reply_to_terminal_queries: bool,
    /// How long [`crate::Session::kill`] waits after SIGTERM before SIGKILL.
    pub kill_grace: Duration,
}

impl SpawnConfig {
    /// A config with defaults: 120x40, 400ms enter delay, no query replies.
    pub fn new(command: Command, session_id: impl Into<String>) -> Self {
        Self {
            command,
            cwd: None,
            env: BTreeMap::new(),
            session_id: session_id.into(),
            rows: 40,
            cols: 120,
            shell: None,
            enter_delay: DEFAULT_ENTER_DELAY,
            reply_to_terminal_queries: false,
            kill_grace: Duration::from_secs(2),
        }
    }

    pub(crate) fn resolve_shell(&self) -> PathBuf {
        if let Some(s) = &self.shell {
            return s.clone();
        }
        match std::env::var("SHELL") {
            Ok(s) if !s.is_empty() => PathBuf::from(s),
            _ if cfg!(target_os = "macos") => PathBuf::from("/bin/zsh"),
            _ => PathBuf::from("/bin/sh"),
        }
    }
}

/// True for inherited variables that must not reach the child: anything whose
/// name starts with `CLAUDE`. `CLAUDE_CODE_CHILD_SESSION` in particular turns
/// transcript saving off in the child.
#[must_use]
pub fn is_stripped_env(name: &str) -> bool {
    name.starts_with("CLAUDE")
}

/// Compute the child environment from an inherited environment.
///
/// Inherited `CLAUDE*` names are dropped. `TERM`, `COLORTERM`,
/// `PATCHROOM_SESSION` and (when known) `PATCHROOM_TTY` are then forced, and
/// `cfg.env` is applied on top of the filtered base.
pub fn build_env<I>(inherited: I, cfg: &SpawnConfig, tty: Option<&str>) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut env: BTreeMap<String, String> = inherited
        .into_iter()
        .filter(|(k, _)| !is_stripped_env(k))
        .collect();
    env.extend(cfg.env.clone());
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env.insert("PATCHROOM_SESSION".into(), cfg.session_id.clone());
    match tty {
        Some(t) => {
            env.insert("PATCHROOM_TTY".into(), t.to_owned());
        }
        None => {
            env.remove("PATCHROOM_TTY");
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> SpawnConfig {
        SpawnConfig::new(Command::program("claude", ["--version"]), "sess-1")
    }

    #[test]
    fn quotes_words() {
        assert_eq!(shell_quote("abc-1.2/x"), "abc-1.2/x");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("$(rm -rf /)"), "'$(rm -rf /)'");
    }

    #[test]
    fn program_script_execs_quoted() {
        let c = Command::program("claude", ["--model", "haiku", "hello world"]);
        assert_eq!(c.script(), "exec claude --model haiku 'hello world'");
    }

    #[test]
    fn env_strips_claude_and_forces_terminal_vars() {
        let inherited = [
            ("CLAUDE_CODE_CHILD_SESSION", "1"),
            ("CLAUDECODE", "1"),
            ("PATH", "/bin"),
            ("TERM", "dumb"),
            ("PATCHROOM_TTY", "stale"),
        ]
        .map(|(k, v)| (k.to_owned(), v.to_owned()));
        let env = build_env(inherited, &cfg(), Some("/dev/ttys009"));
        assert!(!env.keys().any(|k| k.starts_with("CLAUDE")));
        assert_eq!(env["PATH"], "/bin");
        assert_eq!(env["TERM"], "xterm-256color");
        assert_eq!(env["COLORTERM"], "truecolor");
        assert_eq!(env["PATCHROOM_TTY"], "/dev/ttys009");
        assert_eq!(env["PATCHROOM_SESSION"], "sess-1");
    }

    #[test]
    fn explicit_env_may_set_claude_names() {
        let mut c = cfg();
        c.env.insert("CLAUDE_CONFIG_DIR".into(), "/x".into());
        let env = build_env([("CLAUDE_OLD".to_owned(), "1".to_owned())], &c, None);
        assert_eq!(env["CLAUDE_CONFIG_DIR"], "/x");
        assert!(!env.contains_key("CLAUDE_OLD"));
        assert!(!env.contains_key("PATCHROOM_TTY"));
    }
}
