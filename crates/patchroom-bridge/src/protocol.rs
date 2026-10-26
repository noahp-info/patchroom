//! Wire protocol between `patchroom-hook` and the bridge.
//!
//! Newline-delimited JSON over a unix socket. Every frame is one JSON object on one line
//! and carries the protocol version in `v`. The hook sends exactly one request line and
//! then reads exactly one reply line. After that both sides close.
//!
//! ```text
//! hook   -> bridge  {"v":1,"type":"hook","session_key":"dm-1","hook_pid":42,"ppid":41,"payload":{...}}
//! wrapper -> bridge {"v":1,"type":"statusline","session_key":"dm-1","payload":{...},"output":"..."}
//! bridge -> hook    {"v":1,"type":"ack"}
//! bridge -> hook    {"v":1,"type":"decision","output":{...}|null,"resolution":"chat"}
//! bridge -> hook    {"v":1,"type":"cancel","reason":"terminal"}
//! bridge -> hook    {"v":1,"type":"error","message":"..."}
//! ```
//!
//! `output` is the exact JSON the hook prints on stdout for the CLI. `null` means "no
//! decision": the hook prints nothing and the CLI's own TUI decides.

use std::io::{self, BufRead, Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Current protocol version. Bumped on any incompatible frame change.
pub const PROTOCOL_VERSION: u32 = 1;

/// Largest accepted frame, in bytes. Hook payloads embed tool input, so allow plenty.
pub const MAX_FRAME_BYTES: u64 = 8 * 1024 * 1024;

/// A frame with its version stamp.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Frame<T> {
    /// Protocol version of the sender.
    pub v: u32,
    /// The typed body, flattened next to `v`.
    #[serde(flatten)]
    pub body: T,
}

impl<T> Frame<T> {
    /// Wrap `body` with the current protocol version.
    pub fn new(body: T) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            body,
        }
    }
}

/// Message from the hook binary to the bridge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// One hook invocation.
    Hook {
        /// Patchroom's own key for the session (conversation id), when known.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_key: Option<String>,
        /// Pid of the hook process.
        #[serde(default)]
        hook_pid: u32,
        /// Parent pid of the hook process (usually the CLI).
        #[serde(default)]
        ppid: u32,
        /// How long the hook will wait for a reply, in milliseconds.
        #[serde(default)]
        wait_ms: u64,
        /// The hook JSON exactly as the CLI sent it on stdin.
        payload: Value,
    },
    /// The CLI asked to open a URL (`$BROWSER` points at the hook). The bridge only acks.
    OpenUrl {
        /// Patchroom's own key for the session, when known.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_key: Option<String>,
        /// The URL as the CLI passed it.
        url: String,
    },
    /// One statusLine render. The wrapper tees the statusLine stdin JSON and the output
    /// of the user's own statusLine command. The bridge only acks.
    Statusline {
        /// Patchroom's own key for the session, when known.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_key: Option<String>,
        /// The statusLine stdin JSON exactly as the CLI sent it.
        payload: Value,
        /// What the user's statusLine command printed (ANSI included). Empty when the
        /// user has no statusLine.
        #[serde(default)]
        output: String,
        /// Whether the CLI talks to a local API (its `ANTHROPIC_BASE_URL` is localhost or
        /// 127.0.0.1). `None` when the wrapper did not say.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        api_local: Option<bool>,
    },
}

/// Why a prompt was resolved. Sent to the hook and published as an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolution {
    /// A chat client answered through the bridge.
    Chat,
    /// The user answered in the terminal (TUI) first.
    Terminal,
    /// The bounded wait ran out. The hook released to the TUI.
    Timeout,
    /// No chat client was attached, so the hook released at once.
    NoChat,
    /// The hook process went away before an answer.
    HookGone,
    /// The turn moved on (Stop, UserPromptSubmit, SessionEnd) with the prompt unanswered.
    TurnEnded,
    /// The bridge shut down.
    Shutdown,
}

