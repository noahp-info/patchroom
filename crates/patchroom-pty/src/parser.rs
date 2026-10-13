//! Incremental escape-sequence scanner.
//!
//! The scanner only observes the stream. It never rewrites bytes: callers
//! forward the original chunk to the terminal and use the scanner's output as
//! side-channel typed events.

use crate::event::{ProgressState, TerminalQuery, TitleKind};

/// Something the scanner recognised in the stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scanned {
    /// OSC 0, 1 or 2.
    Title {
        /// Which title was set.
        kind: TitleKind,
        /// The title text.
        text: String,
    },
    /// OSC 9 with a message (iTerm2 growl notification).
    Notification(String),
    /// OSC 9;4 progress.
    Progress {
        /// Progress state.
        state: ProgressState,
        /// Percent complete, when the state carries one.
        value: Option<u8>,
    },
    /// A query the terminal is expected to answer.
    Query(TerminalQuery),
}

/// Cap on a buffered OSC payload. Longer payloads are discarded.
const MAX_OSC: usize = 8192;
/// Cap on a buffered CSI parameter string.
const MAX_CSI: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Ground,
    Esc,
    Csi(Vec<u8>),
    Osc {
        buf: Vec<u8>,
        overflow: bool,
    },
    OscEsc {
        buf: Vec<u8>,
        overflow: bool,
    },
    /// DCS, APC, PM, SOS strings: skipped until ST.
    Str,
    StrEsc,
}

/// Stateful scanner. Safe to feed in arbitrary chunk sizes.
#[derive(Debug)]
pub struct Scanner {
    state: State,
}

impl Default for Scanner {
    fn default() -> Self {
        Self::new()
    }
}

impl Scanner {
    /// A fresh scanner in the ground state.
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: State::Ground,
        }
    }

    /// Scan `chunk`, appending recognised items to `out`.
    pub fn feed(&mut self, chunk: &[u8], out: &mut Vec<Scanned>) {
        for &b in chunk {
            let state = std::mem::replace(&mut self.state, State::Ground);
            self.state = self.step(state, b, out);
        }
    }

    fn step(&mut self, state: State, b: u8, out: &mut Vec<Scanned>) -> State {
        match state {
            State::Ground => match b {
                0x1b => State::Esc,
                _ => State::Ground,
            },
            State::Esc => match b {
                b'[' => State::Csi(Vec::new()),
                b']' => State::Osc {
                    buf: Vec::new(),
                    overflow: false,
                },
                b'P' | b'_' | b'^' | b'X' => State::Str,
                0x1b => State::Esc,
                _ => State::Ground,
            },
            State::Csi(mut params) => match b {
                0x20..=0x3f => {
                    if params.len() < MAX_CSI {
                        params.push(b);
                        State::Csi(params)
                    } else {
                        State::Ground
                    }
                }
                0x40..=0x7e => {
                    match (b, params.as_slice()) {
                        (b'c', b"" | b"0") => {
                            out.push(Scanned::Query(TerminalQuery::PrimaryDeviceAttributes))
                        }
                        (b'q', b">" | b">0") => out.push(Scanned::Query(TerminalQuery::XtVersion)),
                        _ => {}
                    }
                    State::Ground
                }
                0x1b => State::Esc,
                // CAN / SUB abort the sequence.
                _ => State::Ground,
            },
            State::Osc { mut buf, overflow } => match b {
                0x07 => {
                    if !overflow {
                        finish_osc(&buf, out);
                    }
                    State::Ground
                }
                0x1b => State::OscEsc { buf, overflow },
                0x18 | 0x1a => State::Ground,
                _ => {
                    if !overflow {
                        if buf.len() < MAX_OSC {
                            buf.push(b);
                        } else {
                            return State::Osc {
                                buf: Vec::new(),
                                overflow: true,
                            };
                        }
                    }
                    State::Osc { buf, overflow }
                }
            },
            State::OscEsc { buf, overflow } => match b {
                b'\\' => {
                    if !overflow {
                        finish_osc(&buf, out);
                    }
                    State::Ground
                }
                // ESC followed by anything else aborts the OSC and starts a
                // new escape sequence.
                _ => self.step(State::Esc, b, out),
            },
            State::Str => match b {
                0x1b => State::StrEsc,
                0x07 => State::Ground,
                _ => State::Str,
            },
            State::StrEsc => match b {
                b'\\' => State::Ground,
                _ => self.step(State::Esc, b, out),
            },
        }
    }
}

fn finish_osc(buf: &[u8], out: &mut Vec<Scanned>) {
    let text = String::from_utf8_lossy(buf);
    let (code, rest) = match text.split_once(';') {
        Some((c, r)) => (c, r),
        None => (&*text, ""),
    };
    match code {
        "0" | "1" | "2" => {
            let kind = match code {
                "0" => TitleKind::IconAndWindow,
                "1" => TitleKind::Icon,
                _ => TitleKind::Window,
            };
            out.push(Scanned::Title {
                kind,
                text: rest.to_owned(),
            });
        }
        "9" => {
            if let Some(progress) = parse_progress(rest) {
                out.push(progress);
            } else {
                out.push(Scanned::Notification(rest.to_owned()));
            }
        }
        _ => {}
    }
}

