#![allow(dead_code)]
use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use patchroom_pty::{ExitInfo, PtyEvent};

/// Collected result of running a session to exit.
pub struct Run {
    pub output: Vec<u8>,
    pub events: Vec<PtyEvent>,
    pub exit: ExitInfo,
}

impl Run {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.output).into_owned()
    }
}

/// Collect events until `Exit` or timeout.
pub fn run_to_exit(rx: &Receiver<PtyEvent>, timeout: Duration) -> Run {
    let deadline = Instant::now() + timeout;
    let mut output = Vec::new();
    let mut events = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(PtyEvent::Exit(exit)) => {
                events.push(PtyEvent::Exit(exit.clone()));
                return Run {
                    output,
                    events,
                    exit,
                };
            }
            Ok(ev) => {
                if let PtyEvent::Output(b) = &ev {
                    output.extend_from_slice(b);
                }
                events.push(ev);
            }
            Err(e) => panic!(
                "no exit before timeout ({e}); output so far: {:?}",
                String::from_utf8_lossy(&output)
            ),
        }
    }
}

/// Strip CSI/OSC sequences and CRs so TUI text can be searched.
pub fn strip_ansi(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'[' => {
                    i += 2;
                    while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                        i += 1;
                    }
                    i += 1;
                    out.push(b' ');
                    continue;
                }
                b']' => {
                    i += 2;
                    while i < bytes.len()
                        && bytes[i] != 0x07
                        && !(bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\'))
                    {
                        i += 1;
                    }
                    i += if bytes.get(i) == Some(&0x07) { 1 } else { 2 };
                    continue;
                }
                _ => {
                    i += 2;
                    continue;
                }
            }
        }
        if b != b'\r' {
            out.push(b);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