/// Message from the bridge to the hook binary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Non-blocking event received. The hook exits without output.
    Ack,
    /// Final answer. `output: None` means no decision.
    Decision {
        /// JSON for the CLI, or `None` for no decision.
        output: Option<Value>,
        /// What produced this reply.
        resolution: Resolution,
    },
    /// The prompt was answered elsewhere. The hook exits without output.
    Cancel {
        /// What produced the cancel.
        reason: Resolution,
    },
    /// The request was refused (bad version, malformed frame).
    Error {
        /// Human-readable reason.
        message: String,
    },
}

/// Write one frame as a single line.
pub fn write_frame<W: Write, T: Serialize>(w: &mut W, body: &T) -> io::Result<()> {
    let frame = Frame::new(body);
    let mut line = serde_json::to_vec(&frame).map_err(io::Error::other)?;
    line.push(b'\n');
    w.write_all(&line)?;
    w.flush()
}

/// Read one line (up to [`MAX_FRAME_BYTES`]). Returns `Ok(None)` on a clean EOF.
pub fn read_line<R: BufRead>(r: &mut R) -> io::Result<Option<String>> {
    let mut buf = Vec::new();
    let n = r
        .by_ref()
        .take(MAX_FRAME_BYTES)
        .read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.last() != Some(&b'\n') && n as u64 >= MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame exceeds maximum size",
        ));
    }
    String::from_utf8(buf)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Parse a request line. Checks the version before the body.
pub fn parse_client_line(line: &str) -> Result<ClientMessage, String> {
    let value: Value = serde_json::from_str(line.trim()).map_err(|e| format!("bad json: {e}"))?;
    let v = value.get("v").and_then(Value::as_u64);
    if v != Some(u64::from(PROTOCOL_VERSION)) {
        return Err(format!(
            "unsupported protocol version {v:?}, expected {PROTOCOL_VERSION}"
        ));
    }
    serde_json::from_value::<Frame<ClientMessage>>(value)
        .map(|f| f.body)
        .map_err(|e| format!("bad frame: {e}"))
}

/// Parse a reply line.
pub fn parse_server_line(line: &str) -> Result<ServerMessage, String> {
    let frame: Frame<ServerMessage> =
        serde_json::from_str(line.trim()).map_err(|e| format!("bad reply: {e}"))?;
    if frame.v != PROTOCOL_VERSION {
        return Err(format!("unsupported protocol version {}", frame.v));
    }
    Ok(frame.body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_round_trips_with_version() {
        let msg = ClientMessage::Hook {
            session_key: Some("dm-1".into()),
            hook_pid: 7,
            ppid: 6,
            wait_ms: 1000,
            payload: json!({"hook_event_name": "Stop"}),
        };
        let mut out = Vec::new();
        write_frame(&mut out, &msg).unwrap();
        let line = String::from_utf8(out).unwrap();
        assert!(line.ends_with('\n'));
        assert!(line.contains("\"v\":1"));
        assert!(line.contains("\"type\":\"hook\""));
        assert_eq!(parse_client_line(&line).unwrap(), msg);
    }

    #[test]
    fn wrong_version_is_refused() {
        let err = parse_client_line(r#"{"v":2,"type":"hook","payload":{}}"#).unwrap_err();
        assert!(err.contains("unsupported protocol version"), "{err}");
        let err = parse_client_line(r#"{"type":"hook","payload":{}}"#).unwrap_err();
        assert!(err.contains("unsupported protocol version"), "{err}");
    }

    #[test]
    fn reply_shapes_are_stable() {
        let mut out = Vec::new();
        write_frame(
            &mut out,
            &ServerMessage::Decision {
                output: None,
                resolution: Resolution::Timeout,
            },
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "{\"v\":1,\"type\":\"decision\",\"output\":null,\"resolution\":\"timeout\"}\n"
        );
        let cancel = parse_server_line(r#"{"v":1,"type":"cancel","reason":"terminal"}"#).unwrap();
        assert_eq!(
            cancel,
            ServerMessage::Cancel {
                reason: Resolution::Terminal
            }
        );
    }

    #[test]
    fn oversized_or_eof_lines_are_handled() {
        let mut empty: &[u8] = b"";
        assert!(read_line(&mut empty).unwrap().is_none());
        let mut one: &[u8] = b"{}\nrest";
        assert_eq!(read_line(&mut one).unwrap().unwrap(), "{}\n");
    }
}
