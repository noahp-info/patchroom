//! `claude agents --json` reconciliation.
//!
//! Hooks give instant status. `claude agents --json` is the ground truth the bridge checks
//! every few seconds, and on demand after a missed hook. It lists every live interactive
//! session on the machine, so entries are filtered to the sessions Patchroom tracks, by
//! pid or session id.

use std::io::{self, Read};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::events::{NeedsKind, Status};

/// One entry of `claude agents --json`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AgentEntry {
    /// Process id of the CLI.
    #[serde(default)]
    pub pid: u32,
    /// Working directory.
    #[serde(default)]
    pub cwd: String,
    /// Kind, `interactive` for TUI sessions.
    #[serde(default)]
    pub kind: String,
    /// Session id.
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    /// Session name.
    #[serde(default)]
    pub name: Option<String>,
    /// `idle`, `busy` or `waiting`.
    #[serde(default)]
    pub status: String,
    /// What a `waiting` session waits for: `permission prompt`, `input needed`, ...
    #[serde(default, rename = "waitingFor")]
    pub waiting_for: Option<String>,
}

impl AgentEntry {
    /// Map the CLI's status vocabulary to the bridge's. `None` for unknown values.
    pub fn to_status(&self) -> Option<Status> {
        match self.status.as_str() {
            "idle" => Some(Status::Idle),
            "busy" => Some(Status::Busy),
            "waiting" => Some(Status::NeedsYou(match self.waiting_for.as_deref() {
                Some("permission prompt") => NeedsKind::Permission,
                Some("input needed") => NeedsKind::Question,
                _ => NeedsKind::Other,
            })),
            _ => None,
        }
    }
}

/// Parse the JSON array printed by `claude agents --json`.
pub fn parse_agents(json: &str) -> Result<Vec<AgentEntry>, serde_json::Error> {
    serde_json::from_str(json)
}

/// Source of agent listings. The real one runs the CLI; tests substitute a fixed list.
pub trait AgentsSource: Send + Sync + 'static {
    /// List live sessions.
    fn list(&self) -> io::Result<Vec<AgentEntry>>;
}

/// Runs `<program> agents --json` with a hard timeout and kills it on expiry.
#[derive(Debug, Clone)]
pub struct CommandAgentsSource {
    /// Program to run, normally `claude`.
    pub program: String,
    /// Kill the child after this long.
    pub timeout: Duration,
}

impl Default for CommandAgentsSource {
    fn default() -> Self {
        Self {
            program: "claude".into(),
            timeout: Duration::from_secs(8),
        }
    }
}

impl AgentsSource for CommandAgentsSource {
    fn list(&self) -> io::Result<Vec<AgentEntry>> {
        let mut cmd = Command::new(&self.program);
        cmd.args(["agents", "--json"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (k, _) in std::env::vars_os() {
            if k.to_string_lossy().starts_with("CLAUDE") {
                cmd.env_remove(k);
            }
        }
        let mut child = cmd.spawn()?;
        let mut stdout = child.stdout.take().expect("piped stdout");
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stdout.read_to_string(&mut s);
            s
        });
        let start = Instant::now();
        let status = loop {
            if let Some(st) = child.try_wait()? {
                break st;
            }
            if start.elapsed() > self.timeout {
                let _ = child.kill();
                let _ = child.wait();
                // Do not join: a grandchild may still hold the pipe open.
                drop(reader);
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "claude agents timed out",
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let out = reader.join().unwrap_or_default();
        if !status.success() {
            return Err(io::Error::other(format!(
                "claude agents exited with {status}"
            )));
        }
        parse_agents(&out).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[
      {"pid":101,"cwd":"/w","kind":"interactive","startedAt":1791928000000,"sessionId":"s-1","name":"a","status":"waiting","waitingFor":"permission prompt"},
      {"pid":102,"cwd":"/w","kind":"interactive","startedAt":1,"sessionId":"s-2","status":"waiting","waitingFor":"input needed"},
      {"pid":103,"cwd":"/w","kind":"interactive","sessionId":"s-3","status":"busy"},
      {"pid":104,"cwd":"/w","kind":"interactive","sessionId":"s-4","status":"idle"},
      {"pid":105,"cwd":"/w","kind":"interactive","sessionId":"s-5","status":"waiting","waitingFor":"dialog open"},
      {"pid":106,"status":"weird"}
    ]"#;

    #[test]
    fn maps_every_documented_status() {
        let a = parse_agents(SAMPLE).unwrap();
        assert_eq!(
            a[0].to_status(),
            Some(Status::NeedsYou(NeedsKind::Permission))
        );
        assert_eq!(
            a[1].to_status(),
            Some(Status::NeedsYou(NeedsKind::Question))
        );
        assert_eq!(a[2].to_status(), Some(Status::Busy));
        assert_eq!(a[3].to_status(), Some(Status::Idle));
        assert_eq!(a[4].to_status(), Some(Status::NeedsYou(NeedsKind::Other)));
        assert_eq!(a[5].to_status(), None);
        assert_eq!(a[0].session_id.as_deref(), Some("s-1"));
    }

    #[test]
    fn command_source_times_out_and_kills() {
        let dir = std::env::temp_dir().join(format!("pr-agents-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("slow.sh");
        std::fs::write(&script, "#!/bin/sh\nexec sleep 30\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let src = CommandAgentsSource {
            program: script.to_string_lossy().into_owned(),
            timeout: Duration::from_millis(200),
        };
        let err = src.list().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn command_source_parses_script_output() {
        let dir = std::env::temp_dir().join(format!("pr-agents-ok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\necho '[{\"pid\":1,\"sessionId\":\"x\",\"status\":\"idle\"}]'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let src = CommandAgentsSource {
            program: script.to_string_lossy().into_owned(),
            timeout: Duration::from_secs(5),
        };
        let list = src.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].to_status(), Some(Status::Idle));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
