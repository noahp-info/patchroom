//! Keystroke byte map (spike V3) and bracketed paste framing (spike V8).

use crate::error::{Error, Result};

/// Start of a bracketed paste.
pub const PASTE_START: &[u8] = b"\x1b[200~";
/// End of a bracketed paste.
pub const PASTE_END: &[u8] = b"\x1b[201~";

/// A key the host can send to the child. Arrows use normal-mode CSI bytes,
/// which is what the claude TUI expects (spike V3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// `ESC [ A`
    Up,
    /// `ESC [ B`
    Down,
    /// `ESC [ C`
    Right,
    /// `ESC [ D`
    Left,
    /// `\r` (0x0d). Confirms the highlighted option.
    Enter,
    /// `ESC` (0x1b). Cancels a dialog.
    Esc,
    /// `\t` (0x09). Opens the amend input in a permission dialog.
    Tab,
    /// DEL (0x7f).
    Backspace,
    /// Ctrl+C (0x03).
    CtrlC,
    /// A single digit `0..=9`. In claude dialogs this selects and submits the
    /// numbered option at once.
    Digit(u8),
    /// A literal character, sent as UTF-8.
    Char(char),
}

impl Key {
    /// The bytes written to the PTY for this key.
    ///
    /// # Errors
    /// [`Error::InvalidDigit`] when a [`Key::Digit`] is above 9.
    pub fn bytes(self) -> Result<Vec<u8>> {
        Ok(match self {
            Key::Up => b"\x1b[A".to_vec(),
            Key::Down => b"\x1b[B".to_vec(),
            Key::Right => b"\x1b[C".to_vec(),
            Key::Left => b"\x1b[D".to_vec(),
            Key::Enter => vec![0x0d],
            Key::Esc => vec![0x1b],
            Key::Tab => vec![0x09],
            Key::Backspace => vec![0x7f],
            Key::CtrlC => vec![0x03],
            Key::Digit(d) if d <= 9 => vec![b'0' + d],
            Key::Digit(d) => return Err(Error::InvalidDigit(d)),
            Key::Char(c) => {
                let mut buf = [0u8; 4];
                c.encode_utf8(&mut buf).as_bytes().to_vec()
            }
        })
    }
}

/// Wrap `text` in a bracketed paste. Any embedded paste terminator is removed
/// first so pasted text can never end the paste early and inject keystrokes.
#[must_use]
pub fn bracketed_paste(text: &str) -> Vec<u8> {
    let mut clean = text.to_owned();
    while clean.contains("\x1b[201~") {
        clean = clean.replace("\x1b[201~", "");
    }
    let mut out = Vec::with_capacity(clean.len() + 12);
    out.extend_from_slice(PASTE_START);
    out.extend_from_slice(clean.as_bytes());
    out.extend_from_slice(PASTE_END);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v3_byte_map() {
        assert_eq!(Key::Up.bytes().unwrap(), [0x1b, 0x5b, 0x41]);
        assert_eq!(Key::Down.bytes().unwrap(), [0x1b, 0x5b, 0x42]);
        assert_eq!(Key::Enter.bytes().unwrap(), [0x0d]);
        assert_eq!(Key::Esc.bytes().unwrap(), [0x1b]);
        assert_eq!(Key::Tab.bytes().unwrap(), [0x09]);
        assert_eq!(Key::Digit(4).bytes().unwrap(), b"4");
        assert_eq!(Key::Char('é').bytes().unwrap(), "é".as_bytes());
    }

    #[test]
    fn digit_range_checked() {
        assert!(matches!(
            Key::Digit(10).bytes(),
            Err(Error::InvalidDigit(10))
        ));
    }

    #[test]
    fn paste_frames_text() {
        assert_eq!(bracketed_paste("hi"), b"\x1b[200~hi\x1b[201~");
    }

    #[test]
    fn paste_strips_embedded_terminator() {
        let out = bracketed_paste("a\x1b[201~\rb");
        assert_eq!(out, b"\x1b[200~a\rb\x1b[201~");
        let nested = bracketed_paste("\x1b[2\x1b[201~01~x");
        assert_eq!(nested, b"\x1b[200~x\x1b[201~");
    }
}