/// `4;<state>[;<value>]` after `9;`. Returns `None` when the payload is not a
/// well-formed progress report, so a notification that merely starts with "4;"
/// stays a notification.
fn parse_progress(rest: &str) -> Option<Scanned> {
    let args = rest
        .strip_prefix("4;")
        .or_else(|| (rest == "4").then_some(""))?;
    let mut parts = args.split(';');
    let state_raw = parts.next().unwrap_or("");
    let state = match state_raw {
        "0" => ProgressState::Hidden,
        "1" => ProgressState::Normal,
        "2" => ProgressState::Error,
        "3" => ProgressState::Indeterminate,
        "4" => ProgressState::Paused,
        _ => return None,
    };
    let value = match parts.next() {
        None | Some("") => None,
        Some(v) => Some(v.parse::<u16>().ok()?.min(100) as u8),
    };
    if parts.next().is_some() {
        return None;
    }
    Some(Scanned::Progress { state, value })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(bytes: &[u8]) -> Vec<Scanned> {
        let mut s = Scanner::new();
        let mut out = Vec::new();
        s.feed(bytes, &mut out);
        out
    }

    fn scan_bytewise(bytes: &[u8]) -> Vec<Scanned> {
        let mut s = Scanner::new();
        let mut out = Vec::new();
        for b in bytes {
            s.feed(std::slice::from_ref(b), &mut out);
        }
        out
    }

    const SAMPLE: &[u8] = b"hello\x1b]0;\xe2\x9c\xb3 Claude Code\x07mid\x1b]2;win\x1b\\\
\x1b]1;ico\x07\x1b]9;Claude needs your permission\x07\x1b]9;4;3\x07\x1b]9;4;1;42\x07\
\x1b]9;4;0\x07\x1b[c\x1b[>0q\x1b[0c\x1b]7501;?\x07\x1b_Gi=1;OK\x1b\\tail";

    #[test]
    fn recognises_claude_sequences() {
        let got = scan(SAMPLE);
        assert_eq!(
            got,
            vec![
                Scanned::Title {
                    kind: TitleKind::IconAndWindow,
                    text: "\u{2733} Claude Code".into()
                },
                Scanned::Title {
                    kind: TitleKind::Window,
                    text: "win".into()
                },
                Scanned::Title {
                    kind: TitleKind::Icon,
                    text: "ico".into()
                },
                Scanned::Notification("Claude needs your permission".into()),
                Scanned::Progress {
                    state: ProgressState::Indeterminate,
                    value: None
                },
                Scanned::Progress {
                    state: ProgressState::Normal,
                    value: Some(42)
                },
                Scanned::Progress {
                    state: ProgressState::Hidden,
                    value: None
                },
                Scanned::Query(TerminalQuery::PrimaryDeviceAttributes),
                Scanned::Query(TerminalQuery::XtVersion),
                Scanned::Query(TerminalQuery::PrimaryDeviceAttributes),
            ]
        );
    }

    #[test]
    fn chunking_does_not_change_result() {
        assert_eq!(scan(SAMPLE), scan_bytewise(SAMPLE));
        for split in 0..SAMPLE.len() {
            let mut s = Scanner::new();
            let mut out = Vec::new();
            s.feed(&SAMPLE[..split], &mut out);
            s.feed(&SAMPLE[split..], &mut out);
            assert_eq!(out, scan(SAMPLE), "split at {split}");
        }
    }

    #[test]
    fn plain_text_and_other_csi_are_ignored() {
        assert!(scan(b"plain \x1b[31mred\x1b[0m \x1b[2J\x1b[?1004h text").is_empty());
    }

    #[test]
    fn progress_value_clamped_and_malformed_falls_back() {
        assert_eq!(
            scan(b"\x1b]9;4;1;250\x07"),
            vec![Scanned::Progress {
                state: ProgressState::Normal,
                value: Some(100)
            }]
        );
        assert_eq!(
            scan(b"\x1b]9;4;x\x07"),
            vec![Scanned::Notification("4;x".into())]
        );
    }

    #[test]
    fn oversized_osc_is_dropped_and_scanner_recovers() {
        let mut data = b"\x1b]0;".to_vec();
        data.extend(std::iter::repeat_n(b'a', MAX_OSC * 2));
        data.push(0x07);
        data.extend_from_slice(b"\x1b]0;ok\x07");
        assert_eq!(
            scan(&data),
            vec![Scanned::Title {
                kind: TitleKind::IconAndWindow,
                text: "ok".into()
            }]
        );
    }

    #[test]
    fn esc_inside_osc_restarts() {
        assert_eq!(
            scan(b"\x1b]0;abc\x1b[c"),
            vec![Scanned::Query(TerminalQuery::PrimaryDeviceAttributes)]
        );
    }
}
